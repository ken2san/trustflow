import { describe, it, expect } from 'vitest'
import {
  parseGuestEvidence, formatPartition, checkOutcomes, summaryPresentation,
  guestChainStatus, rowCheckState, formatLabel, coverageStatements, checkSummary,
  payloadProjectionNote, truncationNotice,
} from '../../src/lib/eventFormat.js'

// What a guest is told about their record, and when they are told nothing.
// The rank-1 provenance fix (Tasks 124-129): the hash format was presented as
// "server-attested", the summary was worded from a boolean that ignores rows
// below format v2, and a malformed row could drop out of the counts. Each of
// those is pinned below.

const integrity = (over = {}) => ({
  canonical_version: 4, canonical_version_supported: true,
  hash_valid: true, chain_linked: true, substance_valid: true,
  ...over,
})
const ev = (id, over = {}) => ({ id, type: 'performance.asserted', integrity: integrity(over) })
/**
 * A version 2 body: strict verdicts on every row and on the trail, consistent
 * under the parser's rules (overall from dimensions, tail from the count,
 * chain.truncated and chain.verified from those). `dims` overrides dimensions.
 */
const asV2 = (body, { dims = {}, tail } = {}) => {
  const t = tail ?? (body.chain.truncated ? 'unknown' : 'complete')
  const dimensions = { hash: 'pass', link: 'pass', payload: 'pass', agreement: 'pass',
    completeness: body.chain.verified && t === 'complete' && body.events.length > 0 ? 'pass' : 'indeterminate', ...dims }
  const all = Object.values(dimensions)
  const overall = all.includes('fail') ? 'failed' : all.every(d => d === 'pass') ? 'verified' : 'incomplete'
  const n = body.events.length
  // The last event carries the row label behind any dimension override, so
  // the aggregate can be derived from the rows (Codex T177).
  const rowLabel = { fail: { hash: 'mismatch', link: 'broken', payload: 'mismatch', agreement: 'mismatch' },
    indeterminate: { hash: 'missing', link: 'indeterminate', payload: 'indeterminate', agreement: 'indeterminate' } }
  const lastStrict = { kind: 'legacy', hash: 'match', link: 'linked', payload: 'match', agreement: 'match' }
  for (const [k, v] of Object.entries(dims)) if (k !== 'completeness' && rowLabel[v]) lastStrict[k] = rowLabel[v][k]
  return {
    ...body,
    response_version: 2,
    chain: { ...body.chain, verified: overall === 'verified', truncated: t !== 'complete' },
    events: body.events.map((e, i) => ({ ...e, integrity: { ...e.integrity,
      strict: i === n - 1 ? { ...lastStrict }
        : { kind: 'legacy', hash: 'match', link: 'linked', payload: 'match', agreement: 'match' } } })),
    strict_verification: {
      server: {
        overall, dimensions,
        acceptance: { status: 'caller' },
        read_boundary: { start: 'first_event', tail: t,
          recorded_count: t === 'complete' ? n : t === 'truncated' ? n + 1 : null },
      },
      server_agreement: { status: 'no_acceptance', hash: null, acceptance_index: null },
      local_note: 'x',
    },
  }
}
const evidence = (events, chain = {}) => ({
  contract: { id: 'c1' },
  events,
  chain: { event_count: events.length, verified: true, truncated: false, ...chain },
})

