import { describe, it, expect } from 'vitest'
import {
  guestResponse, readBoundary, requestedResponseVersion, serverDecision, shadowStrictLog, termsChangedSinceAcceptance,
} from '../../supabase/functions/_shared/guestResponse.ts'
import {
  CANONICAL_INPUTS_V5, canonicalInputsOf, chainSummary, guestVerificationNotes, guestVerificationNotesV2,
  shapeGuestEventsV1,
} from '../../supabase/functions/_shared/guestEventView.ts'
import { eventCanonical, payloadHash, sha256Hex, stableStringify } from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildEventCanonicalV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import { parseGuestEvidence, coverageStatements, summaryPresentation, truncationNotice } from '../../src/lib/eventFormat.js'
import { buildGuestRecordDocument } from '../../src/lib/guestRecordExport.js'

// Task 202: response version 2 behind ?response_version=2, with version 1
// byte-identical for every request that does not ask for it.

const CID = '22222222-2222-4222-8222-222222222222'
const hex = c => c.repeat(64)
const vid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
let tick = Date.parse('2026-03-01T00:00:00.000Z')
const at = () => new Date((tick += 1000)).toISOString()
const SNAPSHOT = { amount: 1250, currency: 'CAD', deadline: null, dod: ['Translate'], offered_by: 'Example',
  performed_by: 'creator', project_name: 'Example', snapshot_version: 1 }
const OWNER = vid(6)
const CONTRACT = {
  id: CID, project_name: 'Example', dod: ['Translate'], amount_jpy: null, amount_minor: 1250, currency: 'CAD',
  deadline: null, state: 'active', performed_by: 'creator', earner_user_id: OWNER, earner_display_name: 'Example',
  hirer_email: 'guest@example.test',
}
const nullAuthority = r => ({ ...r, credential_id: null, issuer_kind: null })

/** Version 2 over a read whose exact count matches the rows, unless overridden. */
async function serve2(rowsOrPromise, over = {}) {
  const rows = await rowsOrPromise
  return guestResponse(rows, CONTRACT, { version: 2, maxEvents: 500, count: rows.length, ...over })
}

async function rawLegacy(n, prev, { type = 'performance.asserted', payload = { note: `n${n}` }, agreement, actor = 'owner' } = {}) {
  const row = { id: vid(n), type, actor_id: actor, dod_hash: hex('1'), created_at: at(), prev_event_hash: prev,
    payload, payload_hash: await payloadHash(payload), agreement_hash: agreement, hash_version: 4 }
  row.event_hash = await sha256Hex(eventCanonical({ ...row, contract_id: CID }, 4))
  return row
}
async function rawV5(n, prev, { agreement, payload = { note: `v5-${n}` } } = {}) {
  const row = { id: vid(n), type: 'payment.reported', actor_id: OWNER, dod_hash: hex('1'), created_at: at(),
    prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement, hash_version: 5,
    credential_id: vid(7), issuer_kind: 'counterpart_account' }
  const built = buildEventCanonicalV5({ ...row, contract_id: CID })
  if (!built.ok) throw new Error(built.field)
  row.event_hash = await sha256Hex(built.canonical)
  return row
}
/** Acceptance (v4), a v5 act, a v4 act — as the endpoint SELECTs them. */
async function mixedTrail() {
  const accepted = await sha256Hex(stableStringify(SNAPSHOT))
  const a = await rawLegacy(1, 'GENESIS', {
    type: 'dod.consent_recorded', agreement: accepted, actor: 'guest:guest@example.test',
    payload: { _agreement: SNAPSHOT, _invited_recipient: 'guest@example.test', counterparty_name: 'G' },
  })
  const b = await rawV5(2, a.event_hash, { agreement: accepted })
  const c = await rawLegacy(3, b.event_hash, { agreement: accepted, actor: OWNER })
  return [nullAuthority(a), b, nullAuthority(c)]
}
async function legacyTrail() {
  const [a] = await mixedTrail()
  const c = await rawLegacy(4, a.event_hash, { agreement: a.agreement_hash, actor: OWNER })
  return [a, nullAuthority(c)]
}

