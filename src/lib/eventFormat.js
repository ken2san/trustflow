// src/lib/eventFormat.js
// How a guest-contract-events response is read before anything is shown or
// exported: whether its shape can be trusted, what format each event is in,
// and what each check actually found.
//
// WHY THIS EXISTS (rank-1 provenance fix, Tasks 124-129)
// The response labelled every row with hash_version >= 2 "server_attested".
// That said something about who wrote the row, and the hash format says
// nothing of the kind: before 20260924000002_events_lockdown.sql any anon-key
// client could write that format, actor and time included. So this module
// reads the format from `canonical_version` and never from `trust_model`, and
// it states check results per check, over the rows actually returned.
//
// THREE RULES
// 1. A response whose shape is not understood is refused, not partly read.
//    Excluding a malformed row from the counts can turn its mismatch into
//    "no mismatch found", so nothing is summarised until every row validates.
// 2. Absent and null are different. `hash_valid: null` is the server saying it
//    could not check; a missing `hash_valid` is a response this page does not
//    understand.
// 3. The server's `verified` boolean is carried, never paraphrased. It checks
//    only rows in format v2 or later, so a sentence derived from it can hide a
//    mismatch in an older row. The sentences here come from the row results.

/** The response versions this build can read. Absent means version 1. */
export const SUPPORTED_RESPONSE_VERSIONS = [1, 2]

/** The only `recorded_id_class` values a v2 response may carry. */
export const RECORDED_ID_CLASSES = ['matches_contract_earner_id', 'guest_prefixed', 'other', 'missing']

const TRI_STATE_CHECKS = ['hash_valid', 'chain_linked', 'substance_valid']

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTriState = v => v === true || v === false || v === null

/**
 * Validate a guest-contract-events success body.
 *
 * @returns {{ ok: true, version: number } | { ok: false, reason: string }}
 *   `reason` names the first field that failed, for tests and diagnostics.
 */
export function parseGuestEvidence(body) {
  const bad = reason => ({ ok: false, reason })
  if (!isPlainObject(body)) return bad('body')

  let version = 1
  if ('response_version' in body) {
    // Exactly the integer 2. A string "2", null, or a version this build does
    // not know is refused rather than read as the nearest shape it resembles.
    if (body.response_version !== 2) return bad('response_version')
    version = 2
  }

  if (!isPlainObject(body.contract) || !body.contract.id) return bad('contract')
  if (!Array.isArray(body.events)) return bad('events')
  if (!isPlainObject(body.chain)) return bad('chain')
  if (typeof body.chain.verified !== 'boolean') return bad('chain.verified')
  if (typeof body.chain.truncated !== 'boolean') return bad('chain.truncated')

  for (let i = 0; i < body.events.length; i++) {
    const ev = body.events[i]
    const at = `events[${i}]`
    if (!isPlainObject(ev)) return bad(at)
    const integrity = ev.integrity
    if (!isPlainObject(integrity)) return bad(`${at}.integrity`)
    if (!Number.isInteger(integrity.canonical_version)) return bad(`${at}.integrity.canonical_version`)
    if (typeof integrity.canonical_version_supported !== 'boolean') {
      return bad(`${at}.integrity.canonical_version_supported`)
    }
    for (const key of TRI_STATE_CHECKS) {
      if (!(key in integrity) || !isTriState(integrity[key])) return bad(`${at}.integrity.${key}`)
    }
    if ('canonical' in ev && ev.canonical !== null && !isPlainObject(ev.canonical)) {
      return bad(`${at}.canonical`)
    }
    // Rendered as key/value detail; anything but an object (or none) is not
    // a payload this page knows how to show.
    if ('payload' in ev && ev.payload !== null && !isPlainObject(ev.payload)) {
      return bad(`${at}.payload`)
    }
  }
  return { ok: true, version }
}

/**
 * How many returned events are in each hash format. `v2OrLater` includes
 * formats this build does not recognise; `notRecognised` counts those
 * separately. Neither says anything about who wrote an event.
 */
export function formatPartition(events) {
  let v2OrLater = 0
  let belowV2 = 0
  let notRecognised = 0
  for (const ev of events) {
    const { canonical_version: version, canonical_version_supported: supported } = ev.integrity
    if (version >= 2) v2OrLater++
    else belowV2++
    if (!supported) notRecognised++
  }
  return { v2OrLater, belowV2, notRecognised }
}