describe('parseGuestEvidence: a response is understood whole or refused', () => {
  it('reads an absent response_version as 1 and exactly 2 as 2', () => {
    expect(parseGuestEvidence(evidence([ev('a')]))).toEqual({ ok: true, version: 1 })
    expect(parseGuestEvidence(asV2(evidence([ev('a')])))).toEqual({ ok: true, version: 2 })
  })

  it('version 2 must carry the strict verdicts, consistent with chain.verified; version 1 must not', () => {
    const body = asV2(evidence([ev('a')]))
    const { strict_verification: _s, ...noTrail } = body
    expect(parseGuestEvidence(noTrail).reason).toBe('strict_verification')
    const noRow = JSON.parse(JSON.stringify(body))
    delete noRow.events[0].integrity.strict
    expect(parseGuestEvidence(noRow).reason).toBe('events[0].integrity.strict')
    expect(parseGuestEvidence({ ...body, chain: { ...body.chain, verified: false } }).reason).toBe('chain.verified')
    const unbounded = JSON.parse(JSON.stringify(body))
    unbounded.strict_verification.server.read_boundary.tail = 'unknown'
    expect(parseGuestEvidence(unbounded).reason).toBe('strict_verification.server.read_boundary')
    // An unversioned body is version 1, and v2-only verdicts do not belong in it.
    const { response_version: _v, ...v1 } = body
    expect(parseGuestEvidence(v1).reason).toBe('strict_verification')
  })

  it('refuses any other response_version rather than guessing a shape', () => {
    for (const v of ['2', 3, 1, null, 2.5, 0]) {
      expect(parseGuestEvidence({ ...evidence([ev('a')]), response_version: v }), String(v))
        .toEqual({ ok: false, reason: 'response_version' })
    }
  })

  it('tells an absent check result from a null one', () => {
    // null is the server saying it could not check; absent is not understood.
    expect(parseGuestEvidence(evidence([ev('a', { hash_valid: null })])).ok).toBe(true)
    for (const key of ['hash_valid', 'chain_linked', 'substance_valid']) {
      const row = ev('a')
      delete row.integrity[key]
      expect(parseGuestEvidence(evidence([row])), key)
        .toEqual({ ok: false, reason: `events[0].integrity.${key}` })
    }
  })

  it('refuses check results that are not true, false or null', () => {
    for (const bad of ['true', 0, 1, undefined, {}]) {
      expect(parseGuestEvidence(evidence([ev('a', { chain_linked: bad })])).ok, String(bad)).toBe(false)
    }
  })

  it('refuses a missing or non-integer format, and a missing supported flag', () => {
    expect(parseGuestEvidence(evidence([ev('a', { canonical_version: '4' })])).reason)
      .toBe('events[0].integrity.canonical_version')
    expect(parseGuestEvidence(evidence([ev('a', { canonical_version: 2.5 })])).ok).toBe(false)
    expect(parseGuestEvidence(evidence([ev('a', { canonical_version: null })])).ok).toBe(false)
    const noSupported = ev('a')
    delete noSupported.integrity.canonical_version_supported
    expect(parseGuestEvidence(evidence([noSupported])).reason)
      .toBe('events[0].integrity.canonical_version_supported')
  })

  it('refuses a malformed row even when the others are fine', () => {
    // Excluding it from the counts could turn its mismatch into a clean summary.
    const rows = [ev('a'), { id: 'b', type: 'x' }, ev('c', { hash_valid: false })]
    expect(parseGuestEvidence(evidence(rows))).toEqual({ ok: false, reason: 'events[1].integrity' })
  })

  it('refuses a malformed body, chain or canonical block', () => {
    expect(parseGuestEvidence(null).ok).toBe(false)
    expect(parseGuestEvidence([]).ok).toBe(false)
    expect(parseGuestEvidence({ ...evidence([]), contract: null }).reason).toBe('contract')
    expect(parseGuestEvidence({ ...evidence([]), events: {} }).reason).toBe('events')
    expect(parseGuestEvidence({ ...evidence([]), chain: { verified: true } }).reason).toBe('chain.truncated')
    expect(parseGuestEvidence({ ...evidence([]), chain: { truncated: false } }).reason).toBe('chain.verified')
    expect(parseGuestEvidence(evidence([{ ...ev('a'), canonical: ['x'] }])).reason).toBe('events[0].canonical')
    expect(parseGuestEvidence(evidence([{ ...ev('a'), canonical: null }])).ok).toBe(true)
  })

  it('refuses a payload that is not an object, and accepts none or null', () => {
    expect(parseGuestEvidence(evidence([{ ...ev('a'), payload: 'text' }])).reason).toBe('events[0].payload')
    expect(parseGuestEvidence(evidence([{ ...ev('a'), payload: ['x'] }])).reason).toBe('events[0].payload')
    expect(parseGuestEvidence(evidence([{ ...ev('a'), payload: null }])).ok).toBe(true)
    expect(parseGuestEvidence(evidence([ev('a')])).ok).toBe(true)
  })

  it('accepts a well-formed record with no events', () => {
    expect(parseGuestEvidence(evidence([])).ok).toBe(true)
  })
})