/** Version 1 assembled from today's building blocks, key list written out here. */
async function expectedV1(rows) {
  const events = await shapeGuestEventsV1(rows, CONTRACT)
  const acc = rows.find(r => r.type === 'dod.consent_recorded')
  return {
    accepted_agreement: acc?.payload?._agreement ?? null,
    terms_changed_since_acceptance: termsChangedSinceAcceptance(acc?.payload?._agreement ?? null, CONTRACT),
    acceptance_identity: acc ? {
      invited_recipient: acc.payload._invited_recipient ?? null,
      claimed_identity: acc.payload._claimed_identity ?? null,
      claimed_identity_verified: false,
      authentication: acc.payload._auth_method ?? null,
      authentication_detail: acc.payload._authentication ?? null,
    } : null,
    contract: {
      id: CONTRACT.id, project_name: CONTRACT.project_name, dod: CONTRACT.dod, amount_jpy: CONTRACT.amount_jpy,
      amount_minor: CONTRACT.amount_minor, currency: CONTRACT.currency, deadline: CONTRACT.deadline,
      state: CONTRACT.state, performed_by: CONTRACT.performed_by, viewer_role: 'receiver',
      earner_display_name: CONTRACT.earner_display_name, hirer_email: CONTRACT.hirer_email,
    },
    events,
    verification: guestVerificationNotes(),
    chain: chainSummary(events, { truncated: false }),
  }
}

describe('requestedResponseVersion', () => {
  const u = q => `https://x.supabase.co/functions/v1/guest-contract-events${q}`
  it('absent is version 1; exactly one 2 is version 2', () => {
    expect(requestedResponseVersion(u(''))).toEqual({ ok: true, version: 1 })
    expect(requestedResponseVersion(u('?other=1'))).toEqual({ ok: true, version: 1 })
    expect(requestedResponseVersion(u('?response_version=2'))).toEqual({ ok: true, version: 2 })
  })
  it('another integer is unsupported; anything else is invalid, never guessed', () => {
    for (const q of ['1', '3', '0']) {
      expect(requestedResponseVersion(u(`?response_version=${q}`)).error, q).toBe('unsupported_response_version')
    }
    for (const q of ['?response_version=', '?response_version=2&response_version=2', '?response_version=02',
      '?response_version=2.0', '?response_version=two', '?response_version=%202']) {
      expect(requestedResponseVersion(u(q)), q).toEqual({ ok: false, status: 400, error: 'invalid_response_version' })
    }
  })
})

describe('version 1 stays byte-identical', () => {
  for (const [name, trail] of [['legacy trail', legacyTrail], ['mixed trail with a v5 row', mixedTrail]]) {
    it(`${name}: the serialized body equals today's assembly`, async () => {
      const rows = await trail()
      const { body } = await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500 })
      expect(JSON.stringify(body)).toBe(JSON.stringify(await expectedV1(rows)))
      const text = JSON.stringify(body)
      for (const absent of ['response_version', 'strict', 'provenance', 'credential_id', 'issuer_kind', 'recorded_id_class',
        'recorded_credential']) {
        expect(text, absent).not.toContain(absent)
      }
    })
  }
  it('an empty trail is still the version 1 body', async () => {
    const { body } = await guestResponse([], CONTRACT, { version: 1, maxEvents: 500 })
    expect(JSON.stringify(body)).toBe(JSON.stringify(await expectedV1([])))
  })
})

