import { describe, it, expect } from 'vitest'
import {
  classifyStoredEvent, fromV5Transport, verifyV5EventHash, checkV5Link, checkV5Agreement,
  verifyEvidenceSlice, V5_AUTHORITY_FIELDS, V5_PROJECTION_FIELDS,
} from '../../supabase/functions/_shared/eventVerifyV5.ts'
import {
  canonicalVersionOf, eventCanonical, isSupportedHashVersion, sha256Hex, payloadHash,
  HASH_VERSION, SUPPORTED_HASH_VERSIONS,
} from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildEventCanonicalV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import { ACCEPTANCE_TYPE } from '../../supabase/functions/_shared/eventRecord.ts'

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

describe('3A: projection contract and version indicators', () => {
  const projectedLegacy = { hash_version: 4, prev_event_hash: 'GENESIS', credential_id: null, issuer_kind: null }

  it('a projected row must carry version, predecessor and both authority fields', () => {
    expect(classifyStoredEvent(projectedLegacy, { projected: true })).toEqual({ kind: 'legacy', version: 4 })
    for (const key of V5_PROJECTION_FIELDS) {
      const { [key]: _omit, ...rest } = projectedLegacy
      expect(classifyStoredEvent(rest, { projected: true }), key)
        .toEqual({ kind: 'invalid', field: key, reason: 'projection dropped a required field' })
      expect(classifyStoredEvent({ ...projectedLegacy, [key]: undefined }, { projected: true }), key)
        .toMatchObject({ kind: 'invalid', field: key })
    }
    // Losing version and both authority fields together looks legacy unprojected, and is caught projected.
    const stripped = { prev_event_hash: V4_PUBLISHED.hash }
    expect(classifyStoredEvent(stripped)).toEqual({ kind: 'legacy', version: 2 })
    expect(classifyStoredEvent(stripped, { projected: true })).toMatchObject({ kind: 'invalid' })
  })

  it('an incomplete v5 row is a candidate, never a match', async () => {
    const incomplete = { ...V5_ROW, issuer_kind: null }
    expect(classifyStoredEvent(incomplete, { projected: true })).toEqual({ kind: 'v5' })
    expect(await verifyV5EventHash(incomplete, V5_HASH)).toMatchObject({ verdict: 'invalid_input', field: 'issuer_kind' })
  })

  it('inconsistent explicit version indicators are invalid; a supplied flag is never trusted', () => {
    expect(classifyStoredEvent({ ...V5_ROW, canonical_version: 5 })).toEqual({ kind: 'v5' })
    expect(classifyStoredEvent({ ...V5_ROW, canonical_version: 4 })).toMatchObject({ kind: 'invalid', field: 'canonical_version' })
    expect(classifyStoredEvent({ hash_version: 4, canonical_version: 5 })).toMatchObject({ kind: 'invalid', field: 'canonical_version' })
    expect(classifyStoredEvent({ canonical_version: 4 })).toMatchObject({ kind: 'invalid', field: 'canonical_version' })
    expect(classifyStoredEvent({ hash_version: 4, canonical_version: '4' })).toMatchObject({ kind: 'invalid' })
    expect(classifyStoredEvent({ hash_version: 7, canonical_version_supported: true })).toEqual({ kind: 'unsupported', version: 7 })
  })

  it('inherited values are not read', () => {
    const inherited = Object.create({ hash_version: 5, credential_id: V5_ROW.credential_id })
    inherited.prev_event_hash = 'GENESIS'
    expect(classifyStoredEvent(inherited)).toEqual({ kind: 'legacy', version: 2 })
    expect(classifyStoredEvent(inherited, { projected: true })).toMatchObject({ kind: 'invalid', field: 'hash_version' })
  })
})

