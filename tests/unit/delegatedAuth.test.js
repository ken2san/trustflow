import { describe, it, expect } from 'vitest'
import {
  DELEGATED_UNAVAILABLE, DELEGATION_REFUSED, delegatedAdmission, refusalAnswer,
} from '../../supabase/functions/_shared/delegatedAuth.ts'

// Admission for x-trustflow-grant (row 4a). The database decides authority;
// this only decides whether the request is delegated and well-formed.
const ANON = 'anon-public-key'
const ID = 'cccccccc-0000-4000-8000-000000000001'
const SECRET = 'a'.repeat(64)
const headers = (h) => new Headers(h)
const ok = { authorization: `Bearer ${ANON}`, 'x-trustflow-grant': `${ID}.${SECRET}` }

describe('delegatedAdmission', () => {
  it('no grant header: not delegated, whatever else is present', async () => {
    expect(await delegatedAdmission(headers({ authorization: 'Bearer user-jwt' }), ANON)).toEqual({ delegated: false })
  })

  it('a well-formed grant with the anon key as transport is admitted, and only the secret hash leaves', async () => {
    const r = await delegatedAdmission(headers(ok), ANON)
    expect(r.delegated && r.ok).toBe(true)
    expect(r.credentialId).toBe(ID)
    // sha256 of the 64-char hex string, as manage-entry-agent-credential stores it.
    expect(r.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.secretHash).not.toContain(SECRET)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it.each([
    ['blank', ''],
    ['uppercase uuid', `${ID.toUpperCase()}.${SECRET}`],
    ['short secret', `${ID}.${'a'.repeat(63)}`],
    ['long', `${ID}.${SECRET}a`],
    ['no dot', `${ID}${SECRET}`],
    ['comma-joined', `${ID}.${SECRET}, ${ID}.${SECRET}`],
    ['non-hex secret', `${ID}.${'g'.repeat(64)}`],
  ])('a present but malformed header (%s) commits the route and is refused', async (_label, value) => {
    const r = await delegatedAdmission(headers({ ...ok, 'x-trustflow-grant': value }), ANON)
    expect(r).toEqual({ delegated: true, ok: false, reason: 'malformed_grant' })
  })

  it('a repeated header is refused like a comma-joined one', async () => {
    const h = new Headers(ok)
    h.append('x-trustflow-grant', `${ID}.${SECRET}`)
    expect(await delegatedAdmission(h, ANON)).toEqual({ delegated: true, ok: false, reason: 'malformed_grant' })
  })

  it.each([
    ['a user JWT as bearer', { authorization: 'Bearer user-jwt' }],
    ['no bearer', { authorization: undefined }],
    ['a guest token alongside', { 'x-guest-access-token': 'guest' }],
  ])('mixed credentials (%s) are refused', async (_label, extra) => {
    const h = { ...ok, ...extra }
    if (extra.authorization === undefined) delete h.authorization
    expect(await delegatedAdmission(headers(h), ANON)).toEqual({ delegated: true, ok: false, reason: 'mixed_credentials' })
  })

  it('an unset anon key admits nothing (fails closed)', async () => {
    expect(await delegatedAdmission(headers({ ...ok, authorization: 'Bearer ' }), '')).toEqual(
      { delegated: true, ok: false, reason: 'mixed_credentials' })
  })
})

describe('refusalAnswer', () => {
  it('every authorization refusal is the same 403; gate states are 503; others are not refusals', () => {
    for (const s of ['malformed', 'grant_unknown', 'secret_mismatch', 'issuer_kind', 'issuer_not_owner',
      'revoked', 'expired', 'scope', 'allowlist']) expect(refusalAnswer(s)).toBe(DELEGATION_REFUSED)
    expect(refusalAnswer('gate_closed')).toBe(DELEGATED_UNAVAILABLE)
    expect(refusalAnswer('gate_missing')).toBe(DELEGATED_UNAVAILABLE)
    for (const s of ['ok', 'appended', 'context_changed', 'clock_window', 'reserved_fields_mismatch']) {
      expect(refusalAnswer(s)).toBeNull()
    }
  })
})
