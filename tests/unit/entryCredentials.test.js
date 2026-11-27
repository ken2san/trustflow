import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as delegatedClient from '../../scripts/lib/delegatedClient.mjs'

// Focused unit & session/component regression tests for Row 6 (minimal owner
// credential UI):
// - default-off UI exposure (env flag + AgreementView render)
// - lowercase token UUID parity with delegatedAuth.ts & delegatedClient.mjs
// - late issue after SIGNED_OUT (incl. cross-tab), user-id change, or deal switch
// - revoke clears open secret reveal
// - foreign-deal & non-owner list rejection
// - fail-closed issuance_disabled, 30-day cap, zero secret logging

const invoke = vi.fn()
const invokeErrorReason = vi.fn()

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    functions: { invoke: (...a) => invoke(...a) },
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
  },
  invokeErrorReason: (...a) => invokeErrorReason(...a),
}))

const {
  OWNER_SCOPES,
  EXPIRY_PRESETS,
  MAX_GRANT_MS,
  UUID_RE,
  GRANT_TOKEN_RE,
  isOwnerCredentialsUiEnabled,
  canShowOwnerCredentials,
  validateOwnerScopes,
  computeExpiryIso,
  validateExpiryIso,
  formatGrantToken,
  grantStatus,
  credentialErrorMessage,
  listOwnerCredentials,
  issueOwnerCredential,
  revokeOwnerCredential,
  createCredentialSessionController,
  resolveAppAuthChange,
  subscribeAppAuthBoundary,
  mountCredentialPanelSession,
} = await import('../../src/lib/entryCredentials.js')

const { default: AgreementView } = await import('../../src/views/AgreementView.jsx')

const DEAL = '11111111-1111-4111-8111-111111111111'
const OTHER_DEAL = '22222222-2222-4222-8222-222222222222'
const GRANT_ID = '33333333-3333-4333-8333-333333333333'
const OWNER_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_OWNER_ID = '55555555-5555-4555-8555-555555555555'
const SECRET = 'a'.repeat(64)
const NOW = Date.parse('2026-11-27T12:00:00.000Z')

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  invoke.mockReset()
  invokeErrorReason.mockReset()
  invokeErrorReason.mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Row 6 default-off UI exposure & owner gating', () => {
  const ownerContract = {
    id: DEAL,
    earner_user_id: OWNER_ID,
    project_name: 'Audit deal',
    state: 'TERMS_ACCEPTED',
    performed_by: 'creator',
    dod: ['Deliver work'],
  }

  it('is hidden by default unless VITE_OWNER_CREDENTIALS_UI === "on"', () => {
    for (const env of [{}, { VITE_OWNER_CREDENTIALS_UI: '' }, { VITE_OWNER_CREDENTIALS_UI: 'true' },
      { VITE_OWNER_CREDENTIALS_UI: 'ON' }, { VITE_OWNER_CREDENTIALS_UI: '1' }, { VITE_OWNER_CREDENTIALS_UI: 'false' }]) {
      expect(isOwnerCredentialsUiEnabled(env), JSON.stringify(env)).toBe(false)
    }
    expect(isOwnerCredentialsUiEnabled({ VITE_OWNER_CREDENTIALS_UI: 'on' })).toBe(true)

    // Default-off: canShowOwnerCredentials refuses even for a valid signed-in owner.
    expect(canShowOwnerCredentials({
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })).toBe(false)
  })

  it('requires uiEnabled + owner source + signed_in + matching earner_user_id', () => {
    expect(canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })).toBe(true)

    expect(canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'guest',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })).toBe(false)

    expect(canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'owner',
      authStatus: 'anonymous',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })).toBe(false)

    expect(canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OTHER_OWNER_ID,
      contract: ownerContract,
    })).toBe(false)

    expect(canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: { ...ownerContract, earner_user_id: undefined },
    })).toBe(false)
  })

  it('AgreementView does not render Agent credentials when hidden by default, and renders when enabled', () => {
    const hiddenHtml = renderToStaticMarkup(React.createElement(AgreementView, {
      contract: ownerContract,
      events: [],
      viewerRole: 'performer',
      canManageCredentials: false,
      ownerUserId: OWNER_ID,
    }))
    expect(hiddenHtml).not.toContain('Agent credentials')

    const shownHtml = renderToStaticMarkup(React.createElement(AgreementView, {
      contract: ownerContract,
      events: [],
      viewerRole: 'performer',
      canManageCredentials: true,
      ownerUserId: OWNER_ID,
    }))
    expect(shownHtml).toContain('Agent credentials')
    expect(shownHtml).toContain('Issue a new owner credential')
  })
})