describe('formatPartition: a format, never a writer', () => {
  it('counts unknown formats where their number puts them, and separately', () => {
    const rows = [0, 1, 2, 4, 9].map(v => ev(String(v), {
      canonical_version: v, canonical_version_supported: v >= 1 && v <= 4,
    }))
    expect(formatPartition(rows)).toEqual({ v2OrLater: 3, belowV2: 2, notRecognised: 2 })
  })
})

describe('summaryPresentation: every sentence from the row results', () => {
  const text = s => [s.scope, s.formatLine, ...s.checkLines, s.overall.text, s.truncationWarning ?? ''].join(' ')

  it('shows a v1 mismatch the server boolean does not see, with truncation qualified', () => {
    // verified: true is possible here: the server checks only format v2+.
    const s = summaryPresentation(evidence([
      ev('old', { canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null }),
      ev('new'),
    ], { verified: true, truncated: true }))
    expect(s.overall.tone).toBe('mismatch')
    expect(s.overall.text).toMatch(/^1 event has a check that did not match/)
    expect(s.scope).toBe('Among the 2 events returned:')
    // Exactly the cap also counts as truncated: later events may not exist.
    expect(s.truncationWarning).toMatch(/Additional events may exist and were not checked here/)
    expect(text(s)).not.toMatch(/were not returned|chain holds|no hash or link mismatch/i)
  })

  it('keeps the truncation warning when nothing failed', () => {
    const s = summaryPresentation(evidence([ev('a')], { truncated: true }))
    expect(s.overall.tone).toBe('none')
    expect(s.truncationWarning).not.toBeNull()
  })

  it('reports a payload-only mismatch as a mismatch of that check', () => {
    const s = summaryPresentation(evidence([ev('a', { substance_valid: false })]))
    expect(s.overall.tone).toBe('mismatch')
    expect(s.checkLines[2]).toBe('Payload digest: 0 matched, 1 did not match, 0 not checked.')
    expect(s.checkLines[0]).toBe('Event hash: 1 matched, 0 did not match, 0 not checked.')
  })

  it('names which check an unknown format stopped, and still reports a failed link', () => {
    const s = summaryPresentation(evidence([
      ev('a'),
      ev('b', { canonical_version: 9, canonical_version_supported: false, hash_valid: null, chain_linked: false, substance_valid: null }),
    ], { verified: false }))
    expect(s.checkLines[0]).toMatch(/1 not checked \(1 in a format this build does not recognise\)/)
    expect(s.checkLines[1]).toMatch(/1 did not match/)
    expect(s.overall.tone).toBe('mismatch')
    expect(s.formatLine).toMatch(/1 in a format this build does not recognise/)
  })

  it('does not call an unrecognised format a mismatch when nothing failed', () => {
    const s = summaryPresentation(evidence([
      ev('a'),
      ev('b', { canonical_version: 9, canonical_version_supported: false, hash_valid: null, chain_linked: null, substance_valid: null }),
    ], { verified: false }))
    expect(s.overall).toEqual({ tone: 'none', text: 'No check that ran found a mismatch. 3 checks could not run.' })
  })

  it('names a null reason only when the row\'s own fields establish it', () => {
    const s = summaryPresentation(evidence([
      ev('g', { canonical_version: 1, hash_valid: null, chain_linked: null, substance_valid: null,
        event_hash: null, prev_event_hash: null }),
      ev('v2', { canonical_version: 2, chain_linked: true, substance_valid: null }),
      { ...ev('v4', { substance_valid: null }), canonical: { payload_hash: null } },
    ]))
    expect(s.checkLines[0]).toMatch(/1 not checked \(1 with no hash recorded\)/)
    expect(s.checkLines[1]).toMatch(/1 not checked \(1 with no previous link recorded\)/)
    expect(s.checkLines[2]).toMatch(
      /3 not checked \(2 in a format whose hash does not cover the payload, 1 with no payload digest recorded\)/)
  })

  it('does not invent a reason the response contradicts', () => {
    // A hash, a link and a payload digest are all present, yet each check is
    // null: shape-valid but inconsistent. "No hash recorded" would be false.
    const s = summaryPresentation(evidence([{
      ...ev('x', { hash_valid: null, chain_linked: null, substance_valid: null,
        event_hash: 'abc', prev_event_hash: 'def' }),
      canonical: { payload_hash: 'ph' },
    }]))
    for (const line of s.checkLines) {
      expect(line).toMatch(/1 not checked \(1 for a reason the response does not establish\)/)
    }
    // Fields absent altogether establish nothing either.
    const bare = summaryPresentation(evidence([ev('y', { hash_valid: null })]))
    expect(bare.checkLines[0]).toMatch(/for a reason the response does not establish/)
  })

  it('reports a failure among events with no v2-or-later format at all', () => {
    const s = summaryPresentation(evidence([
      ev('a', { canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null }),
    ], { verified: false }))
    expect(s.formatLine).toBe('0 in hash format v2 or later, 1 below v2.')
    expect(s.overall.tone).toBe('mismatch')
  })

  it('makes no damage, tamper or verified claim, and ignores the server boolean', () => {
    const rows = [ev('a', { hash_valid: false }), ev('b')]
    const asTrue = summaryPresentation(evidence(rows, { verified: true }))
    const asFalse = summaryPresentation(evidence(rows, { verified: false }))
    expect(asTrue).toEqual(asFalse)
    expect(text(asTrue)).not.toMatch(/tampered|damaged record|verified|attested/i)
    expect(asTrue.overall.text).toMatch(/cannot say why/)
  })

  it('says only that nothing failed when every check matched', () => {
    const s = summaryPresentation(evidence([ev('a'), ev('b')]))
    expect(s.overall).toEqual({ tone: 'none', text: 'No check that ran found a mismatch.' })
    expect(s.scope).toBe('Across the 2 events recorded:')
    expect(s.truncationWarning).toBeNull()
  })
})