describe('3A: transport copy is allowlisted and prototype-free', () => {
  it('a JSON block with __proto__ and hostile names cannot change the copy', async () => {
    const json = JSON.stringify({ ...V5_ROW, prev_hash: V5_ROW.prev_event_hash, prev_event_hash: undefined })
      .replace('{', '{"__proto__":{"credential_id":"x","hash_version":4},"constructor":1,"toString":2,"hasOwnProperty":3,')
    const block = JSON.parse(json)
    expect(Object.prototype.hasOwnProperty.call(block, '__proto__')).toBe(true)
    const r = fromV5Transport(block)
    expect(r.ok).toBe(true)
    expect(Object.getPrototypeOf(r.row)).toBe(null)
    expect(Object.keys(r.row).sort()).toEqual(Object.keys({ ...V5_ROW }).sort())
    expect(r.row.credential_id).toBe(V5_ROW.credential_id)
    expect(await verifyV5EventHash(r.row, V5_HASH)).toMatchObject({ verdict: 'match' })
  })

  it('missing canonical fields stay missing, explicit null stays null', async () => {
    const { credential_id: _omit, ...rest } = V5_ROW
    const r = fromV5Transport(JSON.parse(JSON.stringify({ ...rest, agreement_hash: null })))
    expect('credential_id' in r.row).toBe(false)
    expect(r.row.agreement_hash).toBe(null)
    expect(await verifyV5EventHash(r.row, V5_HASH)).toMatchObject({ verdict: 'invalid_input', field: 'credential_id' })
  })

  it('accessors on unknown keys are never read; on known keys they are refused', () => {
    let calls = 0
    const block = { ...V5_ROW }
    Object.defineProperty(block, 'hostile', { enumerable: true, get() { calls += 1; return 1 } })
    expect(fromV5Transport(block).ok).toBe(true)
    expect(calls).toBe(0)
    Object.defineProperty(block, 'issuer_kind', { enumerable: true, get() { calls += 1; return 'owner_account' } })
    expect(fromV5Transport(block)).toMatchObject({ ok: false, field: 'issuer_kind' })
    expect(calls).toBe(0)
  })
})

describe('3A: link check', () => {
  it('GENESIS links only at a known chain start', () => {
    const genesis = { ...V5_ROW, prev_event_hash: 'GENESIS' }
    expect(checkV5Link(genesis, { kind: 'chain_start' })).toBe('linked')
    expect(checkV5Link(genesis, { kind: 'after', hash: V4_PUBLISHED.hash })).toBe('broken')
    expect(checkV5Link(genesis, { kind: 'unknown_boundary' })).toBe('indeterminate')
  })

  it('later links compare with the observed preceding hash', () => {
    expect(checkV5Link(V5_ROW, { kind: 'after', hash: V4_PUBLISHED.hash })).toBe('linked')
    expect(checkV5Link(V5_ROW, { kind: 'after', hash: D('d') })).toBe('broken')
    expect(checkV5Link(V5_ROW, { kind: 'chain_start' })).toBe('broken')
    expect(checkV5Link(V5_ROW, { kind: 'unknown_boundary' })).toBe('indeterminate')
  })

  it('a missing or malformed link, or a malformed expectation, is invalid input', () => {
    for (const prev of [null, undefined, '', 'genesis', D('A')]) {
      expect(checkV5Link({ ...V5_ROW, prev_event_hash: prev }, { kind: 'chain_start' }), String(prev)).toBe('invalid_input')
    }
    for (const exp of [null, undefined, {}, { kind: 'after', hash: null }, { kind: 'after', hash: 'GENESIS' }, 'GENESIS']) {
      expect(checkV5Link(V5_ROW, exp), JSON.stringify(exp)).toBe('invalid_input')
    }
  })
})