describe('Row 6 pure validation & lowercase token parity', () => {
  it('exposes only the 7 owner_account scopes and never offers accept', () => {
    const ids = OWNER_SCOPES.map(s => s.id)
    expect(ids).toEqual([
      'read',
      'performance.asserted',
      'performance.accepted',
      'performance.rejected',
      'payment.reported',
      'payment.acknowledged',
      'payment.disputed',
    ])
    expect(ids).not.toContain('accept')
  })

  it('validates owner scopes strictly and rejects empty, duplicate, unknown, and accept', () => {
    expect(validateOwnerScopes(['read', 'performance.asserted'])).toEqual({
      ok: true,
      scopes: ['read', 'performance.asserted'],
    })
    expect(validateOwnerScopes([])).toEqual({ ok: false, reason: 'scopes_required' })
    expect(validateOwnerScopes(null)).toEqual({ ok: false, reason: 'scopes_required' })
    expect(validateOwnerScopes(['accept'])).toEqual({ ok: false, reason: 'invalid_scope' })
    expect(validateOwnerScopes(['read', 'manage'])).toEqual({ ok: false, reason: 'invalid_scope' })
    expect(validateOwnerScopes(['read', 'read'])).toEqual({ ok: false, reason: 'duplicate_scope' })
  })

  it('enforces the 30-day technical expiry cap across presets and custom ISO instants', () => {
    for (const preset of EXPIRY_PRESETS) {
      const res = computeExpiryIso(preset.ms, NOW)
      expect(res.ok, preset.id).toBe(true)
      expect(Date.parse(res.expiresAt)).toBeGreaterThan(NOW)
      expect(Date.parse(res.expiresAt)).toBeLessThanOrEqual(NOW + MAX_GRANT_MS)
    }

    expect(computeExpiryIso(0, NOW)).toEqual({ ok: false, reason: 'expiry_too_short' })
    expect(computeExpiryIso(-1000, NOW)).toEqual({ ok: false, reason: 'expiry_too_short' })
    expect(computeExpiryIso(MAX_GRANT_MS + 1, NOW)).toEqual({ ok: false, reason: 'expiry_exceeds_cap' })

    expect(validateExpiryIso(new Date(NOW + 60_000).toISOString(), NOW).ok).toBe(true)
    expect(validateExpiryIso(new Date(NOW + MAX_GRANT_MS).toISOString(), NOW).ok).toBe(true)
    expect(validateExpiryIso(new Date(NOW).toISOString(), NOW)).toEqual({ ok: false, reason: 'expiry_in_past' })
    expect(validateExpiryIso(new Date(NOW - 1000).toISOString(), NOW)).toEqual({ ok: false, reason: 'expiry_in_past' })
    expect(validateExpiryIso(new Date(NOW + MAX_GRANT_MS + 1000).toISOString(), NOW)).toEqual({
      ok: false,
      reason: 'expiry_exceeds_cap',
    })
    expect(validateExpiryIso('not-a-date', NOW)).toEqual({ ok: false, reason: 'invalid_expiry' })
  })

  it('enforces strict lowercase UUID token parity with delegatedAuth.ts and delegatedClient.mjs', () => {
    const token = formatGrantToken(GRANT_ID, SECRET)
    expect(token).toBe(`${GRANT_ID}.${SECRET}`)
    expect(token.length).toBe(101)
    expect(GRANT_TOKEN_RE.test(token)).toBe(true)
    expect(delegatedClient.GRANT_TOKEN.test(token)).toBe(true)
    expect(UUID_RE.source).toBe(delegatedClient.UUID.source)
    expect(GRANT_TOKEN_RE.source).toBe(delegatedClient.GRANT_TOKEN.source)

    // Pin against server `GRANT_FORMAT` in supabase/functions/_shared/delegatedAuth.ts.
    const authSrc = readFileSync('supabase/functions/_shared/delegatedAuth.ts', 'utf8')
    const match = /const GRANT_FORMAT = \/(.+)\//.exec(authSrc)
    expect(match).not.toBeNull()
    const serverGrantRe = new RegExp(match[1])
    expect(serverGrantRe.test(token)).toBe(true)

    // Uppercase UUID or secret must be rejected (parity with server).
    const upperUuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    expect(formatGrantToken(upperUuid, SECRET)).toBeNull()
    expect(serverGrantRe.test(`${upperUuid}.${SECRET}`)).toBe(false)
    expect(formatGrantToken('not-a-uuid', SECRET)).toBeNull()
    expect(formatGrantToken(GRANT_ID, 'short')).toBeNull()
    expect(formatGrantToken(GRANT_ID, 'A'.repeat(64))).toBeNull()
    expect(formatGrantToken(GRANT_ID, null)).toBeNull()
  })

  it('computes grant status fail-closed (revoked > expired > active)', () => {
    const future = new Date(NOW + 3600_000).toISOString()
    const past = new Date(NOW - 3600_000).toISOString()
    expect(grantStatus({ expires_at: future, revoked_at: null }, NOW)).toBe('active')
    expect(grantStatus({ expires_at: future, revoked_at: past }, NOW)).toBe('revoked')
    expect(grantStatus({ expires_at: past, revoked_at: null }, NOW)).toBe('expired')
    expect(grantStatus({ expires_at: 'bad', revoked_at: null }, NOW)).toBe('expired')
  })

  it('maps known errors to fixed text without echoing raw input', () => {
    expect(credentialErrorMessage('issuance_disabled')).toContain('disabled')
    expect(credentialErrorMessage('not_authorized')).toContain('not authorized')
    expect(credentialErrorMessage('expiry_exceeds_cap')).toContain('30 days')
    expect(credentialErrorMessage(`secret_${SECRET}`)).not.toContain(SECRET)
  })
})