/**
 * Why a check returned null for one event. Null is the server saying it did
 * not or could not check, which is never a failure and never a pass.
 *
 * A reason is named only when the row's own fields establish it: the format
 * for an unrecognised version or one whose hash excludes the payload, and an
 * explicitly null recorded value for a missing hash, link or payload digest.
 * Otherwise the reason is not stated, so a response whose fields disagree
 * with its null cannot be read as "no hash recorded" while a hash is present.
 */
function nullReason(kind, ev) {
  const { canonical_version: version, canonical_version_supported: supported } = ev.integrity
  const recordedNull = (block, key) => isPlainObject(block) && key in block && block[key] === null
  if (kind === 'chain_linked') {
    return recordedNull(ev.integrity, 'prev_event_hash') ? 'no_previous_link_recorded' : 'reason_not_stated'
  }
  if (!supported) return 'format_not_recognised'
  if (kind === 'hash_valid') {
    return recordedNull(ev.integrity, 'event_hash') ? 'no_hash_recorded' : 'reason_not_stated'
  }
  if (version < 3) return 'format_excludes_payload'
  return recordedNull(ev.canonical, 'payload_hash') ? 'no_payload_hash_recorded' : 'reason_not_stated'
}

const CHECKS = [
  { key: 'hash_valid',      label: 'Event hash' },
  { key: 'chain_linked',    label: 'Link to the previous event' },
  { key: 'substance_valid', label: 'Payload digest' },
]

const REASON_TEXT = {
  format_not_recognised:     'in a format this build does not recognise',
  no_hash_recorded:          'with no hash recorded',
  no_previous_link_recorded: 'with no previous link recorded',
  format_excludes_payload:   'in a format whose hash does not cover the payload',
  no_payload_hash_recorded:  'with no payload digest recorded',
  reason_not_stated:         'for a reason the response does not establish',
}

/** Per-check counts over the returned events, with the reason for each null. */
export function checkOutcomes(events) {
  return CHECKS.map(({ key, label }) => {
    const out = { key, label, matched: 0, mismatched: 0, notChecked: 0, reasons: {} }
    for (const ev of events) {
      const value = ev.integrity[key]
      if (value === true) out.matched++
      else if (value === false) out.mismatched++
      else {
        out.notChecked++
        const reason = nullReason(key, ev)
        out.reasons[reason] = (out.reasons[reason] ?? 0) + 1
      }
    }
    return out
  })
}

const ROW_CHECK_NAMES = {
  hash_valid:      'hash',
  chain_linked:    'link to previous',
  substance_valid: 'payload digest',
}

/**
 * One event's check state, as shown on its row. `tone` is 'mismatch' when any
 * check returned false, 'matched' when the hash matched and nothing failed,
 * and 'unchecked' otherwise. The text names each check by its result.
 */
export function rowCheckState(integrity) {
  const by = { true: [], false: [], null: [] }
  for (const key of TRI_STATE_CHECKS) by[String(integrity[key])].push(ROW_CHECK_NAMES[key])
  const tone = by.false.length > 0 ? 'mismatch'
    : integrity.hash_valid === true ? 'matched'
    : 'unchecked'
  const parts = []
  if (by.false.length > 0) parts.push(`Did not match: ${by.false.join(', ')}`)
  if (by.true.length > 0) parts.push(`Matched: ${by.true.join(', ')}`)
  if (by.null.length > 0) parts.push(`Not checked: ${by.null.join(', ')}`)
  return { tone, text: parts.join(' · ') }
}