describe('3A: agreement check', () => {
  const draft = { ...V5_ROW, agreement_hash: null }
  const accepted = V5_ROW.agreement_hash

  it('explicit null alone is "no cited digest"; pre-acceptance needs a known earlier position', () => {
    expect(checkV5Agreement(draft, { position: 'unknown' })).toBe('no_cited_digest')
    expect(checkV5Agreement(draft, { position: 'before_acceptance' })).toBe('pre_acceptance')
    expect(checkV5Agreement(draft, { position: 'acceptance_or_after', acceptedAgreementHash: accepted })).toBe('invalid')
  })

  it('a cited digest is compared with the accepted snapshot, never assumed', () => {
    expect(checkV5Agreement(V5_ROW, { position: 'acceptance_or_after', acceptedAgreementHash: accepted })).toBe('match')
    // Equality at an unknown position is not legality (Codex T164).
    expect(checkV5Agreement(V5_ROW, { position: 'unknown', acceptedAgreementHash: accepted })).toBe('match_position_unknown')
    expect(checkV5Agreement(V5_ROW, { position: 'unknown', acceptedAgreementHash: D('e') })).toBe('mismatch')
    expect(checkV5Agreement(V5_ROW, { position: 'acceptance_or_after', acceptedAgreementHash: D('e') })).toBe('mismatch')
    expect(checkV5Agreement(V5_ROW, { position: 'acceptance_or_after' })).toBe('indeterminate')
    expect(checkV5Agreement(V5_ROW, { position: 'before_acceptance', acceptedAgreementHash: accepted })).toBe('invalid')
  })

  it('a missing or malformed citation is invalid input', () => {
    const { agreement_hash: _omit, ...rest } = V5_ROW
    expect(checkV5Agreement(rest, { position: 'unknown' })).toBe('invalid_input')
    for (const bad of [undefined, '', 'null', D('F'), 0]) {
      expect(checkV5Agreement({ ...V5_ROW, agreement_hash: bad }, { position: 'unknown' })).toBe('invalid_input')
    }
    expect(checkV5Agreement(null, { position: 'unknown' })).toBe('invalid_input')
  })
})

// ── Slice fixtures: real hashes for a v4 → v5 → v4 chain ────────────────────
const CID = '22222222-2222-4222-8222-222222222222'
const GRANT = '77777777-7777-4777-8777-777777777777'
const ACCEPTED = '2e29fa574bd127507bdd992241d409062c4c1d254664934ad1326c9366b71f66'
let clock = Date.parse('2026-01-02T03:04:05.000Z')
const nextTime = () => new Date((clock += 1000)).toISOString()
const uuid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

async function legacyRow(n, prev, { version = 4, hashed = true, agreement = ACCEPTED, payload = { n }, type = 'note.legacy' } = {}) {
  const row = {
    id: uuid(n), type, contract_id: CID, actor_id: 'owner', dod_hash: D('1'), created_at: nextTime(),
    prev_event_hash: prev, payload, payload_hash: version >= 3 ? await payloadHash(payload) : null,
    agreement_hash: version >= 4 ? agreement : null, hash_version: version, credential_id: null, issuer_kind: null,
  }
  row.event_hash = hashed ? await sha256Hex(eventCanonical(row, version)) : null
  return row
}
async function v5Row(n, prev, { agreement = ACCEPTED, payload = { n }, kind = 'owner_account', type = 'payment.reported' } = {}) {
  const row = {
    id: uuid(n), type, contract_id: CID, actor_id: uuid(6), dod_hash: D('1'), created_at: nextTime(),
    prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement,
    hash_version: 5, credential_id: GRANT, issuer_kind: kind,
  }
  const built = buildEventCanonicalV5(row)
  if (!built.ok) throw new Error(built.field)
  row.event_hash = await sha256Hex(built.canonical)
  return row
}
async function mixedChain() {
  // The first row is a real acceptance event (ACCEPTANCE_TYPE), as in the live writer.
  const a = await legacyRow(1, 'GENESIS', { type: ACCEPTANCE_TYPE })
  const b = await v5Row(2, a.event_hash)
  const c = await legacyRow(3, b.event_hash)
  return [a, b, c]
}
// 'unknown' lets the slice place acceptance from its own ordered rows.
const COMPLETE = { startsAtChainStart: true, tailComplete: true, acceptance: 'unknown', acceptedAgreementHash: ACCEPTED,
  legacyAgreementHash: ACCEPTED, projected: true }