describe('version 2', () => {
  it('keeps the head, replaces the labels, and adds the strict verdicts', async () => {
    const rows = await mixedTrail()
    const v1 = (await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500 })).body
    const { body } = await serve2(rows)
    expect(Object.keys(body)).toEqual(['response_version', 'accepted_agreement', 'terms_changed_since_acceptance',
      'acceptance_identity', 'contract', 'events', 'verification', 'chain', 'strict_verification'])
    expect(body.response_version).toBe(2)
    for (const key of ['accepted_agreement', 'terms_changed_since_acceptance', 'acceptance_identity', 'contract']) {
      expect(body[key], key).toEqual(v1[key])
    }
    expect(body.verification).toEqual(guestVerificationNotesV2())
    expect(JSON.stringify(body)).not.toContain('trust_model')
    expect(Object.keys(body.chain)).toEqual(['event_count', 'events_format_v2_or_later', 'events_format_below_v2',
      'verified', 'unsupported_canonical_versions', 'truncated', 'payload_covered_by_hash'])
    expect(body.chain).toMatchObject({ event_count: 3, events_format_v2_or_later: 3, events_format_below_v2: 0,
      verified: true, unsupported_canonical_versions: [] })
    expect(body.strict_verification.server.overall).toBe('verified')
    expect(body.strict_verification.server_agreement).toMatchObject({ status: 'ok', acceptance_index: 0 })
    expect(body.strict_verification.local_note).toMatch(/cannot\s+reach a verified payload/)
  })

  it('actor is the recorded id and its class; nobody is named', async () => {
    const { body } = await serve2(await mixedTrail())
    expect(body.events.map(e => e.actor.recorded_id_class))
      .toEqual(['guest_prefixed', 'matches_contract_earner_id', 'matches_contract_earner_id'])
    for (const e of body.events) {
      expect(Object.keys(e.actor)).toEqual(['id', 'attribution', 'recorded_id_class'])
      expect(e.provenance).toEqual({ writer: 'unknown', basis: 'none_recorded' })
    }
  })

  it('recorded_credential: the delegated v5 row names its grant; every other row is null (row 4)', async () => {
    const { assuranceForRecord, grantAssurance } = await import('../../supabase/functions/_shared/authAssurance.ts')
    const [a] = await mixedTrail()
    const accepted = a.agreement_hash
    const delegated = await rawV5(2, a.event_hash, { agreement: accepted,
      payload: { note: 'paid', _auth_method: 'entry_agent_grant', _authentication: assuranceForRecord(grantAssurance()) } })
    const legacy = await rawLegacy(3, delegated.event_hash, { agreement: accepted, actor: OWNER,
      payload: { note: 'x', _authentication: { credential: 'account_jwt' } } })
    const plainV5 = await rawV5(4, legacy.event_hash, { agreement: accepted })
    const { body } = await serve2([nullAuthority(a), delegated, nullAuthority(legacy), plainV5])
    expect(body.events.map(e => e.recorded_credential)).toEqual([null, 'entry_agent_grant', null, null])
    for (const e of body.events) {
      expect(Object.keys(e)).toEqual(['id', 'type', 'created_at', 'actor', 'provenance', 'recorded_credential',
        'dod_hash', 'payload', 'canonical', 'integrity'])
      // Additive only: provenance says what it always said.
      expect(e.provenance).toEqual({ writer: 'unknown', basis: 'none_recorded' })
    }
    // The label never leaks through the payload projection.
    expect(JSON.stringify(body.events[1].payload)).not.toContain('_authentication')
    // The body still parses as version 2 on the frontend.
    expect(parseGuestEvidence(body)).toEqual({ ok: true, version: 2 })
    const v1 = (await guestResponse([nullAuthority(a), delegated], CONTRACT, { version: 1, maxEvents: 500 })).body
    expect(JSON.stringify(v1)).not.toContain('recorded_credential')
  })

  it('legacy rows keep version 1 values and blocks; the v5 row gets its exact 12 inputs and strict results', async () => {
    const rows = await mixedTrail()
    const v1 = (await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500 })).body
    const { body } = await serve2(rows)
    for (const i of [0, 2]) {
      const { trust_model: _t, ...rest } = v1.events[i].integrity
      const { strict, ...v2rest } = body.events[i].integrity
      expect(v2rest).toEqual(rest)
      expect(strict.kind).toBe('legacy')
      expect(body.events[i].canonical).toEqual(canonicalInputsOf(rows[i], CID))
    }
    const v5 = body.events[1]
    expect(Object.keys(v5.canonical).sort()).toEqual([...CANONICAL_INPUTS_V5].sort())
    expect(v5.canonical.credential_id).toBe(vid(7))
    expect(v5.integrity).toMatchObject({ canonical_version: 5, canonical_version_supported: true, hash_valid: true,
      chain_linked: true, substance_valid: true, binds_whole_agreement: true,
      strict: { kind: 'v5', hash: 'match', link: 'linked', payload: 'match', agreement: 'match' } })
    // Version 1 says of the same row what it always has.
    expect(v1.events[1].integrity).toMatchObject({ canonical_version_supported: false, hash_valid: null })
  })

  it('an authority-bearing v4 row is invalid and unchecked, and the trail is not verified', async () => {
    const [a, , c] = await mixedTrail()
    const bad = { ...c, credential_id: vid(7), issuer_kind: 'counterpart_account' }
    const { body } = await serve2([a, bad])
    expect(body.events[1].integrity).toMatchObject({ hash_valid: null, chain_linked: null, substance_valid: null,
      canonical_version_supported: false, binds_whole_agreement: false, strict: { kind: 'invalid' } })
    expect(typeof body.events[1].integrity.strict.reason).toBe('string')
    expect(body.chain.verified).toBe(false)
    expect(body.strict_verification.server.overall).toBe('failed')
  })

  it('a v5 payload that no longer matches its digest is a mismatch', async () => {
    const rows = await mixedTrail()
    rows[1] = { ...rows[1], payload: { note: 'edited' } }
    const { body } = await serve2(rows)
    expect(body.events[1].integrity).toMatchObject({ substance_valid: false, strict: { payload: 'mismatch' } })
    expect(body.chain.verified).toBe(false)
    expect(body.strict_verification.server.overall).toBe('failed')
  })

  it('positive control: every dimension passes over an established read, and both verdicts agree', async () => {
    const { body } = await serve2(mixedTrail())
    expect(body.strict_verification.server.dimensions).toEqual(
      { hash: 'pass', link: 'pass', payload: 'pass', agreement: 'pass', completeness: 'pass' })
    expect(body.strict_verification.server.read_boundary).toEqual({ start: 'first_event', tail: 'complete', recorded_count: 3 })
    expect(body.chain).toMatchObject({ verified: true, truncated: false })
    expect(body.strict_verification.server.overall).toBe('verified')
  })

  it('incomplete with no proven failure: an unproven tail is never verified, and nothing is called failed', async () => {
    const rows = await mixedTrail()
    for (const [count, tail] of [[undefined, 'unknown'], [null, 'unknown'], [rows.length + 1, 'truncated'], [rows.length - 1, 'unknown']]) {
      const { body } = await serve2(rows, { count })
      expect(body.strict_verification.server.read_boundary.tail, String(count)).toBe(tail)
      expect(body.strict_verification.server.overall, String(count)).toBe('incomplete')
      expect(body.strict_verification.server.dimensions.completeness).toBe('indeterminate')
      for (const d of ['hash', 'link', 'payload', 'agreement']) expect(body.strict_verification.server.dimensions[d]).toBe('pass')
      expect(body.chain).toMatchObject({ verified: false, truncated: true })
      expect(parseGuestEvidence(body)).toEqual({ ok: true, version: 2 })
    }
  })

  it('a short page is not evidence of the end: below the cap, with a larger count, the tail is truncated', async () => {
    const rows = await mixedTrail()
    const v1 = (await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500, count: 101 })).body
    expect(v1.chain.truncated).toBe(false) // version 1's frozen cap rule
    const { body } = await serve2(rows, { count: 101 })
    expect(body.chain.truncated).toBe(true)
    expect(body.chain.verified).toBe(false)
  })

  it('an empty trail is not verified in version 2', async () => {
    const { body } = await serve2([])
    expect(body.chain.verified).toBe(false)
    expect(body.strict_verification.server.overall).toBe('incomplete')
  })

  it('the v1 headline and the v2 headline can differ on the same rows, by design', async () => {
    const rows = await mixedTrail()
    rows[1] = { ...rows[1], payload: { note: 'edited' } }
    const v1 = (await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500 })).body
    const { body } = await serve2(rows)
    expect(v1.chain.verified).toBe(false) // v1 cannot check a v5 row, so it is unsupported there
    expect(body.chain.verified).toBe(false)
    // A v4 trail with a payload that no longer matches: v1's rule says verified, v2's does not.
    const legacy = await legacyTrail()
    legacy[1] = { ...legacy[1], payload: { note: 'edited' } }
    expect((await guestResponse(legacy, CONTRACT, { version: 1, maxEvents: 500 })).body.chain.verified).toBe(true)
    const v2 = (await serve2(legacy)).body
    expect(v2.events[1].integrity.substance_valid).toBe(false)
    expect(v2.chain.verified).toBe(false)
    expect(v2.strict_verification.server.overall).toBe('failed')
  })
})

