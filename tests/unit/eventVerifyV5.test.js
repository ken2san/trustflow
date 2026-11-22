import { describe, it, expect } from 'vitest'
import {
  classifyStoredEvent, fromV5Transport, verifyV5EventHash, checkV5Link, checkV5Agreement,
  V5_AUTHORITY_FIELDS,
} from '../../supabase/functions/_shared/eventVerifyV5.ts'
import {
  canonicalVersionOf, eventCanonical, isSupportedHashVersion, sha256Hex,
} from '../../supabase/functions/_shared/eventCanonical.ts'

// Strict v5 read support (row 3 step 2, Task 182). Offline, pure. Legacy rows
// must classify exactly as before and v5 rows must never reach a legacy path.

const V4_PUBLISHED = {
  // public/agent-protocol.md, the published v4 reference vector.
  row: {
    id: '11111111-1111-4111-8111-111111111111', type: 'performance.asserted',
    contract_id: '22222222-2222-4222-8222-222222222222', actor_id: 'example',
    dod_hash: '1914672d421d9572fcfcda820a143c09908678597e48318cacdb9ea64b9a31cb',
    created_at: '2026-01-02T03:04:05.120Z', prev_event_hash: null,
    payload_hash: 'f18ebe1e0d7a693111ab8cfd8b4194740565c7abffaa8b26b1fe6fd21e565488',
    agreement_hash: '2e29fa574bd127507bdd992241d409062c4c1d254664934ad1326c9366b71f66',
    hash_version: 4,
  },
  hash: '64f2596df8167c2aaee5bebc196e41e7d2beff164bd919c967fcdcd12771f776',
}

const V5_ROW = {
  hash_version: 5,
  id: '55555555-5555-4555-8555-555555555555',
  type: 'payment.reported',
  contract_id: '22222222-2222-4222-8222-222222222222',
  actor_id: '66666666-6666-4666-8666-666666666666',
  dod_hash: '1914672d421d9572fcfcda820a143c09908678597e48318cacdb9ea64b9a31cb',
  created_at: '2026-01-02T04:04:06.123000+01:00',
  prev_event_hash: V4_PUBLISHED.hash,
  payload_hash: 'b22d2fb0c47093b39deedd0983ddb0cfb61ea9aac6b26f42d535c31ffb7807b8',
  agreement_hash: '2e29fa574bd127507bdd992241d409062c4c1d254664934ad1326c9366b71f66',
  credential_id: '77777777-7777-4777-8777-777777777777',
  issuer_kind: 'counterpart_account',
}
const V5_HASH = '2eaf0975f0beee45a3f4f7827fc24b7350077c282304b6f6f859922c6e278dd3'
const D = n => String(n).repeat(64)

describe('legacy v1–v4 are untouched', () => {
  it('the published v4 vector still recomputes through the unchanged legacy canonical', async () => {
    const version = canonicalVersionOf(V4_PUBLISHED.row)
    expect(version).toBe(4)
    expect(await sha256Hex(eventCanonical(V4_PUBLISHED.row, version))).toBe(V4_PUBLISHED.hash)
    expect(classifyStoredEvent(V4_PUBLISHED.row)).toEqual({ kind: 'legacy', version: 4 })
  })

  it('classifies every legacy shape exactly as canonicalVersionOf does', () => {
    const rows = [
      {}, { prev_event_hash: null }, { prev_event_hash: D('a') }, { hash_version: null },
      { hash_version: null, prev_event_hash: D('b') }, { hash_version: 1 }, { hash_version: 2 },
      { hash_version: 3 }, { hash_version: 4 }, { hash_version: 4, prev_event_hash: 'GENESIS' },
    ]
    for (const row of rows) {
      const v = canonicalVersionOf(row)
      expect(isSupportedHashVersion(v)).toBe(true)
      expect(classifyStoredEvent(row), JSON.stringify(row)).toEqual({ kind: 'legacy', version: v })
      // The additive authority columns will read back as null on legacy rows.
      expect(classifyStoredEvent({ ...row, credential_id: null, issuer_kind: null })).toEqual({ kind: 'legacy', version: v })
    }
  })

  it('unknown recorded versions stay unsupported, as before', () => {
    for (const v of [0, 6, 44, -1, '4', '5', 4.5]) {
      expect(classifyStoredEvent({ hash_version: v }), String(v)).toEqual({ kind: 'unsupported', version: v })
      expect(isSupportedHashVersion(canonicalVersionOf({ hash_version: v }))).toBe(false)
    }
  })

  it('the legacy module still does not support v5', () => {
    expect(isSupportedHashVersion(5)).toBe(false)
  })
})