describe('rowCheckState and formatLabel', () => {
  it('names each check by its result and the format without a writer', () => {
    expect(rowCheckState(integrity({ chain_linked: false, substance_valid: null })))
      .toEqual({ tone: 'mismatch', text: 'Did not match: link to previous · Matched: hash · Not checked: payload digest' })
    expect(rowCheckState(integrity()).tone).toBe('matched')
    expect(rowCheckState(integrity({ hash_valid: null, chain_linked: null, substance_valid: null })))
      .toEqual({ tone: 'unchecked', text: 'Not checked: hash, link to previous, payload digest' })
    expect(formatLabel(integrity({ canonical_version: 2 }))).toBe('Hash format v2')
    expect(formatLabel(integrity({ canonical_version: 9, canonical_version_supported: false })))
      .toBe('Hash format v9 · not recognised by this build')
  })
})

describe('checkOutcomes', () => {
  it('counts every row, legacy included', () => {
    const [hash] = checkOutcomes([ev('a', { canonical_version: 1, hash_valid: false }), ev('b')])
    expect(hash).toMatchObject({ matched: 1, mismatched: 1, notChecked: 0 })
  })
})

// --- Status against a frozen copy of the counterparty document's 1.0 logic ---

/** src/lib/guestRecordExport.js chainStatusOf as of 7a237f7, unchanged. */
function frozenChainStatusOf(events, chain) {
  if (!chain?.server_attested) return 'NOT_SERVER_ATTESTED'
  const verdicts = events.map(ev => ev.integrity ?? {})
  if (verdicts.some(v => v.hash_valid === false)) return 'HASH_MISMATCH_DETECTED'
  if (verdicts.some(v => v.substance_valid === false)) return 'PAYLOAD_MISMATCH_DETECTED'
  if (verdicts.some(v => v.chain_linked === false)) return 'CHAIN_LINK_BROKEN'
  return chain.verified ? 'VERIFIED' : 'NOT_VERIFIED'
}

/**
 * A row as the version 1 function shapes it: trust_model and the chain count
 * are set from the same canonical_version as the row's own field, which is
 * what guest-contract-events does (index.ts canonicalVersionOf, used for both).
 */
const v1Row = (version, hash, sub, link) => ({
  integrity: {
    canonical_version: version, canonical_version_supported: version >= 1 && version <= 4,
    hash_valid: hash, substance_valid: sub, chain_linked: link,
    trust_model: version >= 2 ? 'server_attested' : 'client_asserted',
  },
})
const v1Chain = (rows, verified, truncated) => ({
  verified, truncated,
  server_attested: rows.filter(r => r.integrity.trust_model === 'server_attested').length,
})