describe('readBoundary and serverDecision', () => {
  it('complete only from an exact count equal to the rows returned', () => {
    expect(readBoundary(3, 3).tail).toBe('complete')
    expect(readBoundary(3, 4).tail).toBe('truncated')
    for (const c of [2, undefined, null, '3', 3.5, -1, Number.NaN]) expect(readBoundary(3, c).tail, String(c)).toBe('unknown')
  })
  it('one decision: verified only over an established boundary; failed stays failed', () => {
    const complete = readBoundary(1, 1)
    const unknown = readBoundary(1, null)
    expect(serverDecision('verified', complete)).toEqual({ overall: 'verified', verified: true })
    expect(serverDecision('verified', unknown)).toEqual({ overall: 'incomplete', verified: false })
    expect(serverDecision('failed', unknown)).toEqual({ overall: 'failed', verified: false })
    expect(serverDecision('incomplete', complete)).toEqual({ overall: 'incomplete', verified: false })
  })
})

describe('version 1 is isolated from strict-only exceptions (Codex T174)', () => {
  const boom = () => { throw new Error('strict only') }
  it('version 1 never runs the strict reader; version 2 fails closed', async () => {
    const rows = await mixedTrail()
    const { body, strict } = await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500, strictReader: boom })
    expect(strict).toBeNull()
    expect(JSON.stringify(body)).toBe(JSON.stringify(await expectedV1(rows)))
    await expect(serve2(rows, { strictReader: boom })).rejects.toThrow('strict only')
  })
  it('the shadow log never throws, and names only the error class', async () => {
    const rows = await mixedTrail()
    const response = await guestResponse(rows, CONTRACT, { version: 1, maxEvents: 500 })
    const log = await shadowStrictLog(rows, CONTRACT, response, { version: 1, count: 3, strictReader: boom })
    expect(log).toEqual({ event: 'guest_strict_reader_error', response_version: 1, error_class: 'Error' })
    const ok = await shadowStrictLog(rows, CONTRACT, response, { version: 1, count: 3 })
    expect(ok).toMatchObject({ event: 'guest_strict_reader', strict_rows: 1, strict_overall: 'verified', tail: 'complete' })
    expect(JSON.stringify(ok)).not.toContain(vid(7))
  })
})