describe('3A: per-reader aggregation over a slice', () => {
  it('v4 → v5 → v4 with real hashes verifies, every check reported per row', async () => {
    const r = await verifyEvidenceSlice(await mixedChain(), { ...COMPLETE, acceptance: { index: 0 } })
    expect(r.acceptance).toEqual({ status: 'caller', index: 0 })
    expect((await verifyEvidenceSlice(await mixedChain(), COMPLETE)).acceptance).toEqual({ status: 'derived', index: 0 })
    expect(r.rows.map(x => [x.kind, x.hash, x.link, x.payload, x.agreement])).toEqual([
      ['legacy', 'match', 'linked', 'match', 'match'],
      ['v5', 'match', 'linked', 'match', 'match'],
      ['legacy', 'match', 'linked', 'match', 'match'],
    ])
    expect(r.dimensions).toEqual({ hash: 'pass', link: 'pass', payload: 'pass', agreement: 'pass', completeness: 'pass' })
    expect(r.overall).toBe('verified')
  })

  it('an initially unhashed legacy event is not a failure, keeps the chain start, and is never proof', async () => {
    const a = await legacyRow(1, null, { version: 1, hashed: false })
    const b = await v5Row(2, 'GENESIS', { agreement: null })
    const r = await verifyEvidenceSlice([a, b], { ...COMPLETE, acceptance: 'none' })
    expect(r.rows.map(x => [x.hash, x.link, x.agreement])).toEqual([
      ['pre_chain', 'not_in_format', 'not_bound'],
      ['match', 'linked', 'pre_acceptance'],
    ])
    expect(r.dimensions.hash).toBe('indeterminate')
    expect(r.overall).toBe('incomplete')
  })

  it('a valid v5 draft null is pre-acceptance only when position is known', async () => {
    const a = await v5Row(1, 'GENESIS', { agreement: null })
    expect((await verifyEvidenceSlice([a], { ...COMPLETE, acceptance: 'none' })).rows[0].agreement).toBe('pre_acceptance')
    const unknown = await verifyEvidenceSlice([a], { ...COMPLETE, acceptance: 'unknown' })
    expect(unknown.rows[0].agreement).toBe('no_cited_digest')
    expect(unknown.dimensions.agreement).toBe('indeterminate')
    expect(unknown.overall).toBe('incomplete')
  })

  it('a null digest on or after a known acceptance fails', async () => {
    const a = await legacyRow(1, 'GENESIS', { type: ACCEPTANCE_TYPE })
    const b = await v5Row(2, a.event_hash, { agreement: null })
    for (const acceptance of [{ index: 0 }, 'unknown']) {
      const r = await verifyEvidenceSlice([a, b], { ...COMPLETE, acceptance })
      expect(r.rows[1].agreement, JSON.stringify(acceptance)).toBe('invalid')
      expect(r.overall).toBe('failed')
    }
    // The acceptance event itself citing null.
    const acc = await v5Row(3, 'GENESIS', { agreement: null, type: ACCEPTANCE_TYPE })
    expect((await verifyEvidenceSlice([acc], COMPLETE)).rows[0].agreement).toBe('invalid')
    // A slice that starts after acceptance.
    const r = await verifyEvidenceSlice([b], { ...COMPLETE, startsAtChainStart: false, acceptance: 'before_slice' })
    expect(r.rows[0].agreement).toBe('invalid')
    expect(r.overall).toBe('failed')
  })

  it('a valid hash with a bad link fails on the link only', async () => {
    const [a, , c] = await mixedChain()
    const b = await v5Row(2, D('9'))
    const r = await verifyEvidenceSlice([a, b, c], COMPLETE)
    expect(r.rows[1].hash).toBe('match')
    expect(r.rows[1].link).toBe('broken')
    expect(r.rows[2].link).toBe('broken')
    expect(r.dimensions.hash).toBe('pass')
    expect(r.dimensions.link).toBe('fail')
    expect(r.overall).toBe('failed')
  })

  it('a changed authority value with a stale stored hash is a hash mismatch', async () => {
    const chain = await mixedChain()
    for (const change of [{ credential_id: uuid(8) }, { issuer_kind: 'counterpart_account' }]) {
      const rows = [chain[0], { ...chain[1], ...change }, chain[2]]
      const r = await verifyEvidenceSlice(rows, COMPLETE)
      expect(r.rows[1].hash, JSON.stringify(change)).toBe('mismatch')
      expect(r.rows[1].link).toBe('linked')
      expect(r.overall).toBe('failed')
    }
  })

  it('unsupported and malformed rows are reported, never skipped into a pass', async () => {
    const [a, b, c] = await mixedChain()
    const unsupported = { ...c, hash_version: 7 }
    const r1 = await verifyEvidenceSlice([a, b, unsupported], COMPLETE)
    expect(r1.rows).toHaveLength(3)
    expect(r1.rows[2]).toMatchObject({ kind: 'unsupported', hash: 'unsupported' })
    expect(r1.overall).toBe('incomplete')

    const malformed = { ...b, created_at: '2026-01-02' }
    const r2 = await verifyEvidenceSlice([a, malformed, c], COMPLETE)
    expect(r2.rows[1]).toMatchObject({ kind: 'v5', hash: 'invalid_input' })
    expect(r2.overall).toBe('failed')

    const legacyShaped = { ...b, hash_version: 4 }
    const r3 = await verifyEvidenceSlice([a, legacyShaped, c], COMPLETE)
    expect(r3.rows[1]).toMatchObject({ kind: 'invalid', hash: 'invalid_input' })
    expect(r3.overall).toBe('failed')
  })

  it('a missing predecessor boundary is indeterminate, and later links still compare', async () => {
    const [, b, c] = await mixedChain()
    const r = await verifyEvidenceSlice([b, c], { ...COMPLETE, startsAtChainStart: false })
    expect(r.rows.map(x => x.link)).toEqual(['indeterminate', 'linked'])
    expect(r.dimensions.completeness).toBe('indeterminate')
    expect(r.overall).toBe('incomplete')
    const broken = { ...c, prev_event_hash: D('7') }
    const r2 = await verifyEvidenceSlice([b, broken], { ...COMPLETE, startsAtChainStart: false })
    expect(r2.rows[1].link).toBe('broken')
    expect(r2.overall).toBe('failed')
  })

  it('a truncated tail is never verified', async () => {
    const r = await verifyEvidenceSlice((await mixedChain()).slice(0, 2), { ...COMPLETE, tailComplete: false })
    expect(r.dimensions).toMatchObject({ hash: 'pass', link: 'pass', completeness: 'indeterminate' })
    expect(r.overall).toBe('incomplete')
    expect((await verifyEvidenceSlice([], COMPLETE)).overall).toBe('incomplete')
  })

  it('a known mismatch stays visible while another check is indeterminate', async () => {
    const chain = await mixedChain()
    const tampered = { ...chain[1], payload: { n: 999 } }
    const r = await verifyEvidenceSlice([chain[0], tampered, chain[2]], { ...COMPLETE, acceptance: 'unknown', tailComplete: false })
    expect(r.rows[1].payload).toBe('mismatch')
    expect(r.dimensions.payload).toBe('fail')
    expect(r.dimensions.completeness).toBe('indeterminate')
    expect(r.overall).toBe('failed')
  })

  it('a payload the reader does not hold is unavailable, not a pass', async () => {
    const chain = await mixedChain()
    const { payload: _omit, ...noPayload } = chain[1]
    const r = await verifyEvidenceSlice([chain[0], noPayload, chain[2]], COMPLETE)
    expect(r.rows[1].payload).toBe('unavailable')
    expect(r.dimensions.payload).toBe('indeterminate')
    expect(r.overall).toBe('incomplete')
  })

  it('the projection contract applies to every row in the slice', async () => {
    const chain = await mixedChain()
    const { credential_id: _a, issuer_kind: _b, ...dropped } = chain[2]
    const r = await verifyEvidenceSlice([chain[0], chain[1], dropped], COMPLETE)
    expect(r.rows[2]).toMatchObject({ kind: 'invalid', hash: 'invalid_input' })
    expect(r.overall).toBe('failed')
  })
})