describe('listOwnerCredentials, issueOwnerCredential, revokeOwnerCredential', () => {
  const validExpiry = new Date(NOW + 86_400_000).toISOString()

  it('lists grants for the requested deal only and rejects foreign-deal or non-owner rows', async () => {
    expect(await listOwnerCredentials('not-a-uuid')).toEqual({ grants: null, reason: 'invalid_contract' })
    expect(invoke).not.toHaveBeenCalled()

    const row = {
      id: GRANT_ID,
      contract_id: DEAL,
      issuer_kind: 'owner_account',
      scopes: ['read'],
      created_at: new Date(NOW).toISOString(),
      expires_at: validExpiry,
      revoked_at: null,
    }
    invoke.mockResolvedValue({ data: { grants: [row] }, error: null })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: [row], reason: null })

    // Foreign deal row fails closed.
    invoke.mockResolvedValue({ data: { grants: [{ ...row, contract_id: OTHER_DEAL }] }, error: null })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'invalid_response' })

    // Counterpart row fails closed.
    invoke.mockResolvedValue({ data: { grants: [{ ...row, issuer_kind: 'counterpart_account' }] }, error: null })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'invalid_response' })

    // Unexpected throw fails closed.
    invoke.mockRejectedValue(new Error('network down'))
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'error' })
  })

  it('issues owner_account grant, enforces lowercase UUID + 503 fail-closed, and never logs the secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const grant = {
      status: 'issued',
      id: GRANT_ID,
      contract_id: DEAL,
      issuer_kind: 'owner_account',
      scopes: ['read', 'performance.asserted'],
      expires_at: validExpiry,
    }
    invoke.mockResolvedValue({ data: { grant, secret: SECRET }, error: null })

    const res = await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read', 'performance.asserted'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })
    expect(res).toEqual({ grant, token: `${GRANT_ID}.${SECRET}`, reason: null })
    expect(invoke.mock.calls[0][1].body).toEqual({
      action: 'issue',
      contract_id: DEAL,
      issuer_kind: 'owner_account',
      scopes: ['read', 'performance.asserted'],
      expires_at: validExpiry,
    })
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()

    // Uppercase grant id in response fails closed.
    invoke.mockResolvedValue({
      data: { grant: { ...grant, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, secret: SECRET },
      error: null,
    })
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'invalid_response' })

    // 503 issuance_disabled fails closed.
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsHttpError' } })
    invokeErrorReason.mockResolvedValue('issuance_disabled')
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'issuance_disabled' })
  })

  it('revokes with exact contract_id and grant id and fails closed on errors', async () => {
    expect(await revokeOwnerCredential({ contractId: 'bad', grantId: GRANT_ID })).toEqual({
      revoked: false,
      reason: 'invalid_contract',
    })
    expect(await revokeOwnerCredential({ contractId: DEAL, grantId: 'bad' })).toEqual({
      revoked: false,
      reason: 'invalid_grant_id',
    })
    expect(invoke).not.toHaveBeenCalled()

    invoke.mockResolvedValue({ data: { status: 'revoked' }, error: null })
    expect(await revokeOwnerCredential({ contractId: DEAL, grantId: GRANT_ID })).toEqual({
      revoked: true,
      reason: null,
    })
    expect(invoke).toHaveBeenCalledWith('manage-entry-agent-credential', {
      body: { action: 'revoke', contract_id: DEAL, id: GRANT_ID },
    })
  })
})

