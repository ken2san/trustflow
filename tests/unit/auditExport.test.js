import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildAuditDocument } from '../../src/lib/auditExport.js'
import { stableStringify } from '../../supabase/functions/_shared/eventCanonical.ts'

// The real sha256 is used here, not a mock: what these tests guard is whether
// a stored hash still recomputes, which a stubbed digest cannot tell us.
// auditExport reaches eventLog for GENESIS_HASH, which imports the client.
vi.mock('../../src/lib/supabase.js', () => ({ supabase: null }))

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const CONTRACT = 'd666cf92-af89-4017-aec2-a905a2d07057'

/** An event hashed the way log-event hashes one (canonical v2). */
function attestedEvent({ id, type, actorId, createdAt, dodHash = null, prevHash }) {
  const event_hash = sha(JSON.stringify({
    id, type, contract_id: CONTRACT, actor_id: actorId,
    dod_hash: dodHash, created_at: createdAt, prev_hash: prevHash,
  }))
  return {
    id, type, contract_id: CONTRACT, actor_id: actorId, dod_hash: dodHash,
    created_at: createdAt, prev_event_hash: prevHash, hash_version: 2,
    payload: {}, event_hash, tsa_token: null,
  }
}

/** An event hashed the way the pre-chain client hashed one (canonical v1).
 *  The retired work.* type names below are deliberate: these stand in for rows
 *  written before the vocabulary changed, and such rows must keep verifying. */
function legacyEvent({ id, type, actorId, createdAt, dodHash = null }) {
  const event_hash = sha(JSON.stringify({
    id, type, contract_id: CONTRACT, actor_id: actorId,
    dod_hash: dodHash, created_at: createdAt,
  }))
  return {
    id, type, contract_id: CONTRACT, actor_id: actorId, dod_hash: dodHash,
    created_at: createdAt, prev_event_hash: null, hash_version: null,
    payload: {}, event_hash, tsa_token: null,
  }
}

/** An event hashed under v3 (payload bound) or v4 (whole agreement bound). */
function modernEvent({
  id, type, actorId, createdAt, dodHash = null, prevHash, payload = {},
  version, agreementHash = null,
}) {
  const payload_hash = sha(stableStringify(payload))
  const canonical = {
    id, type, contract_id: CONTRACT, actor_id: actorId,
    dod_hash: dodHash, created_at: createdAt, prev_hash: prevHash, payload_hash,
    ...(version >= 4 ? { agreement_hash: agreementHash } : {}),
  }
  return {
    id, type, contract_id: CONTRACT, actor_id: actorId, dod_hash: dodHash,
    created_at: createdAt, prev_event_hash: prevHash, hash_version: version,
    payload, payload_hash, agreement_hash: version >= 4 ? agreementHash : undefined,
    event_hash: sha(JSON.stringify(canonical)), tsa_token: null,
  }
}

const build = (events) => buildAuditDocument({ contractId: CONTRACT, dodHash: 'dod', events })

