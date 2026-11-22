import { describe, it, expect } from 'vitest'
import {
  V5_DOMAIN, V5_HASH_VERSION, V5_KEYS, V5_ISSUER_KINDS, buildEventCanonicalV5, canonicalTimestampV5,
  verifyEventHashV5,
} from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import {
  sha256Hex, payloadHash, deriveDodHash, eventCanonical, isSupportedHashVersion,
  SUPPORTED_HASH_VERSIONS,
} from '../../supabase/functions/_shared/eventCanonical.ts'

// The frozen v5 canonical (row 3 step 1, Task 178). Known answers are the two
// reference vectors in docs/v5-preimage-review.md (Codex T156, d53fc5e,
// confirmed by Kenji 2026-11-22). If one of these fails, the format changed —
// that is never a test to update, it is a broken contract.

const DOD = '1914672d421d9572fcfcda820a143c09908678597e48318cacdb9ea64b9a31cb'

const VECTOR_1 = {
  input: {
    hash_version: 5,
    id: '11111111-1111-4111-8111-111111111111',
    type: 'draft.note',
    contract_id: '22222222-2222-4222-8222-222222222222',
    actor_id: '33333333-3333-4333-8333-333333333333',
    dod_hash: DOD,
    created_at: '2026-01-02T03:04:05.120Z',
    prev_event_hash: 'GENESIS',
    payload_hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    agreement_hash: null,
    credential_id: '44444444-4444-4444-8444-444444444444',
    issuer_kind: 'owner_account',
  },
  preimage: '{"domain":"trustflow.event","hash_version":5,"id":"11111111-1111-4111-8111-111111111111","type":"draft.note","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"33333333-3333-4333-8333-333333333333","dod_hash":"1914672d421d9572fcfcda820a143c09908678597e48318cacdb9ea64b9a31cb","created_at":"2026-01-02T03:04:05.120Z","prev_hash":"GENESIS","payload_hash":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","agreement_hash":null,"credential_id":"44444444-4444-4444-8444-444444444444","issuer_kind":"owner_account"}',
  hash: 'abad5f987d155153b2aa429d9ffdc7109244ddff802998d0b1dbf9689dd7cb20',
}

const VECTOR_2 = {
  input: {
    hash_version: 5,
    id: '55555555-5555-4555-8555-555555555555',
    type: 'payment.reported',
    contract_id: '22222222-2222-4222-8222-222222222222',
    actor_id: '66666666-6666-4666-8666-666666666666',
    dod_hash: DOD,
    created_at: '2026-01-02T04:04:06.123000+01:00',
    prev_event_hash: '64f2596df8167c2aaee5bebc196e41e7d2beff164bd919c967fcdcd12771f776',
    payload_hash: 'b22d2fb0c47093b39deedd0983ddb0cfb61ea9aac6b26f42d535c31ffb7807b8',
    agreement_hash: '2e29fa574bd127507bdd992241d409062c4c1d254664934ad1326c9366b71f66',
    credential_id: '77777777-7777-4777-8777-777777777777',
    issuer_kind: 'counterpart_account',
  },
  preimage: '{"domain":"trustflow.event","hash_version":5,"id":"55555555-5555-4555-8555-555555555555","type":"payment.reported","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"66666666-6666-4666-8666-666666666666","dod_hash":"1914672d421d9572fcfcda820a143c09908678597e48318cacdb9ea64b9a31cb","created_at":"2026-01-02T03:04:06.123Z","prev_hash":"64f2596df8167c2aaee5bebc196e41e7d2beff164bd919c967fcdcd12771f776","payload_hash":"b22d2fb0c47093b39deedd0983ddb0cfb61ea9aac6b26f42d535c31ffb7807b8","agreement_hash":"2e29fa574bd127507bdd992241d409062c4c1d254664934ad1326c9366b71f66","credential_id":"77777777-7777-4777-8777-777777777777","issuer_kind":"counterpart_account"}',
  hash: '2eaf0975f0beee45a3f4f7827fc24b7350077c282304b6f6f859922c6e278dd3',
}

const canonicalOf = input => {
  const r = buildEventCanonicalV5(input)
  if (!r.ok) throw new Error(`unexpected invalid input: ${r.field} ${r.reason}`)
  return r.canonical
}
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))

