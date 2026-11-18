import { describe, it, expect } from 'vitest'
import { buildGuestRecordDocument } from '../../src/lib/guestRecordExport.js'
import { CANONICAL_INPUTS } from '../../supabase/functions/_shared/guestEventView.ts'
import { stableStringify, sha256Hex } from '../../supabase/functions/_shared/eventCanonical.ts'

// What these tests guard is mostly what the document CLAIMS. A copy that
// overstated the server's checks, or quietly dropped the fact that it was
// truncated, would be worse than no export at all.
//
// Document 2.0 (rank-1 provenance fix, Tasks 124-129) is BUILT from fixed key
// lists rather than copied, so a version 1 response's `trust_model`, actor
// role and label, and "authorship ... unaltered" notes cannot reach it. Those
// are pinned below by structural path, not by banning words: a payload a party
// wrote may legitimately contain "role" or "trust_model".

const CONTRACT = {
  id: 'd666cf92-af89-4017-aec2-a905a2d07057',
  project_name: 'Certified translation',
  dod: ['Certified PDF delivered'],
  amount_jpy: 48000,
  amount_minor: 48000,
  currency: 'JPY',
  deadline: '2026-10-31',
  state: 'TERMS_ACCEPTED',
  performed_by: 'creator',
  viewer_role: 'receiver',
  earner_display_name: 'Acme Translations',
  hirer_email: 'claimed@example.test',
}

const CANONICAL = {
  id: '1a', type: 'dod.consent_recorded', contract_id: CONTRACT.id,
  actor_id: 'guest:claimed@example.test', dod_hash: 'abc',
  created_at: '2026-09-28T10:00:00.000Z', prev_event_hash: 'GENESIS',
  payload_hash: 'ph', agreement_hash: 'ah', hash_version: 4,
}

const integrity = (over = {}) => ({
  hash_valid: true, chain_linked: true, substance_valid: true,
  canonical_version: 4, canonical_version_supported: true, binds_whole_agreement: true,
  event_hash: 'eh', prev_event_hash: 'GENESIS',
  ...over,
})

/** A body as the version 1 function sends it today, overclaims included. */
function v1Evidence(overrides = {}) {
  return {
    accepted_agreement: { snapshot_version: 1, amount: 48000, currency: 'JPY', deadline: '2026-10-31' },
    terms_changed_since_acceptance: [],
    acceptance_identity: {
      invited_recipient: 'invited@example.test',
      claimed_identity: 'claimed@example.test',
      claimed_identity_verified: false,
      authentication: 'invite_capability',
      authentication_detail: { method: 'invite_capability', nested: { kept: true } },
    },
    contract: CONTRACT,
    events: [{
      id: '1a', type: 'dod.consent_recorded', created_at: '2026-09-28T10:00:00.000Z',
      actor: { id: 'guest:claimed@example.test', role: 'guest_hirer', label: 'claimed@example.test' },
      payload: { counterparty_name: 'Guest' }, dod_hash: 'abc',
      canonical: { ...CANONICAL },
      integrity: { ...integrity(), trust_model: 'server_attested' },
    }],
    verification: {
      canonical_definition: 'x.ts',
      independently_verifiable: ['that each act\'s authorship, timing, ordering and terms-pin are unaltered'],
    },
    chain: {
      event_count: 1, server_attested: 1, client_asserted: 0,
      verified: true, truncated: false, payload_covered_by_hash: true,
    },
    ...overrides,
  }
}

/** The same record as a version 2 body. */
function v2Evidence(overrides = {}) {
  const base = v1Evidence()
  return {
    ...base,
    response_version: 2,
    events: [{
      ...base.events[0],
      actor: { id: 'guest:claimed@example.test', attribution: 'as_recorded_not_verified', recorded_id_class: 'guest_prefixed' },
      provenance: { writer: 'unknown', basis: 'none_recorded' },
      integrity: integrity(),
    }],
    chain: {
      event_count: 1, events_format_v2_or_later: 1, events_format_below_v2: 0,
      verified: true, truncated: false, payload_covered_by_hash: true,
    },
    ...overrides,
  }
}