describe('guestChainStatus matches the 1.0 status, renaming only its first state', () => {
  const VERSIONS = [0, 1, 2, 3, 4, 9]
  const RESULTS = [true, false, null]
  const rowsOf = []
  for (const v of VERSIONS) for (const h of RESULTS) for (const s of RESULTS) for (const l of RESULTS) {
    rowsOf.push([v, h, s, l])
  }
  const mapped = status => (status === 'NOT_SERVER_ATTESTED' ? 'NO_EVENTS_FORMAT_V2_OR_LATER' : status)

  it('over every single row and a spread of row pairs, both booleans and truncation', () => {
    // A finite matrix: evidence for producer-shaped responses, not a proof for
    // every possible input. Pairs carry simultaneous failures, so precedence
    // (none in v2+ -> hash -> payload -> link -> boolean) is exercised.
    let compared = 0
    const cases = [...rowsOf.map(r => [r])]
    for (let i = 0; i < rowsOf.length; i += 3) for (let j = 0; j < rowsOf.length; j += 2) {
      cases.push([rowsOf[i], rowsOf[j]])
    }
    for (const spec of cases) {
      const rows = spec.map(args => v1Row(...args))
      for (const verified of [true, false]) for (const truncated of [true, false]) {
        const chain = v1Chain(rows, verified, truncated)
        expect(guestChainStatus(rows, chain), JSON.stringify({ spec, verified, truncated }))
          .toBe(mapped(frozenChainStatusOf(rows, chain)))
        compared++
      }
    }
    expect(compared).toBeGreaterThan(10000)
  }, 30000)

  it('puts zero v2-or-later rows ahead of any failure, as 1.0 did', () => {
    const rows = [v1Row(1, false, null, false)]
    expect(guestChainStatus(rows, v1Chain(rows, false, false))).toBe('NO_EVENTS_FORMAT_V2_OR_LATER')
  })
})

