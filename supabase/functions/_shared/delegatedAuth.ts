// supabase/functions/_shared/delegatedAuth.ts
//
// Admission for a delegated (agent grant) request: row 4a
// (docs/plans/row4-owner-append.md §4a) for log-event, and row 5b for
// delegated-owner-read. Pure apart from hashing.
//
// TWO CREDENTIALS, KEPT APART
// `apikey: <publishable key>` is transport only: it says the caller holds one
// of this project's active public keys and is never owner authentication. The
// grant travels in `x-trustflow-grant` as `<credential_id>.<secret>`, and only
// the SHA-256 of the secret leaves this module. The database decides
// everything else under its locks.
//
// WHY `apikey` AND NOT A BEARER (T256, T257, Codex T207)
// The platform injects the new `sb_publishable_` key as SUPABASE_ANON_KEY,
// while legacy clients sent the old anon JWT as a bearer, so an exact bearer
// comparison could never match on hosted E2E. The new keys are not JWTs and
// belong in `apikey`; `Authorization` is for user JWTs. So a delegated request
// carries NO Authorization header at all: any value there (a user session, a
// legacy anon JWT, a key sent as a bearer) is a mixed credential. The legacy
// anon JWT is deliberately not accepted in any form.
//
// THE ALLOWLIST
// Only the string values of SUPABASE_PUBLISHABLE_KEYS that are exactly one
// publishable-key token (PUBLISHABLE_TOKEN: no whitespace, comma or other
// separator, so no configured value can equal a merged or padded request
// value; Codex T208). SUPABASE_ANON_KEY is not read (its content differs by environment, and
// on some it is a legacy JWT), and nothing is ever taken from a secret or
// service-role variable. A missing, malformed or empty configuration admits
// nothing. A key removed from the project disappears from the platform's list
// and so from this one.
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
// One publishable key: the prefix and a non-empty run of URL-safe characters.
// Anything else (whitespace, a comma from a merged repeated header, quotes) is
// not a key, in the configuration or in a request.
export const PUBLISHABLE_TOKEN = /^sb_publishable_[A-Za-z0-9_-]+$/

export type DelegatedAdmission =
  | { delegated: false }
  | { delegated: true, ok: false, reason: 'malformed_grant' | 'mixed_credentials' | 'public_key' }
  | { delegated: true, ok: true, credentialId: string, secretHash: string }

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The publishable keys this function accepts as transport, from the platform's
 * SUPABASE_PUBLISHABLE_KEYS (a JSON object of name -> key). Anything else
 * (unset, not JSON, not an object, a non-string value, a value that is not a
 * publishable key) contributes nothing, so a bad configuration fails closed.
 */
export function publishableKeys(raw: string | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const keys = Object.values(parsed as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string' && PUBLISHABLE_TOKEN.test(v))
  return [...new Set(keys)]
}

// Equality without an early exit on the first differing character. The keys
// are public, so this is hygiene rather than secrecy.
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Whether this request is delegated, and if so whether its credentials are
 * admissible as a pair. `publicKeys` is the allowlist from publishableKeys();
 * an empty list admits nothing.
 *
 * Repeated headers reach `Headers.get` joined with ", ", so a repeated grant or
 * apikey is refused by the same rule as a comma-joined one: neither token
 * grammar admits a comma or a space. `publicKeys` entries that are not one
 * token are ignored as well, so a direct caller cannot reopen that path.
 */
export async function delegatedAdmission(headers: Headers, publicKeys: readonly string[]): Promise<DelegatedAdmission> {
  const raw = headers.get(GRANT_HEADER)
  if (raw === null) return { delegated: false }
  // Capped before any parsing.
  if (raw.length !== GRANT_LENGTH) return { delegated: true, ok: false, reason: 'malformed_grant' }
  const m = GRANT_FORMAT.exec(raw)
  if (!m) return { delegated: true, ok: false, reason: 'malformed_grant' }
  if (headers.get('x-guest-access-token') !== null) {
    return { delegated: true, ok: false, reason: 'mixed_credentials' }
  }
  // No bearer of any kind: a user JWT, a legacy anon JWT or a key sent as a
  // bearer all make the request mixed. An empty header counts as present.
  if (headers.get('authorization') !== null) {
    return { delegated: true, ok: false, reason: 'mixed_credentials' }
  }
  // The request value must itself be one token before any comparison: a
  // repeated apikey arrives comma-joined and is refused here, whatever the list.
  const apikey = headers.get('apikey')
  if (apikey === null || !PUBLISHABLE_TOKEN.test(apikey)
      || !publicKeys.some(k => PUBLISHABLE_TOKEN.test(k) && sameText(apikey, k))) {
    return { delegated: true, ok: false, reason: 'public_key' }
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