describe('the frontend reads version 2 and refuses labels it does not know', () => {
  it('a real version 2 body parses as version 2', async () => {
    const { body } = await serve2(mixedTrail())
    expect(parseGuestEvidence(body)).toEqual({ ok: true, version: 2 })
  })

  it('an unknown strict label refuses the whole body', async () => {
    const { body } = await serve2(await mixedTrail())
    const clone = () => JSON.parse(JSON.stringify(body))
    const cases = [
      [b => { b.strict_verification.server.overall = 'ok' }, 'strict_verification.server.overall'],
      [b => { b.strict_verification.server.dimensions.hash = true }, 'strict_verification.server.dimensions.hash'],
      [b => { b.strict_verification = null }, 'strict_verification'],
      [b => { b.events[1].integrity.strict.kind = 'v6' }, 'events[1].integrity.strict.kind'],
      [b => { b.events[1].integrity.strict.agreement = 'fine' }, 'events[1].integrity.strict.agreement'],
      [b => { b.events[0].integrity.strict = 'legacy' }, 'events[0].integrity.strict'],
    ]
    for (const [mutate, reason] of cases) {
      const b = clone()
      mutate(b)
      expect(parseGuestEvidence(b), reason).toEqual({ ok: false, reason })
    }
  })

  it('a format 5 event gets its own coverage sentence', async () => {
    const { body } = await serve2(await mixedTrail())
    const lines = coverageStatements(body.events)
    expect(lines.some(l => /^Format v5 hashes bind .*credential id and issuer kind/.test(l))).toBe(true)
    expect(lines.join(' ')).not.toMatch(/does not recognise/)
  })
})