describe('v5 reference vectors (known answers)', () => {
  for (const [name, v] of [['vector 1: owner, draft, genesis', VECTOR_1], ['vector 2: counterpart, snapshot, v4 predecessor', VECTOR_2]]) {
    it(`${name}: exact preimage bytes and digest`, async () => {
      expect(canonicalOf(v.input)).toBe(v.preimage)
      expect(await sha256Hex(v.preimage)).toBe(v.hash)
      expect(await verifyEventHashV5(v.input, v.hash)).toEqual({ verdict: 'match', hash: v.hash })
    })
  }

  it('the sub-digests come from the existing DoD and payload encodings', async () => {
    expect(await deriveDodHash(['Translate'])).toBe(DOD)
    expect(await payloadHash({})).toBe(VECTOR_1.input.payload_hash)
    // Sorted keys put amount first; "café" is hashed as UTF-8.
    expect(await payloadHash({ note: 'café', amount: 1250 })).toBe(VECTOR_2.input.payload_hash)
    expect(await payloadHash({ note: 'café', amount: 1250 })).not.toBe(VECTOR_2.input.payload_hash)
  })
})

describe('v5 key order and encoding', () => {
  it('emits exactly the 13 keys, once each, in the frozen order', () => {
    expect(Object.keys(JSON.parse(VECTOR_1.preimage))).toEqual([...V5_KEYS])
    expect(V5_KEYS).toHaveLength(13)
    expect(V5_DOMAIN).toBe('trustflow.event')
    expect(V5_HASH_VERSION).toBe(5)
  })

  it('does not depend on the input object key order', () => {
    const reversed = Object.fromEntries(Object.entries(VECTOR_2.input).reverse())
    expect(canonicalOf(reversed)).toBe(VECTOR_2.preimage)
  })

  it('any other byte layout of the same values is a different digest', async () => {
    const parsed = JSON.parse(VECTOR_1.preimage)
    const variants = [
      JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())),
      JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)))),
      JSON.stringify(parsed, null, 2),
      VECTOR_1.preimage + '\n',
      '﻿' + VECTOR_1.preimage,
      VECTOR_1.preimage.replace('"hash_version":5', '"hash_version":"5"'),
      VECTOR_1.preimage.replace('"hash_version":5', '"hash_version":5.0'),
      VECTOR_1.preimage.replace('"trustflow.event"', '"trustflow.events"'),
      VECTOR_1.preimage.replace('"domain":"trustflow.event",', ''),
      VECTOR_1.preimage.replace('"agreement_hash":null', '"agreement_hash":""'),
    ]
    for (const bytes of variants) {
      expect(bytes).not.toBe(VECTOR_1.preimage)
      expect(await sha256Hex(bytes)).not.toBe(VECTOR_1.hash)
    }
  })

  it('every single-field change moves the digest', async () => {
    const changes = {
      id: '11111111-1111-4111-8111-111111111112',
      type: 'draft.notes',
      contract_id: '22222222-2222-4222-8222-222222222223',
      actor_id: '33333333-3333-4333-8333-333333333334',
      dod_hash: '0'.repeat(64),
      created_at: '2026-01-02T03:04:05.121Z',
      prev_event_hash: 'f'.repeat(64),
      payload_hash: '1'.repeat(64),
      agreement_hash: '2'.repeat(64),
      credential_id: '44444444-4444-4444-8444-444444444445',
      issuer_kind: 'counterpart_account',
    }
    for (const [key, value] of Object.entries(changes)) {
      const v = await verifyEventHashV5({ ...VECTOR_1.input, [key]: value }, VECTOR_1.hash)
      expect(v.verdict, key).toBe('mismatch')
    }
  })
})