describe('v5 rows never fall back to legacy', () => {
  it('a recorded 5 is v5, whatever else the row lacks', () => {
    expect(classifyStoredEvent(V5_ROW)).toEqual({ kind: 'v5' })
    expect(classifyStoredEvent({ hash_version: 5 })).toEqual({ kind: 'v5' })
    expect(classifyStoredEvent({ ...V5_ROW, prev_event_hash: null })).toEqual({ kind: 'v5' })
  })

  it('authority values on a row not recorded as 5 are invalid, never inferred legacy', () => {
    for (const field of V5_AUTHORITY_FIELDS) {
      for (const hash_version of [undefined, null, 1, 2, 3, 4, 6]) {
        const row = { ...V5_ROW, hash_version }
        for (const other of V5_AUTHORITY_FIELDS) if (other !== field) row[other] = null
        expect(classifyStoredEvent(row), `${field} ${hash_version}`).toMatchObject({ kind: 'invalid', field })
      }
    }
  })

  it('a v5 row missing its authority values is invalid input, not a legacy match', async () => {
    const stripped = { ...V5_ROW, credential_id: null, issuer_kind: null }
    expect(classifyStoredEvent(stripped)).toEqual({ kind: 'v5' })
    expect(await verifyV5EventHash(stripped, V5_HASH)).toMatchObject({ verdict: 'invalid_input' })
  })

  it('accessors are refused without being called', () => {
    for (const key of ['hash_version', 'credential_id', 'issuer_kind', 'prev_event_hash']) {
      let calls = 0
      const row = { hash_version: 4 }
      Object.defineProperty(row, key, { get() { calls += 1; return 5 } })
      expect(classifyStoredEvent(row), key).toMatchObject({ kind: 'invalid', field: key })
      expect(calls).toBe(0)
    }
    for (const bad of [null, undefined, 'x', [], 5]) expect(classifyStoredEvent(bad).kind).toBe('invalid')
  })
})

describe('shape and hash', () => {
  it('verifies the reference vector and separates mismatch from invalid input', async () => {
    expect(await verifyV5EventHash(V5_ROW, V5_HASH)).toEqual({ verdict: 'match', hash: V5_HASH })
    expect(await verifyV5EventHash({ ...V5_ROW, payload_hash: D('1') }, V5_HASH)).toMatchObject({ verdict: 'mismatch' })
    expect(await verifyV5EventHash({ ...V5_ROW, created_at: '2026-01-02T03:04:06' }, V5_HASH)).toMatchObject({ verdict: 'invalid_input', field: 'created_at' })
  })
})