const rec = (e) => buildGuestRecordDocument(e).trustflow_counterparty_record

/** Every structural path in a JSON value, e.g. `events.0.actor.role`. */
function paths(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix]
  const out = prefix ? [prefix] : []
  for (const [k, v] of Object.entries(value)) out.push(...paths(v, prefix ? `${prefix}.${k}` : k))
  return out
}

describe('the counterparty record document', () => {
  it('is named so it cannot be mistaken for the owner re-verifiable export', () => {
    const doc = buildGuestRecordDocument(v1Evidence())
    expect(doc.trustflow_audit_trail).toBeUndefined()
    expect(rec(v1Evidence()).document_type).toBe('server_verified_record')
    expect(rec(v1Evidence()).version).toBe('2.0')
  })

  it('splits what the reader can recompute from what they cannot', () => {
    const text = JSON.stringify(rec(v1Evidence()).what_this_document_is)
    // Conditional: a null or incomplete canonical block cannot be recomputed.
    expect(text).toMatch(/Where an act below carries a complete `canonical` block/)
    expect(text).toMatch(/recompute the hash of a supported format and follow the chain offline/)
    expect(text).toMatch(/whose block is null, or whose `canonical_missing` lists inputs that were not sent, cannot be recomputed/)
    expect(text).toMatch(/copy of the projection the server returned for this party, not filtered again here/)
    expect(text).toMatch(/payload digest cannot generally be checked from this file/)
    // A projection may equal the stored payload: no promised mismatch (Codex 115).
    expect(text).toMatch(/a reader cannot generally establish from it whether the digest matches/)
    expect(text).not.toMatch(/would not match/)
    expect(text).toMatch(/substance_valid.*server's word/)
    expect(text).toMatch(/does not show who wrote an act, when it was actually written, or that the record was never rewritten/)
  })
})

describe('built, not copied: a version 1 response cannot carry its overclaims through', () => {
  const FORBIDDEN_PATHS = [
    /^events\.\d+\.server_verification\.trust_model$/,
    /^events\.\d+\.actor\.role$/,
    /^events\.\d+\.actor\.label$/,
    /^verification\.server_attested$/,
    /^verification\.client_asserted$/,
  ]
  const OLD_NOTES = /authorship, timing, ordering and terms-pin are unaltered|bound to the same agreement_hash|hashes prove the record was not altered/

  for (const [name, make] of [['version 1', v1Evidence], ['version 2', v2Evidence]]) {
    it(`has none of the old generated structure from a ${name} response`, () => {
      const doc = rec(make())
      for (const p of paths(doc)) {
        for (const re of FORBIDDEN_PATHS) expect(p, p).not.toMatch(re)
      }
      expect(JSON.stringify(doc.independent_verification)).not.toMatch(OLD_NOTES)
    })
  }

  it('keeps the same words when a party wrote them into recorded content', () => {
    const doc = rec(v1Evidence({
      events: [{ ...v1Evidence().events[0], payload: { note: 'my role: trust_model reviewer', label: 'x' } }],
    }))
    expect(doc.events[0].payload).toEqual({ note: 'my role: trust_model reviewer', label: 'x' })
  })

  it('builds the notes itself rather than carrying the response\'s', () => {
    const notes = rec(v1Evidence()).independent_verification
    expect(notes.canonical_definition).toBe('supabase/functions/_shared/eventCanonical.ts')
    expect(JSON.stringify(notes.not_verifiable_here)).toMatch(/Who wrote any act/)
    expect(rec(v2Evidence()).independent_verification).toEqual(notes)
  })

  it('names no writer and no role, from either version', () => {
    expect(rec(v1Evidence()).events[0].actor).toEqual({
      id: 'guest:claimed@example.test', attribution: 'as_recorded_not_verified', recorded_id_class: null,
    })
    expect(rec(v2Evidence()).events[0].actor.recorded_id_class).toBe('guest_prefixed')
    // A version 1 body's actor role is never mapped to a class: it can come
    // from a payload field a client wrote.
    const v1 = rec(v1Evidence({ events: [{ ...v1Evidence().events[0], actor: { id: 'x', role: 'earner', recorded_id_class: 'guest_prefixed' } }] }))
    expect(v1.events[0].actor.recorded_id_class).toBeNull()
    // An unknown class from a v2 body is not carried either.
    const odd = rec(v2Evidence({ events: [{ ...v2Evidence().events[0], actor: { id: 'x', recorded_id_class: 'earner' } }] }))
    expect(odd.events[0].actor.recorded_id_class).toBeNull()
    for (const doc of [rec(v1Evidence()), rec(v2Evidence())]) {
      expect(doc.events[0].provenance).toEqual({ writer: 'unknown', basis: 'none_recorded' })
    }
  })

  it('drops extra keys in every structure it generates', () => {
    const base = v1Evidence()
    const doc = rec(v1Evidence({
      acceptance_identity: { ...base.acceptance_identity, injected: 'x' },
      events: [{
        ...base.events[0], injected: 'x',
        canonical: { ...CANONICAL, injected: 'x' },
        integrity: { ...base.events[0].integrity, injected: 'x', verified_by_party: true },
      }],
      chain: { ...base.chain, injected: 'x' },
    }))
    const all = paths(doc)
    expect(all.filter(p => p.endsWith('injected') || p.endsWith('verified_by_party'))).toEqual([])
  })

  it('produces the same document from the version 1 body a rolled-back function returns', () => {
    // After a function rollback, a client asking for version 2 gets version 1.
    const fromV1 = rec(v1Evidence())
    const fromV2 = rec(v2Evidence())
    const strip = d => ({ ...d, generated_at: null, response_version: null, events: d.events.map(e => ({ ...e, actor: { ...e.actor, recorded_id_class: null } })) })
    expect(strip(fromV1)).toEqual(strip(fromV2))
    expect(fromV1.response_version).toBe(1)
    expect(fromV2.response_version).toBe(2)
  })
})

describe('recorded values are kept as received', () => {
  it('copies only canonical inputs that are present, and lists the missing ones', () => {
    const partial = { ...CANONICAL, agreement_hash: null }
    delete partial.payload_hash
    const [e] = rec(v1Evidence({ events: [{ ...v1Evidence().events[0], canonical: partial }] })).events
    // A recorded null stays null; an absent input stays absent. Filling it with
    // null could recompute to a false mismatch or look complete.
    expect(e.canonical.agreement_hash).toBeNull()
    expect('payload_hash' in e.canonical).toBe(false)
    expect(e.canonical_missing).toEqual(['payload_hash'])
  })

  it('keeps every canonical input byte for byte when the block is complete', () => {
    const [e] = rec(v1Evidence()).events
    expect(e.canonical).toEqual(CANONICAL)
    expect(Object.keys(e.canonical).sort()).toEqual([...CANONICAL_INPUTS].sort())
    expect(e.canonical_missing).toEqual([])
  })

  it('says an act cannot be checked when the response carried no canonical', () => {
    const [e] = rec(v1Evidence({ events: [{ ...v1Evidence().events[0], canonical: null }] })).events
    expect(e.canonical).toBeNull()
    expect(e.canonical_missing).toEqual([...CANONICAL_INPUTS])
  })

  it('keeps the accepted snapshot whole, unknown versions and extra keys included', () => {
    // The snapshot is hashed as one object: stripping a key changes it.
    const snapshot = { snapshot_version: 7, amount: 1, novel_term: { nested: ['x'] } }
    const doc = rec(v1Evidence({ accepted_agreement: snapshot }))
    expect(doc.accepted_agreement).toEqual(snapshot)
    expect(doc.accepted_agreement).not.toBe(snapshot)
    expect(doc.accepted_agreement_note).toMatch(/does not check it against any hash/)
  })

  it('recomputes to the same digest as the snapshot it was given, unknown version included', async () => {
    // The byte claim, checked: the agreement digest is taken over the stable
    // serialization of the whole snapshot, so the copy must hash identically.
    const snapshot = { snapshot_version: 7, amount: 1, dod: ['a', 'b'], novel_term: { nested: ['x', null] } }
    const doc = rec(v1Evidence({ accepted_agreement: snapshot }))
    expect(await sha256Hex(stableStringify(doc.accepted_agreement)))
      .toBe(await sha256Hex(stableStringify(snapshot)))
  })

  it('tells a record with no snapshot from a response without the field', () => {
    const none = rec(v1Evidence({ accepted_agreement: null }))
    expect(none.accepted_agreement).toBeNull()
    expect(none.accepted_agreement_note).toMatch(/The record has no accepted snapshot/)
    const body = v1Evidence()
    delete body.accepted_agreement
    const absent = rec(body)
    expect(absent.accepted_agreement).toBeNull()
    expect(absent.accepted_agreement_note).toMatch(/did not include an accepted snapshot field/)
  })

  it('keeps the authentication record raw and says it is not verified', () => {
    const id = rec(v1Evidence()).acceptance_identity
    expect(id.authentication_detail).toEqual({ method: 'invite_capability', nested: { kept: true } })
    expect(id.authentication).toBe('invite_capability')
    expect(id.authentication_fields_are).toMatch(/not independently verified/)
    expect(id.claimed_identity_verified).toBe(false)
  })

  it('keeps the server results it carries, and leaves absent ones absent', () => {
    const [e] = rec(v1Evidence()).events
    expect(e.server_verification).toEqual(integrity())
    const partial = { ...integrity() }
    delete partial.binds_whole_agreement
    const [p] = rec(v1Evidence({ events: [{ ...v1Evidence().events[0], integrity: partial }] })).events
    expect('binds_whole_agreement' in p.server_verification).toBe(false)
  })

  it('keeps the accepted terms apart from the current ones', () => {
    const changed = rec(v1Evidence({
      terms_changed_since_acceptance: ['amount'],
      contract: { ...CONTRACT, amount_jpy: 99000 },
    }))
    expect(changed.accepted_agreement.amount).toBe(48000)
    expect(changed.current_terms.amount_jpy).toBe(99000)
    expect(changed.terms_changed_since_acceptance).toEqual(['amount'])
  })
})

describe('verification', () => {
  const withRows = (rows, chain = {}) => rec(v1Evidence({
    events: rows.map((i, n) => ({ ...v1Evidence().events[0], id: `e${n}`, integrity: i })),
    chain: { ...v1Evidence().chain, ...chain },
  }))

  it('carries the server verdict rather than deriving one of its own', () => {
    expect(rec(v1Evidence()).verification.server_verdict).toBe(true)
    expect(withRows([integrity()], { verified: false }).verification.server_verdict).toBe(false)
  })

  it('names the reason a chain did not verify, over every row', () => {
    const status = i => withRows([i], { verified: false }).verification.status
    expect(rec(v1Evidence()).verification.status).toBe('VERIFIED')
    expect(status(integrity({ hash_valid: false }))).toBe('HASH_MISMATCH_DETECTED')
    expect(status(integrity({ chain_linked: false }))).toBe('CHAIN_LINK_BROKEN')
    expect(status(integrity({ substance_valid: false }))).toBe('PAYLOAD_MISMATCH_DETECTED')
    // A legacy row's failure still names the status when a v2+ row is present.
    expect(withRows([integrity({ canonical_version: 1, hash_valid: false }), integrity()]).verification.status)
      .toBe('HASH_MISMATCH_DETECTED')
  })

  it('reports no v2-or-later events as its own state, not as unverified', () => {
    const doc = withRows([integrity({ canonical_version: 1 })], { verified: false })
    expect(doc.verification.status).toBe('NO_EVENTS_FORMAT_V2_OR_LATER')
    expect(doc.verification.status).not.toBe('NOT_VERIFIED')
    expect(doc.verification.events_format_below_v2).toBe(1)
  })

  it('counts formats from the rows, unrecognised ones included', () => {
    const v = withRows([
      integrity({ canonical_version: 9, canonical_version_supported: false, hash_valid: null }),
      integrity({ canonical_version: 0, canonical_version_supported: false, hash_valid: null }),
    ], { verified: false }).verification
    expect([v.events_format_v2_or_later, v.events_format_below_v2, v.events_format_not_recognised]).toEqual([1, 1, 2])
  })

  it('surfaces truncation without saying later events exist', () => {
    const v = withRows([integrity()], { truncated: true }).verification
    expect(v.truncated).toBe(true)
    expect(v.truncation_note).toMatch(/Additional events may exist and were not checked here/)
    expect(rec(v1Evidence()).verification.truncation_note).toBeNull()
  })
})

describe('check_summary: every row, beside a status with limited precedence', () => {
  const withRows = (rows, chain = {}) => rec(v1Evidence({
    events: rows.map((i, n) => ({ ...v1Evidence().events[0], id: `e${n}`, integrity: i })),
    chain: { ...v1Evidence().chain, ...chain },
  })).verification

  it('reports a v1-only mismatch the status does not reach', () => {
    const v = withRows([integrity({ canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null })],
      { verified: false })
    expect(v.status).toBe('NO_EVENTS_FORMAT_V2_OR_LATER')
    expect(v.check_summary.any_mismatch).toBe(true)
    expect(v.check_summary.mismatched_event_ids).toEqual(['e0'])
  })

  it('reports a v1 mismatch beside a v2 row that passed', () => {
    const v = withRows([
      integrity({ canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null }),
      integrity(),
    ], { verified: true })
    expect(v.server_verdict).toBe(true)
    expect(v.check_summary.any_mismatch).toBe(true)
    expect(v.check_summary.mismatched_event_ids).toEqual(['e0'])
    expect(v.check_summary.by_check.hash_valid).toEqual({ matched: 1, did_not_match: 1, not_checked: 0 })
  })

  it('reports a payload-only mismatch', () => {
    const v = withRows([integrity({ substance_valid: false })], { verified: false })
    expect(v.status).toBe('PAYLOAD_MISMATCH_DETECTED')
    expect(v.check_summary.by_check.substance_valid.did_not_match).toBe(1)
  })

  it('shows checks that did not run next to VERIFIED, and says VERIFIED is not complete', () => {
    const v = withRows([integrity({ substance_valid: null }), integrity({ chain_linked: null })], { verified: true })
    expect(v.status).toBe('VERIFIED')
    expect(v.check_summary.any_mismatch).toBe(false)
    expect(v.check_summary.checks_not_run).toBe(2)
    expect(v.status_note).toMatch(/NO_EVENTS_FORMAT_V2_OR_LATER is reported before any mismatch is examined/)
    expect(v.status_note).toMatch(/It is not a complete integrity guarantee/)
  })
})

describe('refusals', () => {
  it('refuses to produce a document with nothing in it', () => {
    expect(() => buildGuestRecordDocument(v1Evidence({ events: [] }))).toThrow(/no readable events/)
    expect(() => buildGuestRecordDocument(v1Evidence({ contract: null }))).toThrow(/no agreement/)
    expect(() => buildGuestRecordDocument(null)).toThrow()
  })

  it('refuses a response it does not understand rather than exporting part of it', () => {
    const missingCheck = { ...integrity() }
    delete missingCheck.hash_valid
    expect(() => buildGuestRecordDocument(v1Evidence({
      events: [{ ...v1Evidence().events[0], integrity: missingCheck }],
    }))).toThrow(/unsupported or invalid response \(events\[0\]\.integrity\.hash_valid\)/)
    expect(() => buildGuestRecordDocument(v2Evidence({ response_version: 3 })))
      .toThrow(/unsupported or invalid response \(response_version\)/)
    expect(() => buildGuestRecordDocument(v1Evidence({
      events: [{ ...v1Evidence().events[0], integrity: integrity({ canonical_version: '4' }) }],
    }))).toThrow(/invalid response/)
  })
})