describe('audit document verification', () => {
  it('reports a broken chain when an intact 201-event history is truncated to its newest 200 rows', async () => {
    let prevHash = 'GENESIS'
    const events = []
    for (let i = 0; i < 201; i += 1) {
      const event = attestedEvent({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        type: 'contract.initiated', actorId: 'earner-uuid',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        prevHash,
      })
      events.push(event)
      prevHash = event.event_hash
    }

    const complete = (await build(events)).trustflow_audit_trail
    expect(complete.integrity_status).toBe('VERIFIED')

    // fetchContractEvents returns the newest 200 rows first. The omitted first
    // row leaves the first exported event pointing at a predecessor the export
    // cannot see, although the full stored chain is intact.
    const newest200 = events.slice(1).reverse()
    const truncated = (await build(newest200)).trustflow_audit_trail
    expect(truncated.integrity_status).toBe('CHAIN_LINK_BROKEN')
    expect(truncated.events).toHaveLength(200)
    expect(truncated.events[0]._export_verification.chain_link_match).toBe(false)
  })

  it('verifies a server-attested chain', async () => {
    const a = attestedEvent({
      id: '11111111-1111-4111-8111-111111111111', type: 'contract.initiated',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
    })
    const b = attestedEvent({
      id: '22222222-2222-4222-8222-222222222222', type: 'work.submitted',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:05:00.000Z', prevHash: a.event_hash,
    })

    const doc = (await build([a, b])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('VERIFIED')
    expect(doc.events.every(e => e._export_verification.hash_match)).toBe(true)
    expect(doc.events.every(e => e._export_verification.trust_model === 'server_attested')).toBe(true)
  })

  // Regression: created_at is hashed as 2026-09-24T12:00:00.000Z, but PostgREST
  // returns the same instant as 2026-09-24T12:00:00+00:00. Hashing the value as
  // read reported every stored event as tampered with.
  it('verifies events whose timestamps come back in PostgREST offset form', async () => {
    const a = attestedEvent({
      id: '33333333-3333-4333-8333-333333333333', type: 'contract.initiated',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
    })
    // Same instant, as the database renders it.
    const asStored = { ...a, created_at: '2026-09-24T12:00:00+00:00' }

    const doc = (await build([asStored])).trustflow_audit_trail
    expect(doc.events[0]._export_verification.hash_match).toBe(true)
    expect(doc.integrity_status).toBe('VERIFIED')
  })

  // Regression: the canonical gained a prev_hash field without being versioned,
  // so legacy rows were verified with the wrong format and reported as altered.
  it('verifies legacy rows under the canonical they were written with', async () => {
    const legacy = legacyEvent({
      id: '44444444-4444-4444-8444-444444444444', type: 'contract.accepted',
      actorId: 'user', createdAt: '2026-03-12T12:33:16.434Z',
    })

    const doc = (await build([legacy])).trustflow_audit_trail
    expect(doc.events[0]._export_verification.canonical_version).toBe(1)
    expect(doc.events[0]._export_verification.hash_match).toBe(true)
    expect(doc.integrity_status).toBe('VERIFIED')
  })

  it('does not present a legacy row as server-attested', async () => {
    const legacy = legacyEvent({
      id: '55555555-5555-4555-8555-555555555555', type: 'contract.accepted',
      actorId: 'user', createdAt: '2026-03-12T12:33:16.434Z',
    })

    const doc = (await build([legacy])).trustflow_audit_trail
    expect(doc.events[0]._export_verification.trust_model).toBe('client_asserted')
  })

  it('detects an altered event', async () => {
    const a = attestedEvent({
      id: '66666666-6666-4666-8666-666666666666', type: 'work.approved',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
    })
    const tampered = { ...a, actor_id: 'somebody-else' }

    const doc = (await build([tampered])).trustflow_audit_trail
    expect(doc.events[0]._export_verification.hash_match).toBe(false)
    expect(doc.integrity_status).toBe('HASH_MISMATCH_DETECTED')
  })

  it('detects a broken chain link when an event is removed', async () => {
    const a = attestedEvent({
      id: '77777777-7777-4777-8777-777777777777', type: 'contract.initiated',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
    })
    const b = attestedEvent({
      id: '88888888-8888-4888-8888-888888888888', type: 'work.submitted',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:05:00.000Z', prevHash: a.event_hash,
    })
    const c = attestedEvent({
      id: '99999999-9999-4999-8999-999999999999', type: 'work.approved',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:10:00.000Z', prevHash: b.event_hash,
    })

    // b is deleted; a and c both still self-verify.
    const doc = (await build([a, c])).trustflow_audit_trail
    expect(doc.events.every(e => e._export_verification.hash_match)).toBe(true)
    expect(doc.integrity_status).toBe('CHAIN_LINK_BROKEN')
  })

  it('sorts chronologically before verifying, whatever order it is handed', async () => {
    const a = attestedEvent({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'contract.initiated',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
    })
    const b = attestedEvent({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'work.submitted',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:05:00.000Z', prevHash: a.event_hash,
    })

    // fetchContractEvents returns newest-first.
    const doc = (await build([b, a])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('VERIFIED')
  })

  // The Evidence Core rule: a version's meaning is permanent. A v3 row written
  // before the agreement was bound must not start failing because v4 exists.
  it('verifies a v3 row and a v4 row side by side in one document', async () => {
    const v3 = modernEvent({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'dod.consent_recorded',
      actorId: 'guest-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
      payload: { counterparty_name: 'Guest' }, version: 3,
    })
    const v4 = modernEvent({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'performance.asserted',
      actorId: 'earner-uuid', createdAt: '2026-09-24T12:05:00.000Z', prevHash: v3.event_hash,
      payload: { note: 'delivered' }, version: 4, agreementHash: 'agreement-digest',
    })

    const doc = (await build([v3, v4])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('VERIFIED')
    expect(doc.events.map(e => e._export_verification.canonical_version)).toEqual([3, 4])
    // And the document says which of the two actually binds the whole deal,
    // rather than letting a reader assume the newer rule applied throughout.
    expect(doc.events.map(e => e._export_verification.binds_whole_agreement))
      .toEqual([false, true])
  })

  it('reports a v4 row whose agreement hash was swapped as altered', async () => {
    const v4 = modernEvent({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', type: 'dod.consent_recorded',
      actorId: 'guest-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
      payload: { counterparty_name: 'Guest' }, version: 4, agreementHash: 'the-agreed-deal',
    })

    const doc = (await build([{ ...v4, agreement_hash: 'some-other-deal' }])).trustflow_audit_trail
    expect(doc.events[0]._export_verification.hash_match).toBe(false)
    expect(doc.integrity_status).toBe('HASH_MISMATCH_DETECTED')
  })

  // The point of embedding the snapshot rather than only its hash: the export
  // can SHOW the accepted deal, and it never consults the contract row to do
  // it — buildAuditDocument is handed events and nothing else.
  it('carries the accepted terms in the record itself, and detects an edit to them', async () => {
    const agreement = {
      snapshot_version: 1, project_name: 'Translate a document', dod: ['return a stamped PDF'],
      amount: 20000, currency: 'JPY', deadline: '2026-11-30',
      performed_by: 'creator', offered_by: 'Acme Translations',
    }
    const acceptance = modernEvent({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', type: 'dod.consent_recorded',
      actorId: 'guest-uuid', createdAt: '2026-09-24T12:00:00.000Z', prevHash: 'GENESIS',
      payload: { counterparty_name: 'Guest', _agreement: agreement },
      version: 4, agreementHash: sha(stableStringify(agreement)),
    })

    const doc = (await build([acceptance])).trustflow_audit_trail
    expect(doc.events[0].payload._agreement.amount).toBe(20000)
    expect(doc.events[0]._export_verification.substance_match).toBe(true)
    expect(doc.integrity_status).toBe('VERIFIED')

    // Rewriting the price inside the exported record is caught, because from v3
    // the payload is bound into the event hash.
    const edited = {
      ...acceptance,
      payload: { ...acceptance.payload, _agreement: { ...agreement, amount: 30000 } },
    }
    const tampered = (await build([edited])).trustflow_audit_trail
    expect(tampered.events[0]._export_verification.substance_match).toBe(false)
    expect(tampered.integrity_status).toBe('HASH_MISMATCH_DETECTED')
  })

  it('tells a verifier how to reproduce the hashes it reports', async () => {
    const doc = (await build([])).trustflow_audit_trail
    const instructions = doc.verification_instructions.join(' ')
    // The two things a third party cannot guess and will otherwise get wrong.
    expect(instructions).toMatch(/trailing Z|\.016Z/)
    expect(instructions).toMatch(/canonical_version/)
    // And the limit of what the hash actually covers.
    expect(instructions).toMatch(/does NOT cover payload/i)
    // And which rows bind the whole deal rather than only its criteria.
    expect(instructions).toMatch(/agreement_hash/)
  })
})

describe('event ordering', () => {
  // The writers take the chain tip with `order by created_at desc, id desc`
  // (log-event, accept_invitation, derive_contract_state). created_at has
  // millisecond resolution, so two events can share one; a verifier that sorts
  // on created_at alone replays them in whatever order it received them and
  // reports chain_link_match false on a chain nobody touched. For a product
  // whose one promise is a tamper-evident record, a false alarm is the
  // expensive failure.
  const SAME_MS = '2026-09-24T12:00:00.000Z'

  /** Two events written in the same millisecond, chained id-ascending. */
  function collidingPair() {
    const first = attestedEvent({
      id: '11111111-1111-4111-8111-111111111111', type: 'contract.initiated',
      actorId: 'earner-uuid', createdAt: SAME_MS, prevHash: 'GENESIS',
    })
    const second = attestedEvent({
      id: '22222222-2222-4222-8222-222222222222', type: 'work.submitted',
      actorId: 'earner-uuid', createdAt: SAME_MS, prevHash: first.event_hash,
    })
    return [first, second]
  }

  it('verifies a same-millisecond pair however the rows arrive', async () => {
    const [first, second] = collidingPair()

    for (const order of [[first, second], [second, first]]) {
      const doc = (await build(order)).trustflow_audit_trail
      expect(doc.integrity_status).toBe('VERIFIED')
      // Replayed in the order the chain was built in, not the order supplied.
      expect(doc.events.map(ev => ev.id)).toEqual([first.id, second.id])
    }
  })

  it('still reports a genuine break in a same-millisecond pair', async () => {
    const [first] = collidingPair()
    // Internally self-consistent — its own hash covers the prev_hash it
    // carries — but pointing at a predecessor that is not the one before it.
    // This is what an inserted or reordered event looks like, and it is the
    // case the tiebreak must not paper over.
    const forged = attestedEvent({
      id: '22222222-2222-4222-8222-222222222222', type: 'work.submitted',
      actorId: 'earner-uuid', createdAt: SAME_MS, prevHash: 'f'.repeat(64),
    })

    const doc = (await build([first, forged])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('CHAIN_LINK_BROKEN')
  })
})

// ── An unverifiable row must not come out VERIFIED ──────────────────────────
//
// Codex's finding 1 on Task 26. Marking an unsupported version's per-event
// hash_match as null was not enough: both aggregators accepted "anything but
// false", so a row this build cannot check at all still counted towards the
// headline. A v5 row with a stored hash and an intact chain link produced
// integrity_status: VERIFIED — the one word a reader takes at face value — for
// a row nothing had verified.

/**
 * A row from a build that knows a canonical version this one does not. Its
 * stored hash is deliberately well-formed and its chain link correct: the point
 * is that everything *checkable* checks out and the version still cannot be.
 */
function futureVersionEvent({ id, type, actorId, createdAt, prevHash, version = 5 }) {
  return {
    id, type, contract_id: CONTRACT, actor_id: actorId, dod_hash: null,
    created_at: createdAt, prev_event_hash: prevHash, hash_version: version,
    payload: {}, payload_hash: sha(stableStringify({})),
    event_hash: 'a-hash-this-build-cannot-recompute', tsa_token: null,
  }
}

describe('a canonical version this build cannot verify', () => {
  it('does not roll up to VERIFIED, even with an intact chain', async () => {
    const first = attestedEvent({
      id: 'e1', type: 'contract.accepted', actorId: 'a', createdAt: '2026-11-01T00:00:00.000Z',
      prevHash: 'GENESIS',
    })
    const second = futureVersionEvent({
      id: 'e2', type: 'performance.asserted', actorId: 'a',
      createdAt: '2026-11-02T00:00:00.000Z', prevHash: first.event_hash,
    })
    const doc = (await build([first, second])).trustflow_audit_trail

    expect(doc.integrity_status).toBe('INDETERMINATE_UNSUPPORTED_VERSION')
    expect(doc.integrity_status).not.toBe('VERIFIED')
  })

  it('names which events and which versions, rather than making a reader hunt', async () => {
    const first = attestedEvent({
      id: 'e1', type: 'contract.accepted', actorId: 'a', createdAt: '2026-11-01T00:00:00.000Z',
      prevHash: 'GENESIS',
    })
    const second = futureVersionEvent({
      id: 'e2', type: 'performance.asserted', actorId: 'a',
      createdAt: '2026-11-02T00:00:00.000Z', prevHash: first.event_hash, version: 7,
    })
    const doc = (await build([first, second])).trustflow_audit_trail
    const unsupported = doc.unsupported_canonical_versions

    expect(unsupported.count).toBe(1)
    expect(unsupported.event_ids).toEqual(['e2'])
    expect(unsupported.versions).toEqual([7])
    expect(unsupported.meaning).toMatch(/neither confirmed nor refuted/)
  })

  it('says per event that the version was not supported, and refuses to guess its payload coverage', async () => {
    const only = futureVersionEvent({
      id: 'e1', type: 'performance.asserted', actorId: 'a',
      createdAt: '2026-11-01T00:00:00.000Z', prevHash: 'GENESIS',
    })
    const [ev] = (await build([only])).trustflow_audit_trail.events
    expect(ev._export_verification.canonical_version_supported).toBe(false)
    expect(ev._export_verification.hash_match).toBeNull()
    expect(ev._export_verification.binds_whole_agreement).toBe(false)
    // v5 >= 3 would have asserted v3 payload semantics for a shape this build
    // has never seen.
    expect(ev._export_verification.substance_match).toBeNull()
  })

  it('still reports a real mismatch as a mismatch, which outranks an unknown', async () => {
    // A detected problem is a finding; an unknown version is the absence of
    // one. The finding has to win, or a tampered row could hide behind an
    // unsupported neighbour.
    const first = attestedEvent({
      id: 'e1', type: 'contract.accepted', actorId: 'a', createdAt: '2026-11-01T00:00:00.000Z',
      prevHash: 'GENESIS',
    })
    const tampered = { ...first, id: 'e2', event_hash: 'definitely-wrong' }
    const unknown = futureVersionEvent({
      id: 'e3', type: 'performance.asserted', actorId: 'a',
      createdAt: '2026-11-03T00:00:00.000Z', prevHash: 'definitely-wrong',
    })
    const doc = (await build([first, tampered, unknown])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('HASH_MISMATCH_DETECTED')
  })

  it('leaves a fully known, intact trail VERIFIED and says nothing was unsupported', async () => {
    // The regression guard for all of the above: the ordinary case must not
    // have become indeterminate.
    const first = attestedEvent({
      id: 'e1', type: 'contract.accepted', actorId: 'a', createdAt: '2026-11-01T00:00:00.000Z',
      prevHash: 'GENESIS',
    })
    const second = attestedEvent({
      id: 'e2', type: 'performance.asserted', actorId: 'a',
      createdAt: '2026-11-02T00:00:00.000Z', prevHash: first.event_hash,
    })
    const doc = (await build([first, second])).trustflow_audit_trail
    expect(doc.integrity_status).toBe('VERIFIED')
    expect(doc.unsupported_canonical_versions).toBeNull()
  })

  it('treats a RECORDED ZERO as unknown, not as a legacy row', async () => {
    // Codex's finding 3, through the real reader rather than the primitive.
    // `if (row.hash_version)` sent 0 down the legacy path, where it verified
    // as v1 or v2 — a version it never claimed.
    const zero = {
      ...futureVersionEvent({
        id: 'e1', type: 'performance.asserted', actorId: 'a',
        createdAt: '2026-11-01T00:00:00.000Z', prevHash: null,
      }),
      hash_version: 0,
    }
    const [ev] = (await build([zero])).trustflow_audit_trail.events
    expect(ev._export_verification.canonical_version).toBe(0)
    expect(ev._export_verification.canonical_version_supported).toBe(false)
    expect(ev._export_verification.hash_match).toBeNull()
  })

  it('still infers v1 or v2 for a row with no recorded version at all', async () => {
    // Absent must keep working: these are the pre-column rows.
    const legacy = legacyEvent({
      id: 'e1', type: 'work.submitted', actorId: 'a', createdAt: '2026-11-01T00:00:00.000Z',
    })
    const [ev] = (await build([legacy])).trustflow_audit_trail.events
    expect(ev._export_verification.canonical_version).toBe(1)
    expect(ev._export_verification.canonical_version_supported).toBe(true)
    expect(ev._export_verification.hash_match).toBe(true)
  })
})