describe('transport mapping', () => {
  it('maps prev_hash to prev_event_hash explicitly', async () => {
    const { prev_event_hash, ...rest } = V5_ROW
    const r = fromV5Transport({ ...rest, prev_hash: prev_event_hash })
    expect(r.ok).toBe(true)
    expect(r.row.prev_event_hash).toBe(prev_event_hash)
    expect('prev_hash' in r.row).toBe(false)
    expect(await verifyV5EventHash(r.row, V5_HASH)).toMatchObject({ verdict: 'match' })
  })

  it('accepts both spellings only when they agree', () => {
    expect(fromV5Transport({ ...V5_ROW, prev_hash: V5_ROW.prev_event_hash }).ok).toBe(true)
    expect(fromV5Transport({ ...V5_ROW, prev_hash: D('c') })).toEqual({ ok: false, field: 'prev_hash', reason: 'conflicts with prev_event_hash' })
    expect(fromV5Transport({ ...V5_ROW, prev_hash: null }).ok).toBe(false)
  })

  it('never defaults an absent predecessor', async () => {
    const { prev_event_hash: _omit, ...rest } = V5_ROW
    const r = fromV5Transport(rest)
    expect(r.ok).toBe(true)
    expect('prev_event_hash' in r.row).toBe(false)
    expect(await verifyV5EventHash(r.row, V5_HASH)).toMatchObject({ verdict: 'invalid_input', field: 'prev_event_hash' })
  })

  it('refuses accessors and non-objects, and does not mutate its input', () => {
    const block = { ...V5_ROW }
    Object.defineProperty(block, 'prev_hash', { enumerable: true, get() { throw new Error('called') } })
    expect(fromV5Transport(block)).toMatchObject({ ok: false, field: 'prev_hash' })
    for (const bad of [null, 'x', []]) expect(fromV5Transport(bad).ok).toBe(false)
    const input = { prev_hash: 'GENESIS' }
    fromV5Transport(input)
    expect(input).toEqual({ prev_hash: 'GENESIS' })
  })
})

describe('chain link', () => {
  it('links only to the supplied predecessor', () => {
    expect(checkV5Link(V5_ROW, V4_PUBLISHED.hash)).toBe('linked')
    expect(checkV5Link(V5_ROW, D('d'))).toBe('broken')
    expect(checkV5Link({ ...V5_ROW, prev_event_hash: 'GENESIS' }, 'GENESIS')).toBe('linked')
    expect(checkV5Link({ ...V5_ROW, prev_event_hash: 'GENESIS' }, V4_PUBLISHED.hash)).toBe('broken')
  })

  it('an unknown predecessor or a missing link is invalid input, never linked', () => {
    for (const expected of [null, undefined, '', 'genesis', D('A')]) {
      expect(checkV5Link(V5_ROW, expected), String(expected)).toBe('invalid_input')
    }
    for (const prev of [null, undefined, '', 'genesis']) {
      expect(checkV5Link({ ...V5_ROW, prev_event_hash: prev }, 'GENESIS'), String(prev)).toBe('invalid_input')
    }
    const { prev_event_hash: _omit, ...rest } = V5_ROW
    expect(checkV5Link(rest, 'GENESIS')).toBe('invalid_input')
    expect(checkV5Link(null, 'GENESIS')).toBe('invalid_input')
  })
})

describe('agreement', () => {
  it('explicit null is pre-acceptance, never a match', () => {
    expect(checkV5Agreement({ ...V5_ROW, agreement_hash: null }, V5_ROW.agreement_hash)).toBe('pre_acceptance')
    expect(checkV5Agreement({ ...V5_ROW, agreement_hash: null }, null)).toBe('pre_acceptance')
  })

  it('a cited digest is compared with the current agreement', () => {
    expect(checkV5Agreement(V5_ROW, V5_ROW.agreement_hash)).toBe('match')
    expect(checkV5Agreement(V5_ROW, D('e'))).toBe('mismatch')
  })

  it('missing citation or missing current agreement is invalid input', () => {
    const { agreement_hash: _omit, ...rest } = V5_ROW
    expect(checkV5Agreement(rest, V5_ROW.agreement_hash)).toBe('invalid_input')
    expect(checkV5Agreement({ ...V5_ROW, agreement_hash: undefined }, V5_ROW.agreement_hash)).toBe('invalid_input')
    for (const bad of ['', 'null', D('F'), 0]) {
      expect(checkV5Agreement({ ...V5_ROW, agreement_hash: bad }, V5_ROW.agreement_hash)).toBe('invalid_input')
    }
    for (const current of [null, undefined, '', D('G')]) {
      expect(checkV5Agreement(V5_ROW, current), String(current)).toBe('invalid_input')
    }
  })
})
