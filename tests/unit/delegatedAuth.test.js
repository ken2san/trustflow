import { describe, it, expect } from 'vitest'
import {
  DELEGATED_UNAVAILABLE, DELEGATION_REFUSED, delegatedAdmission, publishableKeys, refusalAnswer,
} from '../../supabase/functions/_shared/delegatedAuth.ts'

// Admission for x-trustflow-grant (rows 4a, 5b). The database decides
// authority; this only decides whether the request is delegated and carries an
// admissible transport: an active publishable key in `apikey`, no bearer.
const PUB = 'sb_publishable_testkeyAAAA'
const PUB2 = 'sb_publishable_rotatedBBBB'
const KEYS = [PUB]
const LEGACY_ANON_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig'
const ID = 'cccccccc-0000-4000-8000-000000000001'
const SECRET = 'a'.repeat(64)
const headers = (h) => new Headers(h)
const ok = { apikey: PUB, 'x-trustflow-grant': `${ID}.${SECRET}` }
const refused = (reason) => ({ delegated: true, ok: false, reason })

describe('publishableKeys', () => {
  it('takes the publishable string values of the platform object, deduplicated', () => {
    expect(publishableKeys(JSON.stringify({ default: PUB }))).toEqual([PUB])
    expect(publishableKeys(JSON.stringify({ default: PUB, web: PUB2, again: PUB }))).toEqual([PUB, PUB2])
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not JSON', 'sb_publishable_x'],
    ['an array', JSON.stringify([PUB])],
    ['a bare string', JSON.stringify(PUB)],
    ['null', 'null'],
    ['an empty object', '{}'],
  ])('a bad configuration (%s) yields no key, so admission fails closed', (_label, raw) => {
    expect(publishableKeys(raw)).toEqual([])
  })

  it('never takes a secret key, a legacy JWT, a bare prefix or a non-string', () => {
    expect(publishableKeys(JSON.stringify({
      s: 'sb_secret_abc', j: LEGACY_ANON_JWT, p: 'sb_publishable_', n: 5, o: { k: PUB }, ok: PUB,
    }))).toEqual([PUB])
  })
})

describe('delegatedAdmission', () => {
  it('no grant header: not delegated, whatever else is present', async () => {
    expect(await delegatedAdmission(headers({ authorization: 'Bearer user-jwt' }), KEYS)).toEqual({ delegated: false })
  })

  it('a well-formed grant with a publishable apikey and no bearer is admitted; only the secret hash leaves', async () => {
    const r = await delegatedAdmission(headers(ok), KEYS)
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
    const r = await delegatedAdmission(headers({ ...ok, 'x-trustflow-grant': value }), KEYS)
    expect(r).toEqual(refused('malformed_grant'))
  })

  it('a repeated header is refused like a comma-joined one', async () => {
    const h = new Headers(ok)
    h.append('x-trustflow-grant', `${ID}.${SECRET}`)
    expect(await delegatedAdmission(h, KEYS)).toEqual(refused('malformed_grant'))
  })

  it.each([
    ['a user JWT as bearer', { authorization: 'Bearer user-jwt' }],
    ['the legacy anon JWT as bearer', { authorization: `Bearer ${LEGACY_ANON_JWT}` }],
    ['the publishable key also as bearer', { authorization: `Bearer ${PUB}` }],
    ['an empty authorization header', { authorization: '' }],
    ['a guest token alongside', { 'x-guest-access-token': 'guest' }],
  ])('mixed credentials (%s) are refused, even with a valid apikey', async (_label, extra) => {
    expect(await delegatedAdmission(headers({ ...ok, ...extra }), KEYS)).toEqual(refused('mixed_credentials'))
  })

  it('the legacy anon JWT is not a transport in any header', async () => {
    expect(await delegatedAdmission(headers({ ...ok, apikey: LEGACY_ANON_JWT }), [...KEYS])).toEqual(refused('public_key'))
  })

  it.each([
    ['no apikey', undefined],
    ['an unknown publishable key (another project, or retired)', 'sb_publishable_otherproject'],
    ['a secret key', 'sb_secret_abc'],
    ['a prefix of the real key', PUB.slice(0, -1)],
    ['the real key with a suffix', `${PUB}x`],
    ['the real key in another case', PUB.toUpperCase()],
    // Surrounding whitespace is optional whitespace that Headers strip per the
    // fetch spec (as the wire does), so only an embedded change is a different key.
    ['an embedded space', `${PUB.slice(0, 5)} ${PUB.slice(5)}`],
  ])('a missing or unlisted apikey (%s) is refused', async (_label, apikey) => {
    const h = { ...ok, apikey }
    if (apikey === undefined) delete h.apikey
    expect(await delegatedAdmission(headers(h), KEYS)).toEqual(refused('public_key'))
  })

  it('a repeated apikey is refused (joined values match no key)', async () => {
    const h = new Headers(ok)
    h.append('apikey', PUB)
    expect(await delegatedAdmission(h, KEYS)).toEqual(refused('public_key'))
  })

  it('rotation: every listed key is accepted; a key no longer listed is refused', async () => {
    expect((await delegatedAdmission(headers({ ...ok, apikey: PUB2 }), [PUB, PUB2])).ok).toBe(true)
    expect(await delegatedAdmission(headers({ ...ok, apikey: PUB }), [PUB2])).toEqual(refused('public_key'))
  })

  it('an empty allowlist admits nothing (fails closed)', async () => {
    expect(await delegatedAdmission(headers(ok), [])).toEqual(refused('public_key'))
    expect(await delegatedAdmission(headers(ok), publishableKeys(undefined))).toEqual(refused('public_key'))
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