describe('T164 regressions: no overall verified without proof', () => {
  it('a v4 middle row missing its hash and link blocks verified without being called corrupt', async () => {
    const a = await legacyRow(1, 'GENESIS', { type: ACCEPTANCE_TYPE })
    const m = { ...(await legacyRow(2, a.event_hash)), event_hash: null, prev_event_hash: null }
    const c = await legacyRow(3, a.event_hash)
    const r = await verifyEvidenceSlice([a, m, c], COMPLETE)
    expect(r.rows[1]).toMatchObject({ hash: 'missing', link: 'missing', payload: 'match', agreement: 'match' })
    expect(r.rows[2].link).toBe('linked')
    expect(r.dimensions).toMatchObject({ hash: 'indeterminate', link: 'indeterminate' })
    expect(r.overall).toBe('incomplete')
  })

  it('an all-unhashed legacy prefix stays unverified, never a passing hash dimension', async () => {
    const rows = [await legacyRow(1, null, { version: 1, hashed: false }), await legacyRow(2, null, { version: 1, hashed: false })]
    const r = await verifyEvidenceSlice(rows, { ...COMPLETE, acceptance: 'none' })
    expect(r.rows.map(x => x.hash)).toEqual(['pre_chain', 'pre_chain'])
    expect(r.dimensions.hash).toBe('indeterminate')
    expect(r.overall).toBe('incomplete')
    const unknown = await verifyEvidenceSlice(rows, { ...COMPLETE, startsAtChainStart: false, acceptance: 'unknown' })
    expect(unknown.rows.map(x => x.hash)).toEqual(['not_recorded', 'not_recorded'])
  })

  it('a full-boundary slice whose v5 digest matches at an unknown acceptance position is not verified', async () => {
    const only = await v5Row(1, 'GENESIS')
    const r = await verifyEvidenceSlice([only], { ...COMPLETE, acceptance: 'unknown' })
    expect(r.acceptance).toEqual({ status: 'caller' })
    expect(r.rows[0]).toMatchObject({ hash: 'match', link: 'linked', payload: 'match', agreement: 'match_position_unknown' })
    expect(r.dimensions).toMatchObject({ hash: 'pass', link: 'pass', payload: 'pass', completeness: 'pass', agreement: 'indeterminate' })
    expect(r.overall).toBe('incomplete')
  })

  it('inconsistent or out-of-range acceptance markers are rejected and nothing about agreement passes', async () => {
    const chain = await mixedChain()
    const second = await legacyRow(9, chain[2].event_hash, { type: ACCEPTANCE_TYPE })
    for (const [acceptance, rows, reason] of [
      [{ index: 3 }, chain, 'out of range'],
      [{ index: -1 }, chain, 'out of range'],
      [{ index: 1.5 }, chain, 'out of range'],
      [{ index: 1 }, chain, 'does not name'],
      ['none', chain, 'contradicts'],
      ['before_slice', chain, 'contradicts'],
      ['unknown', [...chain, second], 'more than one'],
      ['sometimes', chain, 'unrecognised'],
    ]) {
      const r = await verifyEvidenceSlice(rows, { ...COMPLETE, acceptance })
      expect(r.acceptance.status, JSON.stringify(acceptance)).toBe('rejected')
      expect(r.acceptance.reason).toContain(reason)
      expect(r.rows.filter(x => x.kind !== 'invalid').every(x => x.agreement === 'indeterminate'), JSON.stringify(acceptance)).toBe(true)
      expect(r.overall).not.toBe('verified')
    }
  })
})

describe('3A: legacy constants unchanged', () => {
  it('v5 is still not a legacy-supported version and the writer stays on v4', () => {
    expect([...SUPPORTED_HASH_VERSIONS]).toEqual([1, 2, 3, 4])
    expect(HASH_VERSION).toBe(4)
  })
})