describe('the counterparty document from a version 2 body', () => {
  it('carries the v5 block whole and the strict verdicts from fixed keys', async () => {
    const { body } = await serve2(await mixedTrail())
    const doc = buildGuestRecordDocument(body).trustflow_counterparty_record
    const v5 = doc.events[1]
    expect(v5.canonical_missing).toEqual([])
    expect(v5.canonical.credential_id).toBe(vid(7))
    expect(v5.canonical.issuer_kind).toBe('counterpart_account')
    expect(v5.server_verification.strict).toEqual(body.events[1].integrity.strict)
    expect(doc.verification.server_verdict).toBe(true)
    expect(doc.verification.status).toBe('VERIFIED')
    expect(doc.verification.server_strict_verdict).toMatchObject({ overall: 'verified',
      dimensions: body.strict_verification.server.dimensions })
  })

  it('an invalid authority-bearing row keeps its authority fields and its invalid result', async () => {
    const [a, , c] = await mixedTrail()
    const bad = { ...c, credential_id: vid(7), issuer_kind: 'counterpart_account' }
    const { body } = await serve2([a, bad])
    const doc = buildGuestRecordDocument(body).trustflow_counterparty_record
    expect(doc.events[1].canonical.credential_id).toBe(vid(7))
    expect(doc.events[1].canonical.issuer_kind).toBe('counterpart_account')
    expect(doc.events[1].server_verification.strict.kind).toBe('invalid')
    expect(doc.verification).toMatchObject({ server_verdict: false, status: 'NOT_VERIFIED',
      server_verdict_basis: 'strict_check_over_established_read', server_strict_verdict: { overall: 'failed' } })
    expect(doc.verification.status_note).toMatch(/strict check passed every\s*dimension/)
  })

  it('an incomplete read: the document says NOT_VERIFIED and that it is incomplete, not failed', async () => {
    const { body } = await serve2(mixedTrail(), { count: null })
    const doc = buildGuestRecordDocument(body).trustflow_counterparty_record
    expect(doc.verification).toMatchObject({ server_verdict: false, status: 'NOT_VERIFIED',
      server_strict_verdict: { overall: 'incomplete', read_boundary: { tail: 'unknown' } } })
  })

  it('a v5 block with an authority input missing lists it as missing', async () => {
    const { body } = await serve2(await mixedTrail())
    delete body.events[1].canonical.issuer_kind
    const doc = buildGuestRecordDocument(body).trustflow_counterparty_record
    expect(doc.events[1].canonical_missing).toEqual(['issuer_kind'])
  })

  it('a version 1 body yields no strict keys in the document', async () => {
    const { body } = await guestResponse(await mixedTrail(), CONTRACT, { version: 1, maxEvents: 500 })
    const doc = buildGuestRecordDocument(body).trustflow_counterparty_record
    expect('server_strict_verdict' in doc.verification).toBe(false)
    expect(doc.verification.server_verdict_basis).toBe('version_1_rule_format_v2_or_later_rows')
    expect(doc.events.some(e => 'strict' in e.server_verification)).toBe(false)
  })
})

