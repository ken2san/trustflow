// src/lib/entryCredentials.js
//
// Client boundary for Row 6 (minimal owner credential UI) against the
// `manage-entry-agent-credential` Edge Function.
//
// SECURITY INVARIANTS
// - Owner-account grants only (`issuer_kind: 'owner_account'`). Counterpart
//   issuance belongs to Row 10 and is never sent from this module.
// - Never sends `accept` (forbidden for owner_account by table CHECK and RPC),
//   `issuer_id`, `secret_hash`, or `invite`.
// - Technical expiry cap: strictly inside (now, now + 30 days], matching
//   `supabase/functions/manage-entry-agent-credential/index.ts` and
//   `20261118214020_entry_agent_credentials.sql`.
// - Fail-closed on `issuance_disabled` (503), malformed responses, or
//   cross-contract mismatches. Never fabricates a secret or persists one to
//   storage or logs.

import { supabase, invokeErrorReason } from './supabase.js'

const FUNCTION_NAME = 'manage-entry-agent-credential'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SECRET_HEX_RE = /^[0-9a-f]{64}$/
export const MAX_GRANT_DAYS = 30
export const MAX_GRANT_MS = MAX_GRANT_DAYS * 24 * 60 * 60 * 1000
// Subtract a small buffer when computing the 30-day preset so minor client/server
// clock skew does not trip the server's `<= now + 30 days` cap.
export const MAX_PRESET_SKEW_MS = 60 * 1000

/**
 * The 7 scopes an `owner_account` grant may carry (docs/entry-contract.md §2-3).
 * `accept` is counterpart-only and is deliberately absent.
 */
export const OWNER_SCOPES = Object.freeze([
  { id: 'read', label: 'Read deal & receipt', roleHint: 'either' },
  { id: 'performance.asserted', label: 'Mark delivered', roleHint: 'performer' },
  { id: 'performance.accepted', label: 'Accept delivery', roleHint: 'receiver' },
  { id: 'performance.rejected', label: 'Request correction', roleHint: 'receiver' },
  { id: 'payment.reported', label: 'Report payment sent', roleHint: 'receiver' },
  { id: 'payment.acknowledged', label: 'Confirm payment received', roleHint: 'performer' },
  { id: 'payment.disputed', label: 'Report payment not received', roleHint: 'performer' },
])

export const OWNER_SCOPE_SET = new Set(OWNER_SCOPES.map(s => s.id))

export const EXPIRY_PRESETS = Object.freeze([
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days (max)', ms: MAX_GRANT_MS - MAX_PRESET_SKEW_MS },
])

/**
 * Validate and deduplicate owner scopes. Rejects empty lists, unknown scopes,
 * non-strings, and `accept`.
 *
 * @returns {{ ok: true, scopes: string[] } | { ok: false, reason: string }}
 */
export function validateOwnerScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, reason: 'scopes_required' }
  }
  const seen = new Set()
  const cleaned = []
  for (const s of scopes) {
    if (typeof s !== 'string' || !OWNER_SCOPE_SET.has(s)) {
      return { ok: false, reason: 'invalid_scope' }
    }
    if (seen.has(s)) {
      return { ok: false, reason: 'duplicate_scope' }
    }
    seen.add(s)
    cleaned.push(s)
  }
  return { ok: true, scopes: cleaned }
}

/**
 * Compute a canonical UTC ISO expiry string from a duration in milliseconds,
 * enforcing the strict (0, 30 days] cap.
 *
 * @returns {{ ok: true, expiresAt: string } | { ok: false, reason: string }}
 */
export function computeExpiryIso(durationMs, nowMs = Date.now()) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, reason: 'expiry_too_short' }
  }
  if (durationMs > MAX_GRANT_MS) {
    return { ok: false, reason: 'expiry_exceeds_cap' }
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'invalid_expiry' }
  }
  return { ok: true, expiresAt: new Date(nowMs + durationMs).toISOString() }
}

/**
 * Validate a caller-provided ISO expiry string against (now, now + 30 days].
 *
 * @returns {{ ok: true, expiresAt: string } | { ok: false, reason: string }}
 */
export function validateExpiryIso(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'invalid_expiry' }
  }
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return { ok: false, reason: 'invalid_expiry' }
  if (at <= nowMs) return { ok: false, reason: 'expiry_in_past' }
  if (at > nowMs + MAX_GRANT_MS) return { ok: false, reason: 'expiry_exceeds_cap' }
  return { ok: true, expiresAt: new Date(at).toISOString() }
}

/**
 * Format the one-time presented grant token `<grant_id>.<64 hex>` expected by
 * `x-trustflow-grant` (`supabase/functions/_shared/delegatedAuth.ts`).
 * Returns null if either half is malformed.
 */
export function formatGrantToken(grantId, secret) {
  if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) return null
  if (typeof secret !== 'string' || !SECRET_HEX_RE.test(secret)) return null
  return `${grantId}.${secret}`
}

/**
 * Derive a display status for a grant row. Never claims a grant is live once
 * revoked or past `expires_at`.
 *
 * @returns {'revoked' | 'expired' | 'active'}
 */
export function grantStatus(grant, nowMs = Date.now()) {
  if (grant?.revoked_at) return 'revoked'
  const exp = Date.parse(grant?.expires_at ?? '')
  if (!Number.isFinite(exp) || exp <= nowMs) return 'expired'
  return 'active'
}

/**
 * Verify a returned grant metadata object belongs to the requested deal and
 * carries the expected non-secret shape.
 */