/** The neutral format label for one event. It states a format, nothing more. */
export function formatLabel(integrity) {
  return `Hash format v${integrity.canonical_version}`
    + (integrity.canonical_version_supported ? '' : ' · not recognised by this build')
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The sentences the screen shows about the checks. Each is computed from the
 * row results over the returned events; none is derived from `verified`.
 * Assumes `parseGuestEvidence` accepted the response.
 */
export function summaryPresentation(evidence) {
  const events = evidence.events
  const truncated = evidence.chain.truncated === true
  const partition = formatPartition(events)
  const checks = checkOutcomes(events)

  const scope = truncated
    ? `Among the ${plural(events.length, 'event')} returned:`
    : `Across the ${plural(events.length, 'event')} recorded:`

  const formatLine = `${partition.v2OrLater} in hash format v2 or later, ${partition.belowV2} below v2`
    + (partition.notRecognised > 0
      ? `; ${partition.notRecognised} in a format this build does not recognise`
      : '')
    + '.'

  const checkLines = checks.map(c => {
    const reasons = Object.entries(c.reasons)
      .map(([reason, n]) => `${n} ${REASON_TEXT[reason]}`)
      .join(', ')
    return `${c.label}: ${c.matched} matched, ${c.mismatched} did not match, `
      + `${c.notChecked} not checked${reasons ? ` (${reasons})` : ''}.`
  })

  const mismatchedEvents = events.filter(ev => TRI_STATE_CHECKS.some(k => ev.integrity[k] === false)).length
  const notCheckedTotal = checks.reduce((n, c) => n + c.notChecked, 0)
  const overall = mismatchedEvents > 0
    ? {
        tone: 'mismatch',
        text: `${plural(mismatchedEvents, 'event')} ${mismatchedEvents === 1 ? 'has' : 'have'} a check `
          + 'that did not match. TrustFlow cannot say why: alteration, damage and a '
          + 'recording error look the same here.',
      }
    : {
        tone: 'none',
        text: 'No check that ran found a mismatch.'
          + (notCheckedTotal > 0 ? ` ${plural(notCheckedTotal, 'check')} could not run.` : ''),
      }

  // Exactly the server's cap also counts as truncated, so later events may or
  // may not exist. Shown whatever the checks found: a clean prefix is still a
  // prefix.
  const truncationWarning = truncated
    ? 'This response reached the most events the server returns. Additional '
      + 'events may exist and were not checked here.'
    : null

  return { scope, formatLine, checkLines, overall, truncationWarning }
}

/**
 * Every row's check results, independent of the status below. The status keeps
 * the 1.0 precedence, so a record with no event in format v2 or later reports
 * that before any mismatch is examined, and VERIFIED is the server's boolean
 * over v2+ rows only. A reader of the document needs the mismatches in every
 * row whatever the status says (Codex 114, blocking 3).
 */
export function checkSummary(events) {
  const outcomes = checkOutcomes(events)
  const mismatched = events.filter(ev => TRI_STATE_CHECKS.some(k => ev.integrity[k] === false))
  const counts = {}
  for (const c of outcomes) {
    counts[c.key] = { matched: c.matched, did_not_match: c.mismatched, not_checked: c.notChecked }
  }
  return {
    scope: 'every event returned, in any hash format',
    any_mismatch: mismatched.length > 0,
    mismatched_event_ids: mismatched.map(ev => ev.id ?? null),
    checks_not_run: outcomes.reduce((n, c) => n + c.notChecked, 0),
    by_check: counts,
  }
}

/** What the status does and does not cover, stated in the document beside it. */
export const STATUS_NOTE =
  'status keeps the order of earlier documents: NO_EVENTS_FORMAT_V2_OR_LATER is '
  + 'reported before any mismatch is examined, then a hash, payload or link '
  + 'mismatch in any event, then the server\'s verdict. That verdict, and so '
  + 'VERIFIED, covers events in hash format v2 or later only, and can stand '
  + 'beside checks that did not run. It is not a complete integrity '
  + 'guarantee. check_summary reports every event\'s checks independently.'

// Each sentence names every field its format binds, and what it does not,
// so it reads correctly when it is the only format on the record. An earlier
// version said "the same fields plus..." and "also covers...", which pointed at
// lines a v2- or v4-only record never showed (Codex 115).
const BASE_FIELDS = 'the recorded event id, type, agreement id, actor, time and '
  + 'completion-criteria digest field (which may be empty)'
const PREDECESSOR = 'the recorded predecessor-hash input (the GENESIS sentinel when none is recorded)'
const COVERAGE_BY_FORMAT = {
  1: `Format v1 hashes bind ${BASE_FIELDS}. They do not bind a predecessor hash, `
    + 'even where the row records one, nor the payload, nor an agreement digest.',
  2: `Format v2 hashes bind ${BASE_FIELDS}, and ${PREDECESSOR}. `
    + 'They do not bind the payload or an agreement digest.',
  3: `Format v3 hashes bind ${BASE_FIELDS}, ${PREDECESSOR}, and the recorded `
    + 'payload-digest field (which may be empty). They do not bind an agreement digest.',
  4: `Format v4 hashes bind ${BASE_FIELDS}, ${PREDECESSOR}, the recorded `
    + 'payload-digest field and the recorded agreement-digest field (either may be empty).',
}

// What a format binds is an input, not a finding. Shown once beside the
// format lines; it refers to the check counts, not to another format line
// (Codex 116).
const SEPARATE_CHECKS = "A format binds recorded values only. The counts above report event-hash and predecessor-link checks and the server's payload check. "
  + 'Comparing recorded criteria and agreement digests to their content requires separate verification and is not included in those counts.'

/** How many returned events' formats bind a payload digest, do not, or are unknown. */
function payloadBinding(events) {
  const out = { included: 0, excluded: 0, unknown: 0 }
  for (const ev of events) {
    const { canonical_version: version, canonical_version_supported: supported } = ev.integrity
    if (!supported || !COVERAGE_BY_FORMAT[version]) out.unknown++
    else if (version >= 3) out.included++
    else out.excluded++
  }
  return out
}

/**
 * What the details shown under each entry are, and what can be said about them
 * from here, by the formats present. They are the projection of the payload
 * the server returned for this party. A digest bound by v3/v4 cannot generally
 * be checked from that projection, which may or may not equal the full payload;
 * v1/v2 hashes do not bind the payload at all.
 */
export function payloadProjectionNote(events) {
  const { included, excluded, unknown } = payloadBinding(events)
  const parts = ['The details shown under each entry are the projection of the recorded payload '
    + 'the server returned for this party.']
  if (included > 0) {
    parts.push('Where a format binds a recorded payload digest (v3, v4), that digest cannot '
      + 'generally be checked or recomputed from the projection; the payload check here is the server\'s.')
  }
  if (excluded > 0) parts.push('Format v1 and v2 hashes do not bind the payload, so those details are recorded but not covered by a hash.')
  if (unknown > 0) parts.push('For a format this build does not recognise, whether the payload is bound is unknown.')
  return parts.join(' ')
}

/**
 * What the hashes of the returned events cover, by the formats actually
 * present. Statements are about recorded inputs and the server's check; none
 * says a value is true, who wrote it, or that it was never rewritten.
 */
export function coverageStatements(events) {
  const lines = []
  const supportedVersions = new Set()
  for (const ev of events) {
    const { canonical_version: version, canonical_version_supported: supported } = ev.integrity
    if (supported && COVERAGE_BY_FORMAT[version]) supportedVersions.add(version)
  }
  const { included, excluded, unknown } = payloadBinding(events)
  for (const version of [...supportedVersions].sort()) lines.push(COVERAGE_BY_FORMAT[version])
  if (supportedVersions.size > 0) lines.push(SEPARATE_CHECKS)
  if (unknown > 0) {
    lines.push(`For ${plural(unknown, 'event')} in a format this build does not recognise, `
      + 'what the hash covers is unknown.')
  }
  lines.push(`Payload digest: ${included} included in the hash format, `
    + `${excluded} not included`
    + (unknown > 0 ? `, ${unknown} unknown.` : '.'))
  lines.push(payloadProjectionNote(events))
  return lines
}

/**
 * The counterparty document's status, in today's order: nothing in format v2
 * or later, then any hash mismatch, any payload mismatch, any broken link
 * (each over ALL rows), then the server's boolean.
 *
 * The first state used to read the server's `chain.server_attested` count and
 * was called NOT_SERVER_ATTESTED. That count was `canonical_version >= 2`
 * under another name, so this counts it from the rows; for a response the
 * function produced, the two are the same number.
 */
export function guestChainStatus(events, chain) {
  if (formatPartition(events).v2OrLater === 0) return 'NO_EVENTS_FORMAT_V2_OR_LATER'
  const verdicts = events.map(ev => ev.integrity)
  if (verdicts.some(v => v.hash_valid === false)) return 'HASH_MISMATCH_DETECTED'
  if (verdicts.some(v => v.substance_valid === false)) return 'PAYLOAD_MISMATCH_DETECTED'
  if (verdicts.some(v => v.chain_linked === false)) return 'CHAIN_LINK_BROKEN'
  return chain.verified ? 'VERIFIED' : 'NOT_VERIFIED'
}

/** The notice for documents downloaded before these versions. */
export const EARLIER_DOCUMENTS_NOTICE =
  'In TrustFlow records downloaded earlier, trust_model "server_attested" and '
  + 'the server_attested count meant hash format v2 or later; trust_model '
  + '"client_asserted" and the client_asserted count meant below v2. Neither '
  + 'identified who wrote an event. Downloaded files are unchanged, and this '
  + 'notice cannot reach everyone who holds one.'