describe('Row 6 session controller regressions (sign-out, cross-tab user change, deal switch, revoke)', () => {
  const validExpiry = new Date(NOW + 86_400_000).toISOString()
  const issuedPayload = {
    grant: {
      status: 'issued',
      id: GRANT_ID,
      contract_id: DEAL,
      issuer_kind: 'owner_account',
      scopes: ['read'],
      expires_at: validExpiry,
    },
    token: `${GRANT_ID}.${SECRET}`,
    reason: null,
  }

  it('discards a late issue response after SIGNED_OUT (incl. cross-tab) without revealing secret or auto-revoking', async () => {
    const pendingIssue = deferred()
    const revokeFn = vi.fn()
    const states = []
    const ctrl = createCredentialSessionController({
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      listFn: vi.fn().mockResolvedValue({ grants: [], reason: null }),
      issueFn: () => pendingIssue.promise,
      revokeFn,
      onState: (s) => states.push(s),
    })

    const issuePromise = ctrl.issue({ scopes: ['read'], expiresAt: validExpiry })
    expect(ctrl.getState().issuing).toBe(true)

    // Cross-tab or same-tab SIGNED_OUT arrives before issue resolves.
    expect(ctrl.handleAuthEvent('SIGNED_OUT', null)).toBe(true)
    expect(ctrl.getState().issuing).toBe(false)
    expect(ctrl.getState().revealed).toBeNull()

    pendingIssue.resolve(issuedPayload)
    const outcome = await issuePromise
    expect(outcome).toEqual({ ok: false, discarded: true })
    expect(ctrl.getState().revealed).toBeNull()
    expect(states.every(s => s.revealed === null)).toBe(true)
    expect(revokeFn).not.toHaveBeenCalled()
  })

  it('discards a late issue response and clears an existing reveal on cross-tab user-id change', async () => {
    const pendingIssue = deferred()
    const revokeFn = vi.fn()
    const ctrl = createCredentialSessionController({
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      listFn: vi.fn().mockResolvedValue({ grants: [], reason: null }),
      issueFn: () => pendingIssue.promise,
      revokeFn,
    })

    const issuePromise = ctrl.issue({ scopes: ['read'], expiresAt: validExpiry })
    // Another account signs in in another tab.
    expect(ctrl.handleAuthEvent('SIGNED_IN', { user: { id: OTHER_OWNER_ID, is_anonymous: false } })).toBe(true)

    pendingIssue.resolve(issuedPayload)
    expect(await issuePromise).toEqual({ ok: false, discarded: true })
    expect(ctrl.getState().revealed).toBeNull()
    expect(revokeFn).not.toHaveBeenCalled()
  })

  it('discards a late issue response on deal switch / unmount (invalidate) without auto-revoking', async () => {
    const pendingIssue = deferred()
    const revokeFn = vi.fn()
    const ctrl = createCredentialSessionController({
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      listFn: vi.fn().mockResolvedValue({ grants: [], reason: null }),
      issueFn: () => pendingIssue.promise,
      revokeFn,
    })

    const issuePromise = ctrl.issue({ scopes: ['read'], expiresAt: validExpiry })
    ctrl.invalidate()
    pendingIssue.resolve(issuedPayload)
    expect(await issuePromise).toEqual({ ok: false, discarded: true })
    expect(ctrl.getState().revealed).toBeNull()
    expect(revokeFn).not.toHaveBeenCalled()
  })

  it('clears an open secret reveal immediately when that grant is revoked', async () => {
    const listFn = vi.fn()
      .mockResolvedValueOnce({
        grants: [{
          id: GRANT_ID, contract_id: DEAL, issuer_kind: 'owner_account',
          scopes: ['read'], expires_at: validExpiry, revoked_at: null,
        }],
        reason: null,
      })
      .mockResolvedValueOnce({
        grants: [{
          id: GRANT_ID, contract_id: DEAL, issuer_kind: 'owner_account',
          scopes: ['read'], expires_at: validExpiry, revoked_at: new Date(NOW).toISOString(),
        }],
        reason: null,
      })
    const ctrl = createCredentialSessionController({
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      listFn,
      issueFn: vi.fn().mockResolvedValue(issuedPayload),
      revokeFn: vi.fn().mockResolvedValue({ revoked: true, reason: null }),
    })

    const issued = await ctrl.issue({ scopes: ['read'], expiresAt: validExpiry })
    expect(issued.ok).toBe(true)
    expect(ctrl.getState().revealed?.grantId).toBe(GRANT_ID)
    expect(ctrl.getState().revealed?.token).toBe(`${GRANT_ID}.${SECRET}`)

    const revoked = await ctrl.revoke(GRANT_ID)
    expect(revoked.ok).toBe(true)
    expect(ctrl.getState().revealed).toBeNull()
    expect(ctrl.getState().grants[0].revoked_at).toBeTruthy()
  })

  it('clears grants and surfaces error when load receives foreign-deal list rejection', async () => {
    const ctrl = createCredentialSessionController({
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      listFn: vi.fn().mockResolvedValue({ grants: null, reason: 'invalid_response' }),
    })
    await ctrl.load()
    expect(ctrl.getState().grants).toEqual([])
    expect(ctrl.getState().listError).toContain('unexpected response')
  })
})

