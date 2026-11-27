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