describe('v5 presence, null and typing', () => {
  const REQUIRED = Object.keys(VECTOR_1.input)

  it('every input is required as an own property', () => {
    for (const key of REQUIRED) {
      expect(buildEventCanonicalV5(without(VECTOR_1.input, key)), key).toEqual({ ok: false, field: key, reason: 'missing' })
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: undefined }), key).toMatchObject({ ok: false, field: key })
      const inherited = Object.create(VECTOR_1.input)
      expect(buildEventCanonicalV5(Object.assign(inherited, without(VECTOR_1.input, key))), key)
        .toMatchObject({ ok: false, field: key, reason: 'missing' })
    }
  })

  it('only agreement_hash may be null; nothing substitutes for null or a digest', () => {
    for (const key of REQUIRED.filter(k => k !== 'agreement_hash')) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: null }), key).toMatchObject({ ok: false, field: key })
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: '' }), key).toMatchObject({ ok: false, field: key })
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: 0 }), key).toMatchObject({ ok: false, field: key })
    }
    for (const bad of ['', 0, 'null', '0'.repeat(63), 'A'.repeat(64), false]) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, agreement_hash: bad })).toMatchObject({ ok: false, field: 'agreement_hash' })
    }
  })

  it('a null or missing predecessor never becomes GENESIS', () => {
    expect(buildEventCanonicalV5({ ...VECTOR_1.input, prev_event_hash: null })).toMatchObject({ ok: false, field: 'prev_event_hash' })
    expect(buildEventCanonicalV5(without(VECTOR_1.input, 'prev_event_hash'))).toMatchObject({ ok: false, field: 'prev_event_hash' })
    for (const bad of ['genesis', ' GENESIS', 'GENESIS ', '']) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, prev_event_hash: bad })).toMatchObject({ ok: false, field: 'prev_event_hash' })
    }
  })

  it('hash_version must be the number 5', () => {
    for (const bad of ['5', 4, 6, 1, 0, 5.5, null, NaN, '05']) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, hash_version: bad }), String(bad)).toMatchObject({ ok: false, field: 'hash_version' })
    }
  })

  it('the domain is optional on input, but only as the exact constant', () => {
    expect(canonicalOf({ ...VECTOR_1.input, domain: 'trustflow.event' })).toBe(VECTOR_1.preimage)
    for (const bad of ['trustflow.events', 'TrustFlow.event', ' trustflow.event', '', null, undefined]) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, domain: bad }), String(bad)).toMatchObject({ ok: false, field: 'domain' })
    }
  })

  it('UUIDs are lowercase 8-4-4-4-12 with no case folding or trimming', () => {
    const id = VECTOR_1.input.id
    for (const bad of ['aaaaaaaa-1111-4111-8111-111111111111'.toUpperCase(), ` ${id}`, `${id} `, id.replace(/-/g, ''), `{${id}}`, 'A1111111-1111-4111-8111-111111111111']) {
      for (const key of ['id', 'contract_id', 'actor_id', 'credential_id']) {
        expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: bad }), `${key} ${bad}`).toMatchObject({ ok: false, field: key })
      }
    }
  })

  it('digests are lowercase 64-hex', () => {
    for (const bad of ['A'.repeat(64), '0'.repeat(63), '0'.repeat(65), ` ${'0'.repeat(64)}`, 'g'.repeat(64)]) {
      for (const key of ['dod_hash', 'payload_hash', 'prev_event_hash', 'agreement_hash']) {
        expect(buildEventCanonicalV5({ ...VECTOR_1.input, [key]: bad }), key).toMatchObject({ ok: false, field: key })
      }
    }
  })

  it('event type is a nonempty ASCII dotted identifier', () => {
    for (const ok of ['draft.note', 'contract.accepted_v2', 'a.b1.c_d', 'a.b']) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, type: ok }).ok, ok).toBe(true)
    }
    for (const bad of ['a', 'draft', 'payment_reported', '', 'Draft.note', 'draft..note', '.draft', 'draft.', '1draft', 'draft.1note', 'draft note', 'dráft.note', 'draft-note', '_draft']) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, type: bad }), bad).toMatchObject({ ok: false, field: 'type' })
    }
  })

  it('issuer kind is exactly owner_account or counterpart_account', () => {
    for (const bad of ['owner', 'Owner_account', 'owner_account ', 'counterparty_account', 'guest']) {
      expect(buildEventCanonicalV5({ ...VECTOR_1.input, issuer_kind: bad }), bad).toMatchObject({ ok: false, field: 'issuer_kind' })
    }
  })

  it('the issuer allowlist cannot be widened from JS', () => {
    expect(Object.isFrozen(V5_ISSUER_KINDS)).toBe(true)
    expect(() => V5_ISSUER_KINDS.push('guest')).toThrow()
    expect(() => { V5_ISSUER_KINDS[0] = 'guest' }).toThrow()
    expect(buildEventCanonicalV5({ ...VECTOR_1.input, issuer_kind: 'guest' })).toMatchObject({ ok: false, field: 'issuer_kind' })
  })

  it('refuses accessor properties without calling them', () => {
    for (const key of [...REQUIRED, 'domain']) {
      let calls = 0
      const input = { ...VECTOR_1.input }
      const value = key === 'domain' ? 'trustflow.event' : input[key]
      delete input[key]
      Object.defineProperty(input, key, { enumerable: true, get() { calls += 1; return value } })
      expect(buildEventCanonicalV5(input), key).toEqual({ ok: false, field: key, reason: 'not a data property' })
      expect(calls, key).toBe(0)
    }
  })

  it('reads each value once, so a changing source cannot validate one value and emit another', () => {
    const reads = {}
    const proxy = new Proxy({ ...VECTOR_1.input }, {
      getOwnPropertyDescriptor(target, key) {
        reads[key] = (reads[key] ?? 0) + 1
        const desc = Reflect.getOwnPropertyDescriptor(target, key)
        // A second read of type would come back undotted; it must never happen.
        if (key === 'type' && desc && reads[key] > 1) return { ...desc, value: 'x' }
        return desc
      },
    })
    expect(canonicalOf(proxy)).toBe(VECTOR_1.preimage)
    for (const key of Object.keys(VECTOR_1.input)) expect(reads[key], key).toBe(1)
    const throwing = new Proxy({ ...VECTOR_1.input }, { getOwnPropertyDescriptor() { throw new Error('trap') } })
    expect(buildEventCanonicalV5(throwing)).toMatchObject({ ok: false, reason: 'not a data property' })
  })

  it('non-object inputs are invalid', () => {
    for (const bad of [null, undefined, 'x', 5, [], [VECTOR_1.input]]) {
      expect(buildEventCanonicalV5(bad).ok).toBe(false)
    }
  })
})