// ── T206: real endpoint bodies through the screen's prose ───────────────────
describe('T206: endpoint v2 bodies and the guest prose', () => {
  it('a later v4 act citing different terms: strict failed, and the prose says so', async () => {
    const rows = await mixedTrail()
    const other = await rawLegacy(5, rows[2].event_hash, { agreement: 'f'.repeat(64), actor: OWNER })
    const { body } = await serve2([...rows, nullAuthority(other)])
    expect(body.events.every(e => e.integrity.hash_valid !== false && e.integrity.chain_linked !== false
      && e.integrity.substance_valid !== false)).toBe(true)
    expect(body.strict_verification.server.dimensions.agreement).toBe('fail')
    expect(parseGuestEvidence(body)).toEqual({ ok: true, version: 2 })
    const s = summaryPresentation(body)
    expect(s.overall.tone).toBe('mismatch')
    expect(s.overall.text).toMatch(/in: agreement, on 1 event/)
  })
  it('incomplete endpoint bodies get the boundary notice, never the cap sentence', async () => {
    const rows = await mixedTrail()
    const unknown = (await serve2(rows, { count: null })).body
    expect(truncationNotice(unknown)).toMatch(/could not establish/)
    const truncated = (await serve2(rows, { count: rows.length + 1 })).body
    expect(truncationNotice(truncated)).toMatch(/recorded more events/)
    expect(truncationNotice((await serve2(rows)).body)).toBeNull()
  })
})

// ── T208: every real endpoint body variant passes the stricter parser ───────
describe('T208: endpoint v2 bodies satisfy the row/aggregate rules', () => {
  it('complete, unknown, truncated, empty, invalid row, payload and agreement mismatch', async () => {
    const rows = await mixedTrail()
    const [a, , c] = rows
    const editedPayload = [...rows]; editedPayload[1] = { ...rows[1], payload: { note: 'edited' } }
    const other = await rawLegacy(5, rows[2].event_hash, { agreement: 'f'.repeat(64), actor: OWNER })
    const variants = {
      complete: await serve2(rows),
      unknown: await serve2(rows, { count: null }),
      truncated: await serve2(rows, { count: rows.length + 1 }),
      empty: await serve2([]),
      invalid: await serve2([a, { ...c, credential_id: vid(7), issuer_kind: 'counterpart_account' }]),
      payload: await serve2(editedPayload),
      agreement: await serve2([...rows, nullAuthority(other)]),
    }
    for (const [name, { body }] of Object.entries(variants)) {
      expect(parseGuestEvidence(body), name).toEqual({ ok: true, version: 2 })
    }
    expect(variants.empty.body.chain.verified).toBe(false)
  })

  it('T210: an unsupported row and a rejected acceptance marker parse, and neither is verified', async () => {
    const rows = await mixedTrail()
    const unsupported = await serve2([...rows.slice(0, 2), { ...rows[2], hash_version: 9 }])
    expect(unsupported.body.events[2].integrity.strict).toMatchObject({ kind: 'unsupported', hash: 'unsupported' })
    // Two acceptances in one slice: the strict reader rejects the marker.
    const rejected = await serve2([...rows, { ...rows[0], id: vid(8) }])
    expect(rejected.body.strict_verification.server.acceptance.status).toBe('rejected')
    for (const [name, { body }] of Object.entries({ unsupported, rejected })) {
      expect(parseGuestEvidence(body), name).toEqual({ ok: true, version: 2 })
      expect(body.chain.verified, name).toBe(false)
    }
  })
})

