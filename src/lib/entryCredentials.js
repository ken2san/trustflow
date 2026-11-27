// src/lib/entryCredentials.js
//
// Client boundary for Row 6 (minimal owner credential UI) against the
// `manage-entry-agent-credential` Edge Function.
//
// SECURITY INVARIANTS
// - Default-off UI exposure: `isOwnerCredentialsUiEnabled()` is false unless
//   `VITE_OWNER_CREDENTIALS_UI === 'on'`, keeping the panel unmounted and
//   preventing calls until backend rollout is separately approved.
// - Owner-account grants only (`issuer_kind: 'owner_account'`). Counterpart
//   issuance belongs to Row 10 and is never sent from this module.
// - Never sends `accept` (forbidden for owner_account by table CHECK and RPC),
//   `issuer_id`, `secret_hash`, or `invite`.
// - Technical expiry cap: strictly inside (now, now + 30 days], matching
//   `supabase/functions/manage-entry-agent-credential/index.ts` and
//   `20261118214020_entry_agent_credentials.sql`.
// - Lowercase token grammar: `<lowercase-uuid>.<64 lowercase hex>` (101 chars),
//   matching `supabase/functions/_shared/delegatedAuth.ts` (`GRANT_FORMAT`) and
//   `scripts/lib/delegatedClient.mjs` (`GRANT_TOKEN`).
// - Fail-closed on `issuance_disabled` (503), malformed responses, or
//   cross-contract/cross-kind mismatches. Never fabricates a secret or persists
//   one to storage or logs.
// - Unseen issued grants: if an in-flight `issue` completes after sign-out,
//   user-id change, or deal switch, the secret is discarded without display and
//   NO automatic destructive revoke/cleanup is issued. The owner can inspect
//   and revoke any unseen grant from the agreement's credential list.

import { supabase, invokeErrorReason } from './supabase.js'

const FUNCTION_NAME = 'manage-entry-agent-credential'

// Strict lowercase UUID and 64-hex secret, matching `_shared/delegatedAuth.ts`.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const SECRET_HEX_RE = /^[0-9a-f]{64}$/
export const GRANT_TOKEN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/
export const MAX_GRANT_DAYS = 30
export const MAX_GRANT_MS = MAX_GRANT_DAYS * 24 * 60 * 60 * 1000
// Subtract a small buffer when computing the 30-day preset so minor client/server
// clock skew does not trip the server's `<= now + 30 days` cap.
export const MAX_PRESET_SKEW_MS = 60 * 1000

/**
 * Default-off gate for Row 6 UI exposure until backend rollout is separately
 * approved. Only exact `'on'` enables the owner credential panel.
 */
export function isOwnerCredentialsUiEnabled(env = import.meta.env) {
  return env?.VITE_OWNER_CREDENTIALS_UI === 'on'
}

/**
 * Single fail-closed predicate deciding whether the owner credential UI may
 * mount for the current view and session.
 */
export function canShowOwnerCredentials({
  uiEnabled = isOwnerCredentialsUiEnabled(),
  agreementSource,
  authStatus,
  authUserId,
  contract,
} = {}) {
  return uiEnabled === true
    && agreementSource === 'owner'
    && authStatus === 'signed_in'
    && typeof authUserId === 'string' && authUserId.length > 0
    && typeof contract?.id === 'string' && UUID_RE.test(contract.id)
    && contract.earner_user_id === authUserId
}

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
 * Format the one-time presented grant token `<lowercase-uuid>.<64 hex>` expected
 * by `x-trustflow-grant` (`supabase/functions/_shared/delegatedAuth.ts`).
 * Returns null if either half is malformed or uppercase.
 */
