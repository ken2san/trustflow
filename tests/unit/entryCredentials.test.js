import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Focused unit tests for Row 6 (minimal owner credential UI client boundary).
// Tests pure validation/formatting helpers and the exact payloads/fail-closed
// responses of listOwnerCredentials, issueOwnerCredential, and revokeOwnerCredential
// against `manage-entry-agent-credential`.

const invoke = vi.fn()
const invokeErrorReason = vi.fn()

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    functions: { invoke: (...a) => invoke(...a) },
  },
  invokeErrorReason: (...a) => invokeErrorReason(...a),
}))

const {
  OWNER_SCOPES,
  EXPIRY_PRESETS,
  MAX_GRANT_MS,
  validateOwnerScopes,
  computeExpiryIso,
  validateExpiryIso,
  formatGrantToken,
  grantStatus,
  credentialErrorMessage,
  listOwnerCredentials,
  issueOwnerCredential,
  revokeOwnerCredential,
} = await import('../../src/lib/entryCredentials.js')

const DEAL = '11111111-1111-4111-8111-111111111111'
const OTHER_DEAL = '22222222-2222-4222-8222-222222222222'
const GRANT_ID = '33333333-3333-4333-8333-333333333333'
const SECRET = 'a'.repeat(64)
const NOW = Date.parse('2026-11-27T12:00:00.000Z')

beforeEach(() => {
  invoke.mockReset()
  invokeErrorReason.mockReset()
  invokeErrorReason.mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Row 6 pure validation & formatting', () => {
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

  it('formats the presented x-trustflow-grant token strictly as <uuid>.<64 hex>', () => {
    expect(formatGrantToken(GRANT_ID, SECRET)).toBe(`${GRANT_ID}.${SECRET}`)
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

describe('listOwnerCredentials', () => {
  it('lists grants for the requested deal only and rejects invalid contract ids before network', async () => {
    expect(await listOwnerCredentials('not-a-uuid')).toEqual({ grants: null, reason: 'invalid_contract' })
    expect(invoke).not.toHaveBeenCalled()

    const row = {
      id: GRANT_ID,
      contract_id: DEAL,
      issuer_kind: 'owner_account',
      scopes: ['read'],
      created_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 3600_000).toISOString(),
      revoked_at: null,
    }
    invoke.mockResolvedValue({ data: { grants: [row] }, error: null })
    const res = await listOwnerCredentials(DEAL)
    expect(invoke).toHaveBeenCalledWith('manage-entry-agent-credential', {
      body: { action: 'list', contract_id: DEAL },
    })
    expect(res).toEqual({ grants: [row], reason: null })
  })

  it('fails closed if a response includes a grant belonging to another deal or is malformed', async () => {
    invoke.mockResolvedValue({
      data: {
        grants: [{
          id: GRANT_ID,
          contract_id: OTHER_DEAL,
          issuer_kind: 'owner_account',
          scopes: ['read'],
          expires_at: new Date(NOW + 3600_000).toISOString(),
          revoked_at: null,
        }],
      },
      error: null,
    })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'invalid_response' })

    invoke.mockResolvedValue({ data: { grants: 'not-an-array' }, error: null })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'invalid_response' })

    invoke.mockResolvedValue({
      data: {
        grants: [{
          id: GRANT_ID,
          contract_id: DEAL,
          issuer_kind: 'counterpart_account',
          scopes: ['read'],
          expires_at: new Date(NOW + 3600_000).toISOString(),
          revoked_at: null,
        }],
      },
      error: null,
    })
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'invalid_response' })

    invoke.mockRejectedValue(new Error('network down'))
    expect(await listOwnerCredentials(DEAL)).toEqual({ grants: null, reason: 'error' })
  })
})

describe('issueOwnerCredential', () => {
  const validExpiry = new Date(NOW + 86_400_000).toISOString()

  it('sends only the owner_account issue payload, returns token once, and never logs the secret', async () => {
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

    expect(invoke).toHaveBeenCalledWith('manage-entry-agent-credential', {
      body: {
        action: 'issue',
        contract_id: DEAL,
        issuer_kind: 'owner_account',
        scopes: ['read', 'performance.asserted'],
        expires_at: validExpiry,
      },
    })
    const sentBody = invoke.mock.calls[0][1].body
    expect(sentBody).not.toHaveProperty('issuer_id')
    expect(sentBody).not.toHaveProperty('secret_hash')
    expect(sentBody).not.toHaveProperty('invite')

    expect(res).toEqual({ grant, token: `${GRANT_ID}.${SECRET}`, reason: null })
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('refuses accept scope and >30d expiry before calling the server', async () => {
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['accept'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'invalid_scope' })

    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: new Date(NOW + MAX_GRANT_MS + 60_000).toISOString(),
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'expiry_exceeds_cap' })

    expect(invoke).not.toHaveBeenCalled()
  })

  it('fails closed on 503 issuance_disabled and never fabricates a grant or secret', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsHttpError' } })
    invokeErrorReason.mockResolvedValue('issuance_disabled')

    const res = await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })
    expect(res).toEqual({ grant: null, token: null, reason: 'issuance_disabled' })
  })

  it('fails closed on cross-deal grant response, wrong issuer_kind, or malformed secret', async () => {
    invoke.mockResolvedValue({
      data: {
        grant: {
          status: 'issued',
          id: GRANT_ID,
          contract_id: OTHER_DEAL,
          issuer_kind: 'owner_account',
          scopes: ['read'],
          expires_at: validExpiry,
        },
        secret: SECRET,
      },
      error: null,
    })
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'invalid_response' })

    invoke.mockResolvedValue({
      data: {
        grant: {
          status: 'issued',
          id: GRANT_ID,
          contract_id: DEAL,
          issuer_kind: 'counterpart_account',
          scopes: ['read'],
          expires_at: validExpiry,
        },
        secret: SECRET,
      },
      error: null,
    })
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'invalid_response' })

    invoke.mockResolvedValue({
      data: {
        grant: {
          status: 'issued',
          id: GRANT_ID,
          contract_id: DEAL,
          issuer_kind: 'owner_account',
          scopes: ['read'],
          expires_at: validExpiry,
        },
        secret: 'not-64-hex',
      },
      error: null,
    })
    expect(await issueOwnerCredential({
      contractId: DEAL,
      scopes: ['read'],
      expiresAt: validExpiry,
      nowMs: NOW,
    })).toEqual({ grant: null, token: null, reason: 'invalid_response' })
  })
})

describe('revokeOwnerCredential', () => {
  it('validates ids before network and calls revoke with exact contract_id and grant id', async () => {
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

  it('fails closed on not_authorized or unexpected revoke response', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsHttpError' } })
    invokeErrorReason.mockResolvedValue('not_authorized')
    expect(await revokeOwnerCredential({ contractId: DEAL, grantId: GRANT_ID })).toEqual({
      revoked: false,
      reason: 'not_authorized',
    })

    invokeErrorReason.mockResolvedValue(null)
    invoke.mockResolvedValue({ data: { status: 'other' }, error: null })
    expect(await revokeOwnerCredential({ contractId: DEAL, grantId: GRANT_ID })).toEqual({
      revoked: false,
      reason: 'invalid_response',
    })
  })
})