export function isGrantForContract(grant, contractId) {
  if (!grant || typeof grant !== 'object') return false
  if (typeof grant.id !== 'string' || !UUID_RE.test(grant.id)) return false
  if (grant.contract_id !== contractId) return false
  if (grant.issuer_kind !== 'owner_account') return false
  if (!Array.isArray(grant.scopes) || !grant.scopes.every(s => typeof s === 'string')) return false
  if (typeof grant.expires_at !== 'string') return false
  if (grant.revoked_at !== null && grant.revoked_at !== undefined && typeof grant.revoked_at !== 'string') {
    return false
  }
  return true
}

/** Human-readable, fixed-text error wording (never echoes raw secrets or server internals). */
export function credentialErrorMessage(reason) {
  switch (reason) {
    case 'issuance_disabled':
      return 'Agent credential issuance is currently disabled on this server.'
    case 'not_authorized':
      return 'You are not authorized to manage credentials for this agreement.'
    case 'invalid_grant':
      return 'The selected scopes or expiry were rejected by the server.'
    case 'scopes_required':
      return 'Select at least one permission scope.'
    case 'invalid_scope':
    case 'duplicate_scope':
      return 'One or more selected scopes are not allowed for an owner grant.'
    case 'expiry_exceeds_cap':
      return `Expiry cannot exceed ${MAX_GRANT_DAYS} days.`
    case 'expiry_too_short':
    case 'expiry_in_past':
    case 'invalid_expiry':
      return `Choose an expiry between now and ${MAX_GRANT_DAYS} days from now.`
    case 'invalid_contract':
    case 'invalid_grant_id':
    case 'invalid_body':
      return 'Invalid agreement or credential identifier.'
    case 'invalid_response':
      return 'The server returned an unexpected response. Nothing was shown.'
    case 'unavailable':
      return 'Credential management requires a connected backend.'
    default:
      return 'That credential request could not be completed. Try again in a moment.'
  }
}

/**
 * List the signed-in issuer's credentials for one deal.
 * Fail-closed: rejects invalid contract IDs, non-array payloads, or rows
 * belonging to another contract.
 *
 * @returns {Promise<{ grants: Array|null, reason: string|null }>}
 */
export async function listOwnerCredentials(contractId) {
  if (typeof contractId !== 'string' || !UUID_RE.test(contractId)) {
    return { grants: null, reason: 'invalid_contract' }
  }
  if (!supabase) return { grants: null, reason: 'unavailable' }

  let result
  try {
    result = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { action: 'list', contract_id: contractId },
    })
  } catch {
    return { grants: null, reason: 'error' }
  }
  const reason = await invokeErrorReason(result)
  if (reason) return { grants: null, reason }

  const raw = result?.data?.grants
  if (!Array.isArray(raw)) return { grants: null, reason: 'invalid_response' }
  if (raw.some(g => !isGrantForContract(g, contractId))) {
    return { grants: null, reason: 'invalid_response' }
  }
  return { grants: raw, reason: null }
}

/**
 * Issue a scoped, finite-expiry `owner_account` credential for one deal.
 * Returns the one-time presented token `<grant.id>.<secret>` in memory only.
 * Never persists or logs the secret.
 *
 * @returns {Promise<{ grant: object|null, token: string|null, reason: string|null }>}
 */
export async function issueOwnerCredential({ contractId, scopes, expiresAt, nowMs = Date.now() }) {
  if (typeof contractId !== 'string' || !UUID_RE.test(contractId)) {
    return { grant: null, token: null, reason: 'invalid_contract' }
  }
  const checkedScopes = validateOwnerScopes(scopes)
  if (!checkedScopes.ok) return { grant: null, token: null, reason: checkedScopes.reason }

  const checkedExpiry = validateExpiryIso(expiresAt, nowMs)
  if (!checkedExpiry.ok) return { grant: null, token: null, reason: checkedExpiry.reason }

  if (!supabase) return { grant: null, token: null, reason: 'unavailable' }

  let result
  try {
    result = await supabase.functions.invoke(FUNCTION_NAME, {
      body: {
        action: 'issue',
        contract_id: contractId,
        issuer_kind: 'owner_account',
        scopes: checkedScopes.scopes,
        expires_at: checkedExpiry.expiresAt,
      },
    })
  } catch {
    return { grant: null, token: null, reason: 'error' }
  }
  const reason = await invokeErrorReason(result)
  if (reason) return { grant: null, token: null, reason }

  const grant = result?.data?.grant
  const secret = result?.data?.secret
  if (!grant || grant.status !== 'issued' || grant.issuer_kind !== 'owner_account'
      || !isGrantForContract(grant, contractId)) {
    return { grant: null, token: null, reason: 'invalid_response' }
  }
  const token = formatGrantToken(grant.id, secret)
  if (!token) return { grant: null, token: null, reason: 'invalid_response' }

  return { grant, token, reason: null }
}

/**
 * Revoke one of the signed-in issuer's credentials on one deal.
 *
 * @returns {Promise<{ revoked: boolean, reason: string|null }>}
 */
export async function revokeOwnerCredential({ contractId, grantId }) {
  if (typeof contractId !== 'string' || !UUID_RE.test(contractId)) {
    return { revoked: false, reason: 'invalid_contract' }
  }
  if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) {
    return { revoked: false, reason: 'invalid_grant_id' }
  }
  if (!supabase) return { revoked: false, reason: 'unavailable' }

  let result
  try {
    result = await supabase.functions.invoke(FUNCTION_NAME, {
      body: {
        action: 'revoke',
        contract_id: contractId,
        id: grantId,
      },
    })
  } catch {
    return { revoked: false, reason: 'error' }
  }
  const reason = await invokeErrorReason(result)
  if (reason) return { revoked: false, reason }
  if (result?.data?.status !== 'revoked') {
    return { revoked: false, reason: 'invalid_response' }
  }
  return { revoked: true, reason: null }
}
