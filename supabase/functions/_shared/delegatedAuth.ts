// supabase/functions/_shared/delegatedAuth.ts
//
// Admission for a delegated (agent grant) request to log-event: row 4a,
// docs/plans/row4-owner-append.md §4a. Pure apart from hashing.
//
// TWO CREDENTIALS, KEPT APART
// `Authorization: Bearer <public anon key>` is transport only: it gets the
// request through the gateway (log-event is verify_jwt: true) and is never
// owner authentication. The grant travels in `x-trustflow-grant` as
// `<credential_id>.<secret>`, and only the SHA-256 of the secret leaves this
// module. The database decides everything else under its locks.
//
// A PRESENT HEADER COMMITS THE ROUTE
// Once `x-trustflow-grant` is present at all (blank, malformed, repeated or
// comma-joined), the request is delegated and never falls back to the owner or
// guest route. Every refusal from here is the same public answer; the reason
// goes only to a redacted log line.

export const GRANT_HEADER = 'x-trustflow-grant'

// Row 1's issue format: a lowercase UUID, one dot, 64 lowercase hex characters.
const GRANT_FORMAT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/
const GRANT_LENGTH = 36 + 1 + 64

export type DelegatedAdmission =
  | { delegated: false }
  | { delegated: true, ok: false, reason: 'malformed_grant' | 'mixed_credentials' }
  | { delegated: true, ok: true, credentialId: string, secretHash: string }

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether this request is delegated, and if so whether its credentials are
 * admissible as a pair. `anonKey` is the project's public anon key; an empty
 * value admits nothing, so a misconfigured function fails closed.
 *
 * Repeated headers reach `Headers.get` joined with ", ", so a repeated grant is
 * refused by the same rule as a comma-joined one: the format has no comma.
 */
export async function delegatedAdmission(headers: Headers, anonKey: string): Promise<DelegatedAdmission> {
  const raw = headers.get(GRANT_HEADER)
  if (raw === null) return { delegated: false }
  // Capped before any parsing.
  if (raw.length !== GRANT_LENGTH) return { delegated: true, ok: false, reason: 'malformed_grant' }
  const m = GRANT_FORMAT.exec(raw)
  if (!m) return { delegated: true, ok: false, reason: 'malformed_grant' }
  if (headers.get('x-guest-access-token') !== null) {
    return { delegated: true, ok: false, reason: 'mixed_credentials' }
  }
  // The bearer must be exactly the public anon key. A user JWT, any other
  // bearer, or none at all makes the request mixed.
  if (!anonKey || headers.get('authorization') !== `Bearer ${anonKey}`) {
    return { delegated: true, ok: false, reason: 'mixed_credentials' }
  }
  return { delegated: true, ok: true, credentialId: m[1], secretHash: await sha256Hex(m[2]) }
}

/**
 * The internal refusal reasons and how log-event answers each. Authorization
 * refusals are one uniform 403 so the response reveals nothing about a grant;
 * the gate states are operational, a 503.
 */
export const DELEGATION_REFUSED = { error: 'delegation_refused', status: 403 } as const
export const DELEGATED_UNAVAILABLE = { error: 'delegated_append_unavailable', status: 503 } as const

const AUTHORIZATION_REFUSALS = new Set([
  'malformed', 'grant_unknown', 'secret_mismatch', 'issuer_kind', 'issuer_not_owner',
  'revoked', 'expired', 'scope', 'allowlist',
])
const GATE_STATES = new Set(['gate_closed', 'gate_missing'])

export function refusalAnswer(status: string): { error: string, status: number } | null {
  if (AUTHORIZATION_REFUSALS.has(status)) return DELEGATION_REFUSED
  if (GATE_STATES.has(status)) return DELEGATED_UNAVAILABLE
  return null
}