describe('Row 6 App-level auth transitions (expired vs anonymous preservation)', () => {
  const signedInOwner = { status: 'signed_in', email: 'owner@example.com', userId: OWNER_ID }
  const expiredAuth = { status: 'expired', email: 'owner@example.com', userId: null }
  const anonymousAuth = { status: 'anonymous', email: null, userId: 'anon-1111' }

  it('preserves expired UX on SIGNED_OUT when an earner email is still remembered (e.g. failed refresh)', () => {
    const res = resolveAppAuthChange(signedInOwner, 'SIGNED_OUT', null, {
      rememberedEmail: 'owner@example.com',
    })
    expect(res).toEqual({
      changed: true,
      clearOwnerState: true,
      nextAuth: { status: 'expired', email: 'owner@example.com', userId: null },
    })
  })

  it('transitions to anonymous on SIGNED_OUT when remembered email was forgotten (explicit sign-out)', () => {
    const res = resolveAppAuthChange(signedInOwner, 'SIGNED_OUT', null, {
      rememberedEmail: null,
    })
    expect(res).toEqual({
      changed: true,
      clearOwnerState: true,
      nextAuth: { status: 'anonymous', email: null, userId: null },
    })
  })

  it('clears owner state and switches user when a different verified user signs in', () => {
    const res = resolveAppAuthChange(
      signedInOwner,
      'SIGNED_IN',
      { user: { id: OTHER_OWNER_ID, email: 'other@example.com', is_anonymous: false } },
      { rememberedEmail: 'owner@example.com' },
    )
    expect(res).toEqual({
      changed: true,
      clearOwnerState: true,
      nextAuth: { status: 'signed_in', email: 'other@example.com', userId: OTHER_OWNER_ID },
    })
  })

  it('clears owner state and preserves expired-vs-anonymous when downgraded to anonymous or null session', () => {
    const expiredRes = resolveAppAuthChange(
      signedInOwner,
      'USER_UPDATED',
      { user: { id: 'anon-9999', is_anonymous: true } },
      { rememberedEmail: 'owner@example.com' },
    )
    expect(expiredRes).toEqual({
      changed: true,
      clearOwnerState: true,
      nextAuth: { status: 'expired', email: 'owner@example.com', userId: null },
    })

    const anonRes = resolveAppAuthChange(signedInOwner, 'USER_UPDATED', null, {
      rememberedEmail: null,
    })
    expect(anonRes).toEqual({
      changed: true,
      clearOwnerState: true,
      nextAuth: { status: 'anonymous', email: null, userId: null },
    })
  })

  it('treats TOKEN_REFRESHED / SIGNED_IN / USER_UPDATED for the same verified user as a no-op', () => {
    const sameSession = { user: { id: OWNER_ID, email: 'owner@example.com', is_anonymous: false } }
    for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN', 'USER_UPDATED']) {
      expect(resolveAppAuthChange(signedInOwner, event, sameSession, {
        rememberedEmail: 'owner@example.com',
      })).toEqual({
        changed: false,
        clearOwnerState: false,
        nextAuth: signedInOwner,
      })
    }
  })

  it('treats INITIAL_SESSION on mount or resubscribe as a no-op across all auth states', () => {
    const sameSession = { user: { id: OWNER_ID, email: 'owner@example.com', is_anonymous: false } }
    expect(resolveAppAuthChange(signedInOwner, 'INITIAL_SESSION', sameSession, {
      rememberedEmail: 'owner@example.com',
    })).toEqual({ changed: false, clearOwnerState: false, nextAuth: signedInOwner })

    expect(resolveAppAuthChange(signedInOwner, 'INITIAL_SESSION', null, {
      rememberedEmail: 'owner@example.com',
    })).toEqual({ changed: false, clearOwnerState: false, nextAuth: signedInOwner })

    expect(resolveAppAuthChange(expiredAuth, 'INITIAL_SESSION', null, {
      rememberedEmail: 'owner@example.com',
    })).toEqual({ changed: false, clearOwnerState: false, nextAuth: expiredAuth })
  })

  it('does not treat an anonymous user with non-null userId as a signed-in owner changing users', () => {
    const anonSession = { user: { id: 'anon-1111', is_anonymous: true } }
    expect(resolveAppAuthChange(anonymousAuth, 'TOKEN_REFRESHED', anonSession)).toEqual({
      changed: false,
      clearOwnerState: false,
      nextAuth: anonymousAuth,
    })
    expect(resolveAppAuthChange(expiredAuth, 'TOKEN_REFRESHED', anonSession, {
      rememberedEmail: 'owner@example.com',
    })).toEqual({
      changed: false,
      clearOwnerState: false,
      nextAuth: expiredAuth,
    })
  })
})