export function formatGrantToken(grantId, secret) {
  if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) return null
  if (typeof secret !== 'string' || !SECRET_HEX_RE.test(secret)) return null
  const token = `${grantId}.${secret}`
  return GRANT_TOKEN_RE.test(token) ? token : null
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
 * Verify a returned grant metadata object belongs to the requested deal, is an
 * `owner_account` grant, and carries the expected non-secret shape.
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
 * List the signed-in issuer's `owner_account` credentials for one deal.
 * Fail-closed: rejects invalid contract IDs, non-array payloads, or rows
 * belonging to another contract or non-owner issuer kind.
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
 * Returns the one-time presented token `<lowercase-uuid>.<64 hex>` in memory
 * only. Never persists or logs the secret.
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
  if (!grant || grant.status !== 'issued' || !isGrantForContract(grant, contractId)) {
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

/**
 * Pure, session-scoped controller for `AgentCredentialsPanel`.
 *
 * Guarantees:
 * - Any `SIGNED_OUT` event, user-id change (including cross-tab), deal switch,
 *   or unmount calls `invalidate()`, immediately clearing the revealed token
 *   and all credential state and invalidating every in-flight response.
 * - Late `issue` responses arriving after invalidation are discarded without
 *   revealing the token and WITHOUT automatic destructive cleanup/revoke; the
 *   owner can inspect and revoke any unseen issued grant from the list later.
 * - Successful `revoke` immediately clears `revealed` if it matches the
 *   revoked grant id.
 */
export function createCredentialSessionController({
  contractId,
  ownerUserId,
  listFn = listOwnerCredentials,
  issueFn = issueOwnerCredential,
  revokeFn = revokeOwnerCredential,
  onState = () => {},
} = {}) {
  let active = Boolean(contractId && ownerUserId)
  let generation = 0
  let listSeq = 0
  let state = {
    grants: [],
    loading: active,
    listError: null,
    issuing: false,
    issueError: null,
    issuanceDisabled: false,
    revealed: null,
    revokingId: null,
    revokeError: null,
  }

  const emit = (patch) => {
    state = { ...state, ...patch }
    onState(state)
    return state
  }

  const isCurrent = (gen) => active && gen === generation

  const invalidate = () => {
    active = false
    generation += 1
    listSeq += 1
    return emit({
      grants: [],
      loading: false,
      listError: null,
      issuing: false,
      issueError: null,
      issuanceDisabled: false,
      revealed: null,
      revokingId: null,
      revokeError: null,
    })
  }

  const handleAuthEvent = (event, session) => {
    if (!active) return false
    const nextUser = session?.user ?? null
    if (
      event === 'SIGNED_OUT'
      || !nextUser
      || nextUser.is_anonymous !== false
      || nextUser.id !== ownerUserId
    ) {
      invalidate()
      return true
    }
    return false
  }

  const load = async () => {
    if (!active) return state
    const gen = generation
    const seq = ++listSeq
    emit({ loading: true, listError: null })
    const { grants: rows, reason } = await listFn(contractId)
    if (!isCurrent(gen) || listSeq !== seq) return state
    if (reason) {
      return emit({ loading: false, grants: [], listError: credentialErrorMessage(reason) })
    }
    return emit({ loading: false, grants: rows, listError: null })
  }

  const issue = async ({ scopes, expiresAt }) => {
    if (!active || state.issuing || state.issuanceDisabled) return { ok: false }
    const gen = generation
    emit({ issuing: true, issueError: null })
    const { grant, token, reason } = await issueFn({ contractId, scopes, expiresAt })
    // Discard late response after sign-out, user change, or deal switch.
    // No automatic destructive revoke is performed; unseen grants can be
    // revoked later from the agreement's credential list.
    if (!isCurrent(gen)) return { ok: false, discarded: true }
    if (reason) {
      emit({
        issuing: false,
        issuanceDisabled: reason === 'issuance_disabled' ? true : state.issuanceDisabled,
        issueError: credentialErrorMessage(reason),
      })
      return { ok: false, reason }
    }
    emit({
      issuing: false,
      issueError: null,
      revealed: {
        contractId,
        grantId: grant.id,
        token,
        scopes: grant.scopes,
        expiresAt: grant.expires_at,
      },
    })
    await load()
    return { ok: true, grantId: grant.id }
  }

  const revoke = async (grantId) => {
    if (!active || state.revokingId) return { ok: false }
    const gen = generation
    emit({ revokingId: grantId, revokeError: null })
    const { revoked, reason } = await revokeFn({ contractId, grantId })
    if (!isCurrent(gen)) return { ok: false, discarded: true }
    if (!revoked) {
      emit({ revokingId: null, revokeError: credentialErrorMessage(reason) })
      return { ok: false, reason }
    }
    emit({
      revokingId: null,
      revokeError: null,
      revealed: state.revealed?.grantId === grantId ? null : state.revealed,
    })
    await load()
    return { ok: true }
  }

  const dismissReveal = () => emit({ revealed: null })
  const clearIssueError = () => emit({ issueError: null })
  const getState = () => state

  return {
    getState,
    load,
    issue,
    revoke,
    dismissReveal,
    clearIssueError,
    handleAuthEvent,
    invalidate,
  }
}

/**
 * Pure App-level auth boundary transition for `supabase.auth.onAuthStateChange`.
 *
 * Guarantees:
 * - Preserves existing `expired` vs `anonymous` UX when a session lapses or
 *   signs out (`rememberedEmail` present -> `'expired'`, absent -> `'anonymous'`).
 * - Immediately signals `clearOwnerState: true` on `SIGNED_OUT`, cross-tab
 *   user-id change, or downgrade from a verified owner session so owner
 *   agreements and credential secrets never outlive the owner session.
 * - Treats `INITIAL_SESSION` (mount/resubscribe) and same-user `TOKEN_REFRESHED`
 *   / `SIGNED_IN` / `USER_UPDATED` as strict no-ops.
 */
export function resolveAppAuthChange(
  currentAuth,
  event,
  session,
  { rememberedEmail = null } = {},
) {
  if (event === 'INITIAL_SESSION') {
    return { changed: false, clearOwnerState: false, nextAuth: currentAuth }
  }

  const email = typeof rememberedEmail === 'string' && rememberedEmail.length > 0
    ? rememberedEmail
    : null
  const fallbackAuth = email
    ? { status: 'expired', email, userId: null }
    : { status: 'anonymous', email: null, userId: null }

  if (event === 'SIGNED_OUT') {
    return { changed: true, clearOwnerState: true, nextAuth: fallbackAuth }
  }

  const wasSignedInOwner = currentAuth?.status === 'signed_in'
    && typeof currentAuth.userId === 'string'
    && currentAuth.userId.length > 0
  if (!wasSignedInOwner) {
    return { changed: false, clearOwnerState: false, nextAuth: currentAuth }
  }

  const nextUser = session?.user ?? null
  const nextUserId = nextUser
    && nextUser.is_anonymous === false
    && typeof nextUser.id === 'string'
    && nextUser.id.length > 0
    ? nextUser.id
    : null

  if (nextUserId === currentAuth.userId) {
    return { changed: false, clearOwnerState: false, nextAuth: currentAuth }
  }

  const nextAuth = nextUserId
    ? { status: 'signed_in', email: nextUser.email ?? null, userId: nextUserId }
    : fallbackAuth

  return { changed: true, clearOwnerState: true, nextAuth }
}

/**
 * Subscribe the App-level auth boundary to `authClient.onAuthStateChange`.
 * Returns an unsubscribe cleanup function.
 */
export function subscribeAppAuthBoundary({
  authClient,
  getAuth,
  getRememberedEmail,
  setAuth,
  clearOwnerState,
} = {}) {
  const { data } = authClient?.onAuthStateChange?.((event, session) => {
    const transition = resolveAppAuthChange(getAuth?.(), event, session, {
      rememberedEmail: getRememberedEmail?.() ?? null,
    })
    if (!transition.changed) return
    setAuth?.(transition.nextAuth)
    if (transition.clearOwnerState) clearOwnerState?.()
  }) ?? {}

  return () => data?.subscription?.unsubscribe?.()
}

/**
 * Mount a session-scoped credential controller and wire it to
 * `authClient.onAuthStateChange`, triggering the initial list load and
 * returning `{ controller, cleanup }`.
 */
export function mountCredentialPanelSession({
  authClient,
  contractId,
  ownerUserId,
  onState,
  onAuthInvalidated,
  listFn,
  issueFn,
  revokeFn,
} = {}) {
  const controller = createCredentialSessionController({
    contractId,
    ownerUserId,
    onState,
    ...(listFn ? { listFn } : {}),
    ...(issueFn ? { issueFn } : {}),
    ...(revokeFn ? { revokeFn } : {}),
  })
  controller.load()

  const { data } = authClient?.onAuthStateChange?.((event, session) => {
    if (controller.handleAuthEvent(event, session)) {
      onAuthInvalidated?.()
    }
  }) ?? {}

  const cleanup = () => {
    data?.subscription?.unsubscribe?.()
    controller.invalidate()
  }

  return { controller, cleanup }
}