describe('v5 timestamps', () => {
  it('normalises accepted readback forms to UTC with exactly three digits', () => {
    for (const [input, out] of [
      ['2026-01-02T04:04:06.123000+01:00', '2026-01-02T03:04:06.123Z'],
      ['2026-01-02T03:04:05.12Z', '2026-01-02T03:04:05.120Z'],
      ['2026-01-02T03:04:05Z', '2026-01-02T03:04:05.000Z'],
      ['2026-01-02T03:04:05.1+00:00', '2026-01-02T03:04:05.100Z'],
      ['2026-01-01T00:30:00.000+01:00', '2025-12-31T23:30:00.000Z'],
      ['2026-12-31T23:30:00.000-01:00', '2027-01-01T00:30:00.000Z'],
      ['2024-02-29T12:00:00.000Z', '2024-02-29T12:00:00.000Z'],
      ['2000-02-29T12:00:00.000Z', '2000-02-29T12:00:00.000Z'],
      ['0001-01-01T00:00:00.000Z', '0001-01-01T00:00:00.000Z'],
      ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
      ['2026-01-02T03:04:05.123+23:59', '2026-01-01T03:05:05.123Z'],
    ]) {
      expect(canonicalTimestampV5(input), input).toBe(out)
    }
  })

  it('rejects invalid, timezone-less, imprecise or out-of-range values', () => {
    for (const bad of [
      '2026-01-02T03:04:05.123', '2026-01-02 03:04:05.123Z', '2026-01-02t03:04:05.123Z',
      '2026-01-02T03:04:05.123z', '2026-01-02T03:04:05.1234Z', '2026-01-02T03:04:05.123001Z',
      '2026-01-02T03:04:05.1234567Z', '2026-01-02T03:04:05.Z', '2026-02-30T00:00:00Z',
      '2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z',
      '2026-01-00T00:00:00Z', '2026-01-02T24:00:00Z', '2026-01-02T23:60:00Z', '2026-12-31T23:59:60Z',
      '0000-01-01T00:00:00Z', '0001-01-01T00:30:00+01:00', '9999-12-31T23:30:00-01:00',
      '+002026-01-02T03:04:05Z', '2026-01-02T03:04:05-00:00', '2026-01-02T03:04:05+24:00',
      '2026-01-02T03:04:05+01:60', '2026-01-02T03:04:05+0100', '2026-01-02T03:04:05+01',
      '2026-1-2T03:04:05Z', ' 2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z ', '', 'not a date',
      null, undefined, 1767323045120, new Date(0),
    ]) {
      expect(canonicalTimestampV5(bad), String(bad)).toBeNull()
    }
  })

  it('an unacceptable timestamp is invalid input, never hashed as given', async () => {
    const v = await verifyEventHashV5({ ...VECTOR_1.input, created_at: '2026-01-02T03:04:05.1201Z' }, VECTOR_1.hash)
    expect(v).toMatchObject({ verdict: 'invalid_input', field: 'created_at' })
  })
})

describe('v5 verdicts', () => {
  it('a malformed stored hash is invalid input, not a mismatch', async () => {
    for (const bad of [null, undefined, '', VECTOR_1.hash.toUpperCase(), VECTOR_1.hash.slice(1)]) {
      expect(await verifyEventHashV5(VECTOR_1.input, bad)).toMatchObject({ verdict: 'invalid_input', field: 'event_hash' })
    }
  })

  it('valid complete inputs with a different digest are a mismatch', async () => {
    expect(await verifyEventHashV5(VECTOR_1.input, VECTOR_2.hash)).toEqual({ verdict: 'mismatch', hash: VECTOR_1.hash })
  })

  it('a malformed v5 row never falls back to a legacy verdict', async () => {
    const legacyShaped = without(without(VECTOR_1.input, 'credential_id'), 'issuer_kind')
    expect(await verifyEventHashV5(legacyShaped, VECTOR_1.hash)).toMatchObject({ verdict: 'invalid_input' })
  })
})

describe('v1–v4 are untouched and v5 is not enabled', () => {
  it('the legacy module still supports exactly v1–v4 and refuses 5', () => {
    expect([...SUPPORTED_HASH_VERSIONS]).toEqual([1, 2, 3, 4])
    expect(isSupportedHashVersion(5)).toBe(false)
    expect(() => eventCanonical({ ...VECTOR_1.input, prev_event_hash: 'GENESIS' }, 5)).toThrow(/unsupported canonical version 5/)
  })
})