describe('Row 6 actual subscription & component wiring regressions', () => {
  const validExpiry = new Date(NOW + 86_400_000).toISOString()
  const ownerContract = {
    id: DEAL,
    earner_user_id: OWNER_ID,
    project_name: 'Audit deal',
    state: 'TERMS_ACCEPTED',
    performed_by: 'creator',
    dod: ['Deliver work'],
  }

  function createFakeAuthClient() {
    let listener = null
    const unsubscribe = vi.fn(() => { listener = null })
    const onAuthStateChange = vi.fn((cb) => {
      listener = cb
      return { data: { subscription: { unsubscribe } } }
    })
    return {
      authClient: { onAuthStateChange },
      unsubscribe,
      emit: (event, session) => listener?.(event, session),
    }
  }

  it('subscribeAppAuthBoundary wires live auth events, preserves expired UX, clears owner state only, and unsubscribes', () => {
    const { authClient, unsubscribe, emit } = createFakeAuthClient()
    let auth = { status: 'signed_in', email: 'owner@example.com', userId: OWNER_ID }
    let remembered = 'owner@example.com'
    let myContracts = [ownerContract]
    let agreement = { source: 'owner', contract: ownerContract }
    const setAuth = vi.fn((next) => { auth = next })
    const clearOwnerState = vi.fn(() => {
      myContracts = []
      agreement = agreement?.source === 'owner' ? null : agreement
    })

    const cleanup = subscribeAppAuthBoundary({
      authClient,
      getAuth: () => auth,
      getRememberedEmail: () => remembered,
      setAuth,
      clearOwnerState,
    })
    expect(authClient.onAuthStateChange).toHaveBeenCalledTimes(1)

    // INITIAL_SESSION and same-user TOKEN_REFRESHED are no-ops.
    emit('INITIAL_SESSION', { user: { id: OWNER_ID, email: 'owner@example.com', is_anonymous: false } })
    emit('TOKEN_REFRESHED', { user: { id: OWNER_ID, email: 'owner@example.com', is_anonymous: false } })
    expect(setAuth).not.toHaveBeenCalled()
    expect(clearOwnerState).not.toHaveBeenCalled()
    expect(agreement?.source).toBe('owner')

    // Refresh-token failure emits SIGNED_OUT while email is still remembered -> expired + owner cleared.
    emit('SIGNED_OUT', null)
    expect(auth).toEqual({ status: 'expired', email: 'owner@example.com', userId: null })
    expect(myContracts).toEqual([])
    expect(agreement).toBeNull()

    // Explicit sign-out (remembered email cleared) on a guest agreement keeps guest agreement intact.
    auth = { status: 'signed_in', email: 'owner@example.com', userId: OWNER_ID }
    remembered = null
    agreement = { source: 'guest', contract: ownerContract }
    emit('SIGNED_OUT', null)
    expect(auth).toEqual({ status: 'anonymous', email: null, userId: null })
    expect(agreement?.source).toBe('guest')

    // Cleanup unsubscribes so later events do not fire.
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    setAuth.mockClear()
    clearOwnerState.mockClear()
    emit('SIGNED_OUT', null)
    expect(setAuth).not.toHaveBeenCalled()
    expect(clearOwnerState).not.toHaveBeenCalled()
  })

  it('mountCredentialPanelSession wires initial load, live auth invalidation, late-issue discard, and cleanup', async () => {
    const { authClient, unsubscribe, emit } = createFakeAuthClient()
    const pendingIssue = deferred()
    const listFn = vi.fn().mockResolvedValue({ grants: [], reason: null })
    const revokeFn = vi.fn()
    const onAuthInvalidated = vi.fn()
    let latestState = null

    const { controller, cleanup } = mountCredentialPanelSession({
      authClient,
      contractId: DEAL,
      ownerUserId: OWNER_ID,
      onState: (s) => { latestState = s },
      onAuthInvalidated,
      listFn,
      issueFn: () => pendingIssue.promise,
      revokeFn,
    })

    expect(listFn).toHaveBeenCalledWith(DEAL)
    expect(authClient.onAuthStateChange).toHaveBeenCalledTimes(1)

    // Same-user token refresh must not invalidate the active panel.
    emit('TOKEN_REFRESHED', { user: { id: OWNER_ID, is_anonymous: false } })
    expect(onAuthInvalidated).not.toHaveBeenCalled()

    // In-flight issue invalidated by live SIGNED_OUT event on the wired listener.
    const issuePromise = controller.issue({ scopes: ['read'], expiresAt: validExpiry })
    emit('SIGNED_OUT', null)
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1)
    expect(latestState.revealed).toBeNull()

    pendingIssue.resolve({
      grant: {
        status: 'issued',
        id: GRANT_ID,
        contract_id: DEAL,
        issuer_kind: 'owner_account',
        scopes: ['read'],
        expires_at: validExpiry,
      },
      token: `${GRANT_ID}.${SECRET}`,
      reason: null,
    })
    expect(await issuePromise).toEqual({ ok: false, discarded: true })
    expect(latestState.revealed).toBeNull()
    expect(revokeFn).not.toHaveBeenCalled()

    // Cleanup unsubscribes and invalidates.
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    onAuthInvalidated.mockClear()
    emit('SIGNED_OUT', null)
    expect(onAuthInvalidated).not.toHaveBeenCalled()
  })

  it('wires App -> AgreementView -> AgentCredentialsPanel default-off, keyed remount, and clipboard warning', () => {
    // End-to-end predicate -> AgreementView render check (default-off vs enabled).
    const defaultOffAllowed = canShowOwnerCredentials({
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })
    expect(defaultOffAllowed).toBe(false)
    const defaultHtml = renderToStaticMarkup(React.createElement(AgreementView, {
      contract: ownerContract,
      events: [],
      viewerRole: 'performer',
      canManageCredentials: defaultOffAllowed,
      ownerUserId: OWNER_ID,
    }))
    expect(defaultHtml).not.toContain('Agent credentials')

    const enabledAllowed = canShowOwnerCredentials({
      uiEnabled: true,
      agreementSource: 'owner',
      authStatus: 'signed_in',
      authUserId: OWNER_ID,
      contract: ownerContract,
    })
    expect(enabledAllowed).toBe(true)
    const enabledHtml = renderToStaticMarkup(React.createElement(AgreementView, {
      contract: ownerContract,
      events: [],
      viewerRole: 'performer',
      canManageCredentials: enabledAllowed,
      ownerUserId: OWNER_ID,
    }))
    expect(enabledHtml).toContain('Agent credentials')

    // Source-level wiring pins across App.jsx, AgreementView.jsx, and AgentCredentialsPanel.jsx.
    const appSrc = readFileSync('src/App.jsx', 'utf8')
    const agreementSrc = readFileSync('src/views/AgreementView.jsx', 'utf8')
    const panelSrc = readFileSync('src/components/AgentCredentialsPanel.jsx', 'utf8')

    expect(appSrc).toContain('subscribeAppAuthBoundary({')
    expect(appSrc).toContain('getRememberedEmail: recallEarnerEmail')
    expect(appSrc).toContain('canManageCredentials={canShowOwnerCredentials({')
    expect(agreementSrc).toContain('<AgentCredentialsPanel key={`${contract.id}:${ownerUserId}`} contract={contract} ownerUserId={ownerUserId} />')
    expect(panelSrc).toContain('mountCredentialPanelSession({')
    expect(panelSrc).toContain('Clear your clipboard after pasting.')
  })
})
