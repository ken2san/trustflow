import { describe, it, expect } from 'vitest'
import {
  GENESIS_HASH, HASH_VERSION, stableStringify, payloadHash, deriveDodHash,
  eventCanonical, canonicalVersionOf, recomputeEventHash, canonicalTimestamp, sha256Hex,
  buildAgreementSnapshot, deriveAgreementHash, bindsWholeAgreement,
  SUPPORTED_HASH_VERSIONS, SUPPORTED_SNAPSHOT_VERSIONS, SNAPSHOT_VERSION,
  isSupportedSnapshotVersion,
} from '../../supabase/functions/_shared/eventCanonical.ts'

// This module is the one definition of what an attested event's hash covers,
// shared by the Edge Function that writes events and both verifiers that read
// them. The single production bug this chain has had came from two copies of
// that definition drifting apart, so these tests guard the definition itself.

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'performance.asserted',
  contract_id: '22222222-2222-4222-8222-222222222222',
  actor_id: 'earner-uuid',
  dod_hash: 'terms-hash',
  created_at: '2026-09-25T10:00:00.000Z',
}

describe('stableStringify', () => {
  it('is independent of key order', () => {
    // jsonb gives no key-order guarantee, so a payload read back from Postgres
    // can be ordered differently from the one hashed at write time.
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('sorts nested keys too', () => {
    expect(stableStringify({ outer: { z: 1, a: 2 } }))
      .toBe('{"outer":{"a":2,"z":1}}')
  })

  it('preserves array order — position is meaning, unlike key order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it('treats a dropped key and an explicit undefined identically', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it('distinguishes null from absent', () => {
    expect(stableStringify({ a: 1, b: null })).not.toBe(stableStringify({ a: 1 }))
  })
})

describe('payloadHash', () => {
  it('is stable across key reordering', async () => {
    expect(await payloadHash({ reason: 'x', step: 1 }))
      .toBe(await payloadHash({ step: 1, reason: 'x' }))
  })

  it('changes when the substance changes', async () => {
    // The point of binding the payload: a rejection reason cannot be edited
    // after the fact without the event failing verification.
    const original = await payloadHash({ reason: 'incomplete' })
    expect(await payloadHash({ reason: 'perfectly fine' })).not.toBe(original)
  })

  it('treats a missing payload as an empty object', async () => {
    expect(await payloadHash(undefined)).toBe(await payloadHash({}))
  })
})

describe('deriveDodHash', () => {
  it('changes when the terms change — this is how a scope change becomes visible', async () => {
    const agreed = await deriveDodHash(['three logo concepts'])
    const widened = await deriveDodHash(['three logo concepts', 'and a website'])
    expect(widened).not.toBe(agreed)
  })

  it('is stable for the same terms', async () => {
    expect(await deriveDodHash(['a', 'b'])).toBe(await deriveDodHash(['a', 'b']))
  })
})

describe('canonical versions', () => {
  it('v1 omits the chain link', () => {
    const canonical = eventCanonical(base, 1)
    expect(canonical).not.toContain('prev_hash')
    expect(canonical).not.toContain('payload_hash')
  })

  it('v2 adds the chain link but not the payload', () => {
    const canonical = eventCanonical({ ...base, prev_event_hash: 'abc' }, 2)
    expect(JSON.parse(canonical)).toHaveProperty('prev_hash', 'abc')
    expect(canonical).not.toContain('payload_hash')
  })

  it('v3 binds the payload as well', () => {
    const canonical = eventCanonical({ ...base, prev_event_hash: 'abc', payload_hash: 'def' }, 3)
    const parsed = JSON.parse(canonical)
    expect(parsed).toHaveProperty('prev_hash', 'abc')
    expect(parsed).toHaveProperty('payload_hash', 'def')
  })

  it('defaults a missing chain link to the genesis sentinel', () => {
    expect(JSON.parse(eventCanonical(base, 2))).toHaveProperty('prev_hash', GENESIS_HASH)
  })

  it('v4 binds the whole agreement on top of v3', () => {
    const parsed = JSON.parse(eventCanonical(
      { ...base, prev_event_hash: 'abc', payload_hash: 'def', agreement_hash: 'ghi' }, 4))
    expect(parsed).toHaveProperty('payload_hash', 'def')
    expect(parsed).toHaveProperty('agreement_hash', 'ghi')
    // v3 must not acquire the new field merely because v4 now exists.
    expect(eventCanonical({ ...base, prev_event_hash: 'abc', payload_hash: 'def' }, 3))
      .not.toContain('agreement_hash')
  })

  it('writes the current version', () => {
    expect(HASH_VERSION).toBe(4)
  })

  it('says which versions bind the whole deal and which bind only the criteria', () => {
    expect([1, 2, 3].map(bindsWholeAgreement)).toEqual([false, false, false])
    expect(bindsWholeAgreement(4)).toBe(true)
  })

  // Regression: the canonical gained fields twice without the verifier being
  // told which rows were written under which rules, and each time every
  // untouched historical row was reported as tampered with.
  it('verifies each version under its own rules and not another', async () => {
    const v1Hash = await sha256Hex(eventCanonical(base, 1))
    const v2Hash = await sha256Hex(eventCanonical({ ...base, prev_event_hash: 'abc' }, 2))
    const v3 = { ...base, prev_event_hash: 'abc', payload_hash: 'def' }
    const v4 = { ...v3, agreement_hash: 'ghi' }
    const v3Hash = await sha256Hex(eventCanonical(v3, 3))
    const v4Hash = await sha256Hex(eventCanonical(v4, 4))

    expect(new Set([v1Hash, v2Hash, v3Hash, v4Hash]).size).toBe(4)

    expect(await recomputeEventHash({ ...base, hash_version: 1 })).toBe(v1Hash)
    expect(await recomputeEventHash({ ...base, prev_event_hash: 'abc', hash_version: 2 })).toBe(v2Hash)
    expect(await recomputeEventHash({ ...v3, hash_version: 3 })).toBe(v3Hash)
    expect(await recomputeEventHash({ ...v4, hash_version: 4 })).toBe(v4Hash)

    // A v3 row keeps verifying as a v3 row forever: the arrival of v4 does not
    // retroactively change what it said, even if an agreement_hash is present
    // on the row for other reasons.
    expect(await recomputeEventHash({ ...v4, hash_version: 3 })).toBe(v3Hash)
  })

  it('infers the version of rows written before the column existed', () => {
    expect(canonicalVersionOf({ prev_event_hash: null })).toBe(1)
    expect(canonicalVersionOf({ prev_event_hash: 'abc' })).toBe(2)
    expect(canonicalVersionOf({ hash_version: 3, prev_event_hash: 'abc' })).toBe(3)
    expect(canonicalVersionOf({ hash_version: 4, prev_event_hash: 'abc' })).toBe(4)
  })
})

// The defect v4 fixes: canonical v3 bound only the completion criteria, so the
// price, the deadline or which side performs could be changed after acceptance
// with nothing detecting it. These tests guard the snapshot that closes it.
describe('the agreement snapshot', () => {
  const contract = {
    id: '22222222-2222-4222-8222-222222222222',
    project_name: 'Certified translation of a birth certificate',
    dod: ['translate the document', 'return a stamped PDF'],
    amount_jpy: 20000,
    amount_minor: 20000,
    currency: 'JPY',
    deadline: '2026-11-30',
    performed_by: 'counterparty',
    earner_display_name: 'Acme Translations',
    // Everything below describes where the transaction is or how the software
    // works — none of it is a term anyone agreed to.
    state: 'TERMS_ACCEPTED',
    invite_token: 'invite-tok',
    guest_access_token: 'guest-tok',
    hirer_email: 'claimed@example.test',
    invited_hirer_email: 'invited@example.test',
    created_at: '2026-09-01T00:00:00.000Z',
  }

  it('captures the deal as the counterparty was shown it', () => {
    expect(buildAgreementSnapshot(contract)).toEqual({
      snapshot_version: 1,
      project_name: 'Certified translation of a birth certificate',
      dod: ['translate the document', 'return a stamped PDF'],
      amount: 20000,
      currency: 'JPY',
      deadline: '2026-11-30',
      performed_by: 'counterparty',
      offered_by: 'Acme Translations',
    })
  })

  it('leaves out protocol state, ids and tokens', () => {
    const snapshot = JSON.stringify(buildAgreementSnapshot(contract))
    for (const leaked of ['TERMS_ACCEPTED', 'invite-tok', 'guest-tok', 'invited@example.test', contract.id]) {
      expect(snapshot, `${leaked} is not a term of the agreement`).not.toContain(leaked)
    }
  })

  it('does not change when the transaction merely moves forward', async () => {
    const agreed = await deriveAgreementHash(contract)
    expect(await deriveAgreementHash({ ...contract, state: 'PERFORMANCE_ACCEPTED' })).toBe(agreed)
  })

  it.each([
    ['the price', { amount_minor: 30000 }],
    ['the currency', { currency: 'USD' }],
    ['the deadline', { deadline: '2026-12-15' }],
    ['what counts as finished', { dod: ['translate the document'] }],
    ['which side performs', { performed_by: 'creator' }],
    ['who is offering', { earner_display_name: 'Someone Else' }],
    ['what is being done', { project_name: 'Translate something else' }],
  ])('changing %s changes the agreement hash', async (_term, change) => {
    const agreed = await deriveAgreementHash(contract)
    expect(await deriveAgreementHash({ ...contract, ...change })).not.toBe(agreed)
  })

  it('is stable across key ordering, since jsonb guarantees none', async () => {
    const reordered = Object.fromEntries(Object.entries(contract).reverse())
    expect(await deriveAgreementHash(reordered)).toBe(await deriveAgreementHash(contract))
  })

  it('treats a row written before performed_by existed as creator-performed', () => {
    const { performed_by: _absent, ...older } = contract
    expect(buildAgreementSnapshot(older).performed_by).toBe('creator')
  })
})

describe('canonicalTimestamp', () => {
  it('truncates fractional digits beyond milliseconds', () => {
    expect(canonicalTimestamp('2026-01-02T03:04:05.1239+00:00')).toBe('2026-01-02T03:04:05.123Z')
  })
  // Regression: events are hashed over toISOString() but PostgREST returns the
  // same instant with a +00:00 offset, which made every stored event verify as
  // tampered with.
  it('normalises a PostgREST offset back to the written form', () => {
    expect(canonicalTimestamp('2026-09-25T10:00:00+00:00')).toBe('2026-09-25T10:00:00.000Z')
  })

  it('leaves an unparseable value alone rather than inventing one', () => {
    expect(canonicalTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('is applied inside the canonical, not just available beside it', () => {
    expect(eventCanonical({ ...base, created_at: '2026-09-25T10:00:00+00:00' }, 1))
      .toBe(eventCanonical(base, 1))
  })
})

// ── The evolution contract ──────────────────────────────────────────────────
//
// Rank 1 of Codex's data-model review: the versioning was present and the
// machinery around it was incomplete, in three ways that all failed the same
// direction — silently treating an unknown version as the newest one it knew.
//
// These tests exist to make the next version's arrival boring. Every one of
// them would have passed before the guards; what they pin is that supported
// versions keep producing EXACTLY the bytes they produce today, so the guards
// cannot have changed a stored hash, and that an unsupported version is
// refused rather than guessed.

describe('the canonical is frozen per version', () => {
  // Deliberately a literal, not a helper: if a future edit changes what this
  // builds, the point is to see it in the diff.
  const EVENT = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'performance.asserted',
    contract_id: '22222222-2222-4222-8222-222222222222',
    actor_id: '33333333-3333-4333-8333-333333333333',
    dod_hash: 'dodhash',
    created_at: '2026-11-09T12:00:00.000Z',
    prev_event_hash: 'prevhash',
    payload_hash: 'payloadhash',
    agreement_hash: 'agreementhash',
  }

  // The exact strings this build produces. Any change to these is a change to
  // every stored event_hash of that version — which is the thing that must
  // never happen by accident.
  const FROZEN = {
    1: '{"id":"11111111-1111-4111-8111-111111111111","type":"performance.asserted","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"33333333-3333-4333-8333-333333333333","dod_hash":"dodhash","created_at":"2026-11-09T12:00:00.000Z"}',
    2: '{"id":"11111111-1111-4111-8111-111111111111","type":"performance.asserted","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"33333333-3333-4333-8333-333333333333","dod_hash":"dodhash","created_at":"2026-11-09T12:00:00.000Z","prev_hash":"prevhash"}',
    3: '{"id":"11111111-1111-4111-8111-111111111111","type":"performance.asserted","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"33333333-3333-4333-8333-333333333333","dod_hash":"dodhash","created_at":"2026-11-09T12:00:00.000Z","prev_hash":"prevhash","payload_hash":"payloadhash"}',
    4: '{"id":"11111111-1111-4111-8111-111111111111","type":"performance.asserted","contract_id":"22222222-2222-4222-8222-222222222222","actor_id":"33333333-3333-4333-8333-333333333333","dod_hash":"dodhash","created_at":"2026-11-09T12:00:00.000Z","prev_hash":"prevhash","payload_hash":"payloadhash","agreement_hash":"agreementhash"}',
  }

  for (const version of [1, 2, 3, 4]) {
    it(`v${version} produces byte-for-byte the string it always has`, () => {
      expect(eventCanonical(EVENT, version)).toBe(FROZEN[version])
    })
  }

  it('lists exactly the versions it can produce', () => {
    expect([...SUPPORTED_HASH_VERSIONS]).toEqual([1, 2, 3, 4])
    expect(SUPPORTED_HASH_VERSIONS).toContain(HASH_VERSION)
  })

  it('refuses an unknown version instead of hashing it as the newest', () => {
    // THE TRAP. Before the guard, v5 fell through to the v4 shape, so a row
    // written by a future build would have been hashed as v4 and reported
    // verified. Codex confirmed by probe that v4 and v5 produced identical
    // bytes.
    for (const version of [5, 44, 0, -1, 1.5, NaN, null, undefined, '4']) {
      expect(() => eventCanonical(EVENT, version), `version ${String(version)}`)
        .toThrow(/unsupported canonical version/)
    }
    expect(eventCanonical(EVENT, 5 - 1)).toBe(FROZEN[4])
  })

  it('does not claim an unknown version binds the whole agreement', () => {
    expect(bindsWholeAgreement(4)).toBe(true)
    expect(bindsWholeAgreement(3)).toBe(false)
    // `>= 4` alone answered true here, which is the same silent-understanding
    // bug one function along.
    expect(bindsWholeAgreement(5)).toBe(false)
    expect(bindsWholeAgreement(99)).toBe(false)
  })

  it('still identifies a pre-column row as v1 or v2 by its chain link', () => {
    // Preserved exactly: a row with no recorded version predates the column.
    expect(canonicalVersionOf({})).toBe(1)
    expect(canonicalVersionOf({ prev_event_hash: 'x' })).toBe(2)
    expect(canonicalVersionOf({ hash_version: 3 })).toBe(3)
  })
})

describe('the agreement snapshot is frozen per version', () => {
  const CONTRACT = {
    project_name: 'Translate a birth certificate',
    dod: ['Translate the document', 'Return a stamped PDF'],
    amount_minor: 125050,
    currency: 'CAD',
    deadline: '2026-12-01',
    performed_by: 'creator',
    earner_display_name: 'Acme Translations',
    // Row fields that must never reach the snapshot.
    state: 'TERMS_ACCEPTED',
    guest_access_token: 'secret',
    hirer_email: 'someone@example.test',
  }

  const FROZEN_V1 = '{"amount":125050,"currency":"CAD","deadline":"2026-12-01",'
    + '"dod":["Translate the document","Return a stamped PDF"],"offered_by":"Acme Translations",'
    + '"performed_by":"creator","project_name":"Translate a birth certificate","snapshot_version":1}'

  it('builds v1 byte-for-byte as it always has', () => {
    expect(stableStringify(buildAgreementSnapshot(CONTRACT, 1))).toBe(FROZEN_V1)
  })

  it('defaults to the current version, which is still 1', () => {
    expect(SNAPSHOT_VERSION).toBe(1)
    expect(stableStringify(buildAgreementSnapshot(CONTRACT))).toBe(FROZEN_V1)
  })

  it('hashes v1 to the same digest whether the version is passed or defaulted', async () => {
    // The guard added a parameter. This is the test that it added nothing else.
    expect(await deriveAgreementHash(CONTRACT)).toBe(await deriveAgreementHash(CONTRACT, 1))
    expect(await deriveAgreementHash(CONTRACT))
      .toBe(await sha256Hex(FROZEN_V1))
  })

  it('refuses a snapshot version it cannot build', () => {
    for (const version of [2, 0, 1.5, null, '1']) {
      expect(() => buildAgreementSnapshot(CONTRACT, version), `version ${String(version)}`)
        .toThrow(/unsupported agreement snapshot version/)
    }
  })

  it('treats an explicit undefined as "use the current version", not as unknown', () => {
    // A default parameter fires on undefined, so this builds v1 rather than
    // throwing. Asserted rather than left implicit: my first version of the
    // test above expected a refusal here and was wrong about the language, not
    // about the code.
    expect(stableStringify(buildAgreementSnapshot(CONTRACT, undefined))).toBe(FROZEN_V1)
  })

  it('lists exactly the snapshot versions it can build', () => {
    expect([...SUPPORTED_SNAPSHOT_VERSIONS]).toEqual([1])
    expect(isSupportedSnapshotVersion(1)).toBe(true)
    expect(isSupportedSnapshotVersion(2)).toBe(false)
  })

  it('still omits every field that is not a term', () => {
    const snapshot = buildAgreementSnapshot(CONTRACT)
    for (const key of ['state', 'guest_access_token', 'hirer_email']) {
      expect(Object.keys(snapshot)).not.toContain(key)
    }
  })

  it('still reads the old amount column when the new one is absent', async () => {
    // A JPY row written before the rename must keep producing the hash it had.
    const { amount_minor: _omitted, ...legacy } = CONTRACT
    expect(await deriveAgreementHash({ ...legacy, amount_jpy: 125050, currency: 'JPY' }))
      .toBe(await deriveAgreementHash({ ...CONTRACT, amount_minor: 125050, currency: 'JPY' }))
  })
})

describe('public synthetic evidence vectors', () => {
  it('pins the published preimages and hashes to the implementation', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = readFileSync(new URL('../../public/agent-protocol.md', import.meta.url), 'utf8')
    const payload = { note: 'Done' }
    const contract = { project_name: 'Example', dod: ['Translate'], amount_minor: 1250, currency: 'CAD', deadline: null, performed_by: 'creator', earner_display_name: 'Example' }
    const ph = await payloadHash(payload)
    const ah = await deriveAgreementHash(contract)
    const dh = await deriveDodHash(contract.dod)
    const event = { id: '11111111-1111-4111-8111-111111111111', type: 'performance.asserted', contract_id: '22222222-2222-4222-8222-222222222222', actor_id: 'example', dod_hash: dh, created_at: '2026-01-02T03:04:05.12+00:00', prev_event_hash: 'GENESIS', payload_hash: ph, agreement_hash: ah }
    const canonical = eventCanonical(event, 4)
    for (const preimage of [stableStringify(payload), stableStringify(buildAgreementSnapshot(contract)), stableStringify(contract.dod), canonical]) {
      const digest = await sha256Hex(preimage)
      expect(doc).toContain('`' + preimage + '`')
      expect(doc).toContain('`' + digest + '`')
    }
  })
})