describe('coverageStatements: what the hashes cover, per format present', () => {
  const at = (version, supported = true) => ev(String(version), {
    canonical_version: version, canonical_version_supported: supported,
  })
  const BASE = 'the recorded event id, type, agreement id, actor, time and completion-criteria digest field (which may be empty)'
  const PREDECESSOR = 'the recorded predecessor-hash input (the GENESIS sentinel when none is recorded)'

  it('v1 names its fields and says its hash does not bind a predecessor hash, even when recorded', () => {
    const lines = coverageStatements([at(1)])
    expect(lines[0]).toBe(`Format v1 hashes bind ${BASE}. They do not bind a predecessor hash, `
      + 'even where the row records one, nor the payload, nor an agreement digest.')
    expect(lines).toContain('Payload digest: 0 included in the hash format, 1 not included.')
  })

  // Codex 115: each line must stand on its own, because the formats a record
  // does not contain are not shown. Codex 116: a format binds recorded inputs
  // (a predecessor hash or GENESIS, digest fields that may be empty), never a
  // previous event's existence or a digest's match.
  for (const [version, bound, notBound] of [
    [2, [BASE, PREDECESSOR], ['payload or an agreement digest']],
    [3, [BASE, PREDECESSOR, 'recorded payload-digest field (which may be empty)'], ['an agreement digest']],
    [4, [BASE, PREDECESSOR, 'recorded payload-digest field and the recorded agreement-digest field (either may be empty)'], []],
  ]) {
    it(`v${version} only: the line names every field it relies on, as recorded inputs`, () => {
      const lines = coverageStatements([at(version)])
      expect(lines.filter(l => l.startsWith('Format v'))).toHaveLength(1)
      const line = lines[0]
      expect(line).toMatch(new RegExp(`^Format v${version} hashes bind `))
      for (const phrase of bound) expect(line).toContain(phrase)
      for (const phrase of notBound) expect(line).toMatch(new RegExp(`do not bind (the )?${phrase}`))
      // No reference to a line that is not there, and no claimed previous event.
      expect(line).not.toMatch(/\bsame\b|\balso\b|link to the previous event/)
    })
  }

  it('says once that links and digest matches are separate checks', () => {
    for (const rows of [[at(1)], [at(2)], [at(4)], [at(1), at(4)]]) {
      const lines = coverageStatements(rows)
      expect(lines.filter(l => l.startsWith('A format binds recorded values only.'))).toHaveLength(1)
      expect(lines.join(' ')).toMatch(/The counts above report event-hash and predecessor-link checks and the server's payload check/)
      expect(lines.join(' ')).toMatch(/Comparing recorded criteria and agreement digests to their content requires separate verification and is not included in those counts/)
    }
    // Nothing to qualify when no format is recognised.
    expect(coverageStatements([at(9, false)]).join(' ')).not.toMatch(/A format binds recorded values only/)
  })

  it('mixed formats: one self-contained line per format present, in order', () => {
    const lines = coverageStatements([at(4), at(1), at(2)])
    const formatLines = lines.filter(l => l.startsWith('Format v'))
    expect(formatLines.map(l => l.slice(0, 9))).toEqual(['Format v1', 'Format v2', 'Format v4'])
    for (const l of formatLines) expect(l).toContain(BASE)
    expect(lines).toContain('Payload digest: 1 included in the hash format, 2 not included.')
  })

  it('calls an unrecognised format\'s coverage unknown, not absent', () => {
    const lines = coverageStatements([at(4), at(9, false), at(0, false)])
    expect(lines).toContain('For 2 events in a format this build does not recognise, what the hash covers is unknown.')
    expect(lines).toContain('Payload digest: 1 included in the hash format, 0 not included, 2 unknown.')
  })
})

describe('payloadProjectionNote: what can be said about the shown details', () => {
  const at = (version, supported = true) => ev(String(version), {
    canonical_version: version, canonical_version_supported: supported,
  })

  it('never says a hash covers the whole payload, and never promises a mismatch', () => {
    for (const rows of [[at(1)], [at(2)], [at(4)], [at(9, false)], [at(1), at(4), at(9, false)]]) {
      const note = payloadProjectionNote(rows)
      expect(note).toMatch(/^The details shown under each entry are the projection of the recorded payload/)
      expect(note).not.toMatch(/covers the whole payload|would not match/)
    }
  })

  it('says what applies to the formats present, and only that', () => {
    expect(payloadProjectionNote([at(4)])).toMatch(/cannot\s+generally be checked or recomputed from the projection/)
    expect(payloadProjectionNote([at(4)])).not.toMatch(/do not bind the payload|unknown/)
    expect(payloadProjectionNote([at(2)])).toMatch(/Format v1 and v2 hashes do not bind the payload/)
    expect(payloadProjectionNote([at(2)])).not.toMatch(/cannot\s+generally be checked/)
    expect(payloadProjectionNote([at(9, false)])).toMatch(/whether the payload is bound is unknown/)
  })
})

describe('checkSummary: every row, whatever the status says', () => {
  const rows = (...specs) => specs.map(([id, over]) => ev(id, over))

  it('reports a v1-only mismatch the status puts behind NO_EVENTS_FORMAT_V2_OR_LATER', () => {
    const events = rows(['old', { canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null }])
    expect(guestChainStatus(events, { verified: false })).toBe('NO_EVENTS_FORMAT_V2_OR_LATER')
    const c = checkSummary(events)
    expect(c.any_mismatch).toBe(true)
    expect(c.mismatched_event_ids).toEqual(['old'])
    expect(c.by_check.hash_valid).toEqual({ matched: 0, did_not_match: 1, not_checked: 0 })
  })

  it('reports a v1 mismatch beside a passing v2 row the server verified', () => {
    const events = rows(['old', { canonical_version: 1, hash_valid: false, chain_linked: null, substance_valid: null }], ['new', {}])
    const c = checkSummary(events)
    expect(c.any_mismatch).toBe(true)
    expect(c.mismatched_event_ids).toEqual(['old'])
  })

  it('reports a payload-only mismatch', () => {
    const c = checkSummary(rows(['p', { substance_valid: false }]))
    expect(c.any_mismatch).toBe(true)
    expect(c.by_check.substance_valid.did_not_match).toBe(1)
    expect(c.by_check.hash_valid.did_not_match).toBe(0)
  })

  it('counts checks that did not run, without calling them mismatches', () => {
    const c = checkSummary(rows(['u', { canonical_version: 9, canonical_version_supported: false,
      hash_valid: null, chain_linked: null, substance_valid: null }]))
    expect(c.any_mismatch).toBe(false)
    expect(c.checks_not_run).toBe(3)
  })
})

// ── T206: Codex T176 item 4 ─────────────────────────────────────────────────
describe('T206: a version 2 body must agree with itself and with its events', () => {
  const clone = b => JSON.parse(JSON.stringify(b))
  const base = () => asV2(evidence([ev('a'), ev('b')]))
  const cases = [
    ['verified while a dimension failed', b => { b.strict_verification.server.dimensions.agreement = 'fail' }, 'strict_verification.server.overall'],
    ['failed while every dimension passed', b => { b.strict_verification.server.overall = 'failed'; b.chain.verified = false }, 'strict_verification.server.overall'],
    ['complete tail with a null count', b => { b.strict_verification.server.read_boundary.recorded_count = null }, 'strict_verification.server.read_boundary'],
    ['complete tail with an unequal count', b => { b.strict_verification.server.read_boundary.recorded_count = 3 }, 'strict_verification.server.read_boundary'],
    ['truncated tail with a count not above the events', b => {
      Object.assign(b.strict_verification.server.read_boundary, { tail: 'truncated', recorded_count: 2 })
      b.strict_verification.server.dimensions.completeness = 'indeterminate'
      b.strict_verification.server.overall = 'incomplete'; b.chain.verified = false; b.chain.truncated = true
    }, 'strict_verification.server.read_boundary'],
    ['completeness passed over an unknown tail', b => {
      Object.assign(b.strict_verification.server.read_boundary, { tail: 'unknown', recorded_count: null })
      b.chain.truncated = true
    }, 'strict_verification.server.dimensions.completeness'],
    ['chain.truncated contradicting a complete tail', b => { b.chain.truncated = true }, 'chain.truncated'],
    ['chain.event_count contradicting the events', b => { b.chain.event_count = 5 }, 'chain.event_count'],
  ]
  for (const [name, mutate, reason] of cases) {
    it(`refuses ${name}`, () => {
      const b = clone(base())
      mutate(b)
      expect(parseGuestEvidence(b)).toEqual({ ok: false, reason })
    })
  }
  it('accepts consistent incomplete and failed bodies', () => {
    expect(parseGuestEvidence(asV2(evidence([ev('a')]), { tail: 'unknown' })).ok).toBe(true)
    expect(parseGuestEvidence(asV2(evidence([ev('a')]), { tail: 'truncated' })).ok).toBe(true)
    expect(parseGuestEvidence(asV2(evidence([ev('a')]), { dims: { agreement: 'fail' } })).ok).toBe(true)
  })
})

describe('T206: version 2 prose comes from the strict verdict', () => {
  it('an agreement failure with every per-event check matched is never "no mismatch"', () => {
    const body = asV2(evidence([ev('a'), ev('b')]), { dims: { agreement: 'fail' } })
    body.events[1].integrity.strict.agreement = 'mismatch'
    expect(parseGuestEvidence(body).ok).toBe(true)
    const s = summaryPresentation(body)
    expect(s.overall.tone).toBe('mismatch')
    expect(s.overall.text).toMatch(/strict check found a problem in: agreement, on 1 event/)
    expect(s.overall.text).not.toMatch(/No check that ran found a mismatch/)
  })
  it('an invalid event is counted', () => {
    const body = asV2(evidence([ev('a')]), { dims: { hash: 'fail', link: 'fail', payload: 'indeterminate', agreement: 'fail' } })
    body.events[0].integrity.strict = { kind: 'invalid', hash: 'invalid_input', link: 'invalid_input',
      payload: 'indeterminate', agreement: 'invalid_input', reason: 'x' }
    expect(parseGuestEvidence(body)).toEqual({ ok: true, version: 2 })
    expect(summaryPresentation(body).overall.text).toMatch(/in: event hash, chain link, agreement, on 1 event/)
  })
  it('incomplete is not a pass, and names what was not established', () => {
    const s = summaryPresentation(asV2(evidence([ev('a')]), { tail: 'unknown' }))
    expect(s.overall).toEqual({ tone: 'none', text: expect.stringMatching(/could not complete\. Not established: completeness\. This record is not verified\./) })
  })
  it('verified says it is the server\'s strict check, with the payload limit', () => {
    const s = summaryPresentation(asV2(evidence([ev('a')])))
    expect(s.overall.text).toMatch(/strict check passed every dimension/)
    expect(s.overall.text).toMatch(/payload digest cannot be repeated from this page/)
  })
  it('a per-event mismatch is a mismatch whatever the strict verdict says', () => {
    const body = asV2(evidence([ev('a', { hash_valid: false })]), { dims: { hash: 'fail' } })
    expect(summaryPresentation(body).overall.tone).toBe('mismatch')
  })
  it('version 1 prose is unchanged', () => {
    expect(summaryPresentation(evidence([ev('a')])).overall)
      .toEqual({ tone: 'none', text: 'No check that ran found a mismatch.' })
  })
})

describe('T206: the truncation notice states the read boundary in version 2', () => {
  it('truncated, unknown and complete tails', () => {
    expect(truncationNotice(asV2(evidence([ev('a')]), { tail: 'truncated' })))
      .toBe('The server recorded more events than this response carries. The remaining events were not checked here.')
    const unknown = truncationNotice(asV2(evidence([ev('a')]), { tail: 'unknown' }))
    expect(unknown).toMatch(/could not establish that this response reaches the last event/)
    expect(unknown).not.toMatch(/most events the server returns/)
    expect(truncationNotice(asV2(evidence([ev('a')])))).toBeNull()
  })
  it('version 1 keeps the cap sentence', () => {
    expect(truncationNotice(evidence([ev('a')], { truncated: true })))
      .toBe('This response reached the most events the server returns. Additional events may exist and were not checked here.')
    expect(truncationNotice(evidence([ev('a')]))).toBeNull()
  })
})

// ── T208: the trail verdict must follow from the rows (Codex T177) ──────────
describe('T208: a version 2 aggregate cannot contradict its own rows', () => {
  const clone = b => JSON.parse(JSON.stringify(b))
  it('an empty history is never verified, even with a complete tail and count 0', () => {
    const empty = asV2(evidence([]))
    expect(parseGuestEvidence(empty)).toEqual({ ok: true, version: 2 })
    expect(empty.strict_verification.server.overall).toBe('incomplete')
    const forged = clone(empty)
    forged.strict_verification.server.dimensions.completeness = 'pass'
    forged.strict_verification.server.overall = 'verified'
    forged.chain.verified = true
    expect(parseGuestEvidence(forged)).toEqual({ ok: false, reason: 'strict_verification.server.dimensions.completeness' })
  })
  it('a passing aggregate over a row whose agreement mismatched is refused', () => {
    const b = asV2(evidence([ev('a'), ev('b')]))
    b.events[1].integrity.strict.agreement = 'mismatch'
    expect(parseGuestEvidence(b)).toEqual({ ok: false, reason: 'strict_verification.server.dimensions.agreement' })
  })
  it('a passing aggregate over an invalid row is refused', () => {
    const b = asV2(evidence([ev('a')]))
    b.events[0].integrity.strict = { kind: 'invalid', hash: 'match', link: 'linked', payload: 'match', agreement: 'match', reason: 'x' }
    expect(parseGuestEvidence(b)).toEqual({ ok: false, reason: 'strict_verification.server.overall' })
  })
  it('a payload pass over an indeterminate row is refused', () => {
    const b = asV2(evidence([ev('a')]))
    b.events[0].integrity.strict.payload = 'indeterminate'
    expect(parseGuestEvidence(b)).toEqual({ ok: false, reason: 'strict_verification.server.dimensions.payload' })
  })
  it('a declared fail with no failing row is refused too', () => {
    const b = asV2(evidence([ev('a')]))
    Object.assign(b.strict_verification.server, { overall: 'failed' })
    b.strict_verification.server.dimensions.link = 'fail'
    b.chain.verified = false
    expect(parseGuestEvidence(b)).toEqual({ ok: false, reason: 'strict_verification.server.dimensions.link' })
  })
  it('the server\'s agreement downgrade (rows pass, declared indeterminate) is accepted', () => {
    const b = asV2(evidence([ev('a')]), { dims: { agreement: 'indeterminate' } })
    b.events[0].integrity.strict.agreement = 'match'
    expect(parseGuestEvidence(b)).toEqual({ ok: true, version: 2 })
    expect(b.strict_verification.server.overall).toBe('incomplete')
  })
})

