// supabase/functions/_shared/eventVerifyV5.ts
//
// Strict v5 READ rules shared by every reader (row 3 step 2, Task 182; step 3A,
// Task 187 per Codex T161). Pure: no I/O. Nothing here writes, and the default
// writer stays on v4.
//
// WHY THIS IS NOT A BRANCH IN eventCanonical.ts
// Adding 5 to SUPPORTED_HASH_VERSIONS would make every existing reader call the
// lenient `eventCanonical(ev, 5)` path — the one that turns a missing
// predecessor into GENESIS and a missing digest into null. That is precisely
// the legacy fallback a v5 row must never get. So the legacy module still says
// "unsupported" for 5, and readers adopt the functions below explicitly (3B/3C).
//
// THE CHECKS ARE SEPARATE ON PURPOSE
// Event hash, chain link, full payload and agreement each return their own
// verdict, and a slice is only "verified" when every one passes AND the slice is
// known to be complete. A row can recompute and still sit in the wrong place, a
// slice can link perfectly and still be missing its start or its tail, and an
// explicit null agreement digest proves nothing about acceptance on its own.

import {
  GENESIS_HASH, bindsWholeAgreement, canonicalVersionOf, eventCanonical, isSupportedHashVersion,
  payloadHash, sha256Hex,
} from './eventCanonical.ts'
import { V5_HASH_VERSION, verifyEventHashV5, type V5Verdict } from './eventCanonicalV5.ts'
import { ACCEPTANCE_TYPE } from './eventRecord.ts'

const HEX64 = /^[0-9a-f]{64}$/
const isDigest = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v)

/** Fields only a v5 row may carry a value in. */
export const V5_AUTHORITY_FIELDS: readonly string[] = Object.freeze(['credential_id', 'issuer_kind'])

/**
 * What a reader that selects the authority columns must project together. If
 * a projection drops the version and both authority fields at once, the row
 * would otherwise look like an ordinary legacy row; requiring them as own
 * properties (null allowed) is what catches that.
 */
export const V5_PROJECTION_FIELDS: readonly string[] =
  Object.freeze(['hash_version', 'prev_event_hash', 'credential_id', 'issuer_kind'])

/** The only keys a transport block may contribute to a v5 row. */
const TRANSPORT_KEYS: readonly string[] = Object.freeze([
  'domain', 'hash_version', 'canonical_version', 'id', 'type', 'contract_id', 'actor_id', 'dod_hash',
  'created_at', 'prev_event_hash', 'prev_hash', 'payload_hash', 'agreement_hash', 'credential_id',
  'issuer_kind', 'event_hash', 'payload',
])

export type StoredEventKind =
  | { kind: 'legacy', version: number }
  | { kind: 'v5' }
  | { kind: 'unsupported', version: unknown }
  | { kind: 'invalid', field: string, reason: string }

interface Read { present: boolean, value: unknown, accessor: boolean }

function dataValue(row: object, key: string): Read {
  let desc: PropertyDescriptor | undefined
  try {
    desc = Object.getOwnPropertyDescriptor(row, key)
  } catch {
    return { present: true, value: undefined, accessor: true }
  }
  if (desc === undefined) return { present: false, value: undefined, accessor: false }
  if (!('value' in desc)) return { present: true, value: undefined, accessor: true }
  return { present: true, value: desc.value, accessor: false }
}

/**
 * Which verification path a stored row takes. A recorded 5 is a CANDIDATE for
 * strict v5 verification, not a match. No v5 row, and no row carrying v5
 * authority values, can come back as legacy: a malformed v5 row is invalid or
 * unsupported, never verified under a version it did not claim.
 *
 * `projected: true` is the reader's statement that it selected the version,
 * predecessor and both authority columns; any of them missing is then invalid.
 */
export function classifyStoredEvent(row: unknown, opts: { projected?: boolean } = {}): StoredEventKind {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { kind: 'invalid', field: '(row)', reason: 'not an object' }
  }
  const read: Record<string, Read> = {}
  for (const key of [...V5_PROJECTION_FIELDS, 'canonical_version']) {
    read[key] = dataValue(row, key)
    if (read[key].accessor) return { kind: 'invalid', field: key, reason: 'not a data property' }
  }
  if (opts.projected) {
    for (const key of V5_PROJECTION_FIELDS) {
      if (!read[key].present || read[key].value === undefined) {
        return { kind: 'invalid', field: key, reason: 'projection dropped a required field' }
      }
    }
  }
  const version = read.hash_version
  const indicator = read.canonical_version
  if (indicator.present && indicator.value !== undefined) {
    if (!version.present || !Object.is(indicator.value, version.value)) {
      return { kind: 'invalid', field: 'canonical_version', reason: 'inconsistent version indicators' }
    }
  }
  if (version.value === V5_HASH_VERSION) return { kind: 'v5' }

  for (const field of V5_AUTHORITY_FIELDS) {
    const f = read[field]
    if (f.value !== null && f.value !== undefined) {
      return { kind: 'invalid', field, reason: 'v5 authority value on a row not recorded as v5' }
    }
  }

  const legacy = canonicalVersionOf({
    hash_version: version.value as number | null | undefined,
    prev_event_hash: read.prev_event_hash.value as string | null | undefined,
  })
  return isSupportedHashVersion(legacy)
    ? { kind: 'legacy', version: legacy }
    : { kind: 'unsupported', version: legacy }
}

export type TransportResult =
  | { ok: true, row: Record<string, unknown> }
  | { ok: false, field: string, reason: string }

/**
 * A transport block (export or guest projection) to the stored-row shape the
 * v5 verifier reads. Only a fixed allowlist of keys is read, into an object
 * with no prototype, so `__proto__` and other hostile names change nothing.
 * `prev_hash` is the preimage spelling, `prev_event_hash` the stored column;
 * both may be carried only if they agree. Nothing is defaulted: an absent key
 * stays absent, an explicit null stays null.
 */
export function fromV5Transport(block: unknown): TransportResult {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, field: '(block)', reason: 'not an object' }
  }
  const row: Record<string, unknown> = Object.create(null)
  for (const key of TRANSPORT_KEYS) {
    const f = dataValue(block, key)
    if (f.accessor) return { ok: false, field: key, reason: 'not a data property' }
    if (f.present) row[key] = f.value
  }
  const hasShort = 'prev_hash' in row
  const hasStored = 'prev_event_hash' in row
  if (hasShort && hasStored && row.prev_hash !== row.prev_event_hash) {
    return { ok: false, field: 'prev_hash', reason: 'conflicts with prev_event_hash' }
  }
  if (hasShort) {
    if (!hasStored) row.prev_event_hash = row.prev_hash
    delete row.prev_hash
  }
  return { ok: true, row }
}

/** Shape and hash: the frozen v5 builder. Invalid input is never a mismatch. */
export function verifyV5EventHash(row: unknown, storedHash: unknown): Promise<V5Verdict> {
  return verifyEventHashV5(row, storedHash)
}

/**
 * What a reader knows about the link a row should have.
 *   chain_start       the reader holds the deal's chain from its first hashed
 *                     link, and this row is that link: only GENESIS links.
 *   after             the immediately preceding observed stored hash.
 *   unknown_boundary  the first row of a slice whose start is not known.
 */
export type LinkExpectation =
  | { kind: 'chain_start' }
  | { kind: 'after', hash: string }
  | { kind: 'unknown_boundary' }

export type LinkVerdict = 'linked' | 'broken' | 'indeterminate' | 'invalid_input'

/** Chain link for a v5 row. GENESIS needs a known start; a slice edge is indeterminate. */
export function checkV5Link(row: unknown, expectation: LinkExpectation): LinkVerdict {
  if (row === null || typeof row !== 'object') return 'invalid_input'
  const prev = dataValue(row, 'prev_event_hash')
  if (prev.accessor || !(prev.value === GENESIS_HASH || isDigest(prev.value))) return 'invalid_input'
  switch (expectation?.kind) {
    case 'chain_start': return prev.value === GENESIS_HASH ? 'linked' : 'broken'
    case 'after':
      if (!isDigest(expectation.hash)) return 'invalid_input'
      return prev.value === expectation.hash ? 'linked' : 'broken'
    case 'unknown_boundary': return 'indeterminate'
    default: return 'invalid_input'
  }
}

export type AcceptancePosition = 'before_acceptance' | 'acceptance_or_after' | 'unknown'

export type AgreementVerdict =
  | 'pre_acceptance' | 'match' | 'match_position_unknown' | 'mismatch' | 'invalid' | 'no_cited_digest'
  | 'indeterminate' | 'invalid_input'

/**
 * Agreement for a v5 row.
 *   - Explicit null alone means "no cited digest". It is `pre_acceptance` only
 *     at a position known to precede acceptance, and invalid at or after it.
 *   - A cited digest before acceptance is invalid (v5 drafts cite null).
 *   - Otherwise a cited digest is compared with the accepted snapshot digest
 *     the CALLER derived under the recorded snapshot version — never the
 *     contract's current fields. Without that digest: indeterminate.
 *   - Equality proves equality, not that a digest is legal where the row sits:
 *     at an unknown position an equal digest is `match_position_unknown`, which
 *     never passes (Codex T164). A different digest is a mismatch anywhere.
 */
export function checkV5Agreement(
  row: unknown,
  ctx: { position: AcceptancePosition, acceptedAgreementHash?: unknown },
): AgreementVerdict {
  if (row === null || typeof row !== 'object') return 'invalid_input'
  const cited = dataValue(row, 'agreement_hash')
  if (cited.accessor || !cited.present || cited.value === undefined) return 'invalid_input'
  if (cited.value !== null && !isDigest(cited.value)) return 'invalid_input'
  const position = ctx?.position
  if (cited.value === null) {
    if (position === 'before_acceptance') return 'pre_acceptance'
    if (position === 'acceptance_or_after') return 'invalid'
    return 'no_cited_digest'
  }
  if (position === 'before_acceptance') return 'invalid'
  if (!isDigest(ctx?.acceptedAgreementHash)) return 'indeterminate'
  if (cited.value !== ctx.acceptedAgreementHash) return 'mismatch'
  return position === 'acceptance_or_after' ? 'match' : 'match_position_unknown'
}

// ── Per-reader aggregation ──────────────────────────────────────────────────

/**
 * Legacy rows that carry no stored hash or link are not failures (history), but
 * they are never proof either (Codex T164):
 *   pre_chain     before the first hashed row of a slice known to start at the
 *                 chain start: a genuine pre-chain prefix, honestly unverified
 *   missing       after a hashed row was seen: proof that should be there is not
 *   not_recorded  at an unknown boundary: cannot say which
 *   not_in_format the check does not exist in that version (v1 has no link)
 * Only not_in_format passes; the other three are indeterminate.
 */
export type MissingProof = 'pre_chain' | 'missing' | 'not_recorded'
export type HashCheck = 'match' | 'mismatch' | 'unsupported' | 'invalid_input' | MissingProof
export type LinkCheck = LinkVerdict | MissingProof | 'not_in_format'
export type PayloadCheck = 'match' | 'mismatch' | 'unavailable' | 'not_in_format' | 'indeterminate' | 'invalid_input' | MissingProof
export type AgreementCheck = AgreementVerdict | 'not_bound'
export type Dimension = 'pass' | 'fail' | 'indeterminate'

export interface RowResult {
  index: number
  id: unknown
  kind: StoredEventKind['kind']
  version: unknown
  reason?: string
  hash: HashCheck
  link: LinkCheck
  payload: PayloadCheck
  agreement: AgreementCheck
}

export interface SliceResult {
  rows: RowResult[]
  /** How acceptance was placed: derived from the rows, taken from the caller, or rejected as inconsistent. */
  acceptance: { status: 'derived' | 'caller' | 'rejected', index?: number, reason?: string }
  dimensions: { hash: Dimension, link: Dimension, payload: Dimension, agreement: Dimension, completeness: Dimension }
  overall: 'verified' | 'failed' | 'incomplete'
}

/**
 * Where acceptance sits relative to the rows supplied.
 *   { index }       the row at this slice index is the acceptance event
 *   'none'          no acceptance among these rows (with a known start, every
 *                   row then precedes acceptance)
 *   'before_slice'  acceptance happened before the first row supplied
 *   'unknown'       the reader cannot say
 */
export type AcceptanceMarker = { index: number } | 'none' | 'before_slice' | 'unknown'

export interface SliceOptions {
  /** The first row supplied is the deal's first event. */
  startsAtChainStart: boolean
  /** Nothing after the last row supplied was left out (no cap, no truncation). */
  tailComplete: boolean
  acceptance: AcceptanceMarker
  /** Accepted snapshot digest, derived under the recorded snapshot version. */
  acceptedAgreementHash?: string | null
  /** Legacy v4 only: the digest today's readers compare v4 rows with. */
  legacyAgreementHash?: string | null
  /** Projection contract passed to classifyStoredEvent. */
  projected?: boolean
  /**
   * Rows a caller already knows to be invalid (from the raw row, before any
   * projection or transport copy). They are reported invalid with this reason
   * and never reclassified (Codex T167).
   */
  knownInvalid?: ReadonlyArray<{ field: string, reason: string } | null | undefined>
}

const FAIL = new Set(['mismatch', 'broken', 'invalid', 'invalid_input'])
const PASS = new Set(['match', 'linked', 'pre_acceptance', 'not_in_format', 'not_bound'])

function dimension(values: string[]): Dimension {
  if (values.some(v => FAIL.has(v))) return 'fail'
  return values.every(v => PASS.has(v)) ? 'pass' : 'indeterminate'
}

function positionOf(index: number, a: AcceptanceMarker, startsAtChainStart: boolean): AcceptancePosition {
  if (a === 'before_slice') return 'acceptance_or_after'
  if (a === 'none') return startsAtChainStart ? 'before_acceptance' : 'unknown'
  if (a === 'unknown' || typeof a !== 'object') return 'unknown'
  if (index >= a.index) return 'acceptance_or_after'
  return startsAtChainStart ? 'before_acceptance' : 'unknown'
}

/**
 * Place acceptance from the ordered rows themselves (type ACCEPTANCE_TYPE) and
 * check the caller's marker against them. An out-of-range marker, a marker on a
 * row that is not an acceptance, 'none'/'before_slice' with an acceptance in
 * the slice, a 'none' that cannot be true, or more than one acceptance, is
 * rejected: no agreement check may then pass.
 */
function resolveAcceptance(rows: readonly unknown[], opts: SliceOptions):
  { marker: AcceptanceMarker, status: SliceResult['acceptance'] } {
  const found: number[] = []
  rows.forEach((row, i) => {
    if (row !== null && typeof row === 'object' && dataValue(row, 'type').value === ACCEPTANCE_TYPE) found.push(i)
  })
  const reject = (reason: string) => ({ marker: 'unknown' as const, status: { status: 'rejected' as const, reason } })
  if (found.length > 1) return reject('more than one acceptance in the slice')
  const a = opts.acceptance
  if (!(typeof a === 'object' && a !== null) && a !== 'none' && a !== 'before_slice' && a !== 'unknown') {
    return reject('unrecognised acceptance marker')
  }
  if (typeof a === 'object' && a !== null) {
    if (!Number.isInteger(a.index) || a.index < 0 || a.index >= rows.length) return reject('acceptance index out of range')
    if (found[0] !== a.index) return reject('acceptance index does not name the acceptance event')
    return { marker: a, status: { status: 'caller', index: a.index } }
  }
  // Acceptance cannot precede the deal's first event. 'before_slice' stays
  // valid for a slice that is a genuine suffix (Codex T166).
  if (a === 'before_slice' && opts.startsAtChainStart) {
    return reject("marker 'before_slice' contradicts a slice that starts at the deal's first event")
  }
  if (found.length === 1) {
    if (a === 'none' || a === 'before_slice') return reject(`marker '${String(a)}' contradicts an acceptance in the slice`)
    return { marker: { index: found[0] }, status: { status: 'derived', index: found[0] } }
  }
  return { marker: a, status: { status: 'caller' } }
}

/**
 * Verify an ordered slice of stored rows (chronological) for one deal. Every
 * row is reported, none is skipped, and the overall result is `failed` if
 * anything is known to be wrong, `verified` only if every check passes on a
 * slice known to be complete, and `incomplete` otherwise.
 *
 * Legacy rows keep today's export semantics: hashed through the unchanged
 * legacy canonical, a missing stored hash or link on a pre-chain row is not a
 * failure, and the expected tip advances as `event_hash ?? previous`.
 */
export async function verifyEvidenceSlice(rows: readonly unknown[], opts: SliceOptions): Promise<SliceResult> {
  let expectation: LinkExpectation = opts.startsAtChainStart ? { kind: 'chain_start' } : { kind: 'unknown_boundary' }
  const out: RowResult[] = []
  const acceptance = resolveAcceptance(rows, opts)
  let chainStarted = false
  const missingProof = (): MissingProof =>
    chainStarted ? 'missing' : opts.startsAtChainStart ? 'pre_chain' : 'not_recorded'

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const known = opts.knownInvalid?.[index]
    const cls: StoredEventKind = known
      ? { kind: 'invalid', field: known.field, reason: known.reason }
      : classifyStoredEvent(row, { projected: opts.projected })
    const obj = (row !== null && typeof row === 'object' ? row : {}) as object
    const stored = dataValue(obj, 'event_hash')
    const result: RowResult = {
      index, id: dataValue(obj, 'id').value, kind: cls.kind,
      version: cls.kind === 'legacy' || cls.kind === 'unsupported' ? cls.version : cls.kind === 'v5' ? 5 : undefined,
      hash: 'invalid_input', link: 'invalid_input', payload: 'indeterminate', agreement: 'invalid_input',
    }
    const payload = dataValue(obj, 'payload')
    const payloadCheck = async (strict: boolean): Promise<PayloadCheck> => {
      if (payload.accessor) return 'indeterminate'
      if (!payload.present || payload.value === undefined) return 'unavailable'
      const recorded = dataValue(obj, 'payload_hash').value
      // A v5 row with no usable digest is invalid evidence, not a proven
      // mismatch (Codex T170); legacy rows keep today's reading.
      if (!isDigest(recorded)) return strict ? 'invalid_input' : 'mismatch'
      return (await payloadHash(payload.value)) === recorded ? 'match' : 'mismatch'
    }

    if (cls.kind === 'invalid') {
      result.reason = `${cls.field}: ${cls.reason}`
    } else if (cls.kind === 'unsupported') {
      result.hash = 'unsupported'
      result.link = 'indeterminate'
      result.agreement = 'indeterminate'
    } else if (cls.kind === 'v5') {
      const v = await verifyV5EventHash(row, stored.value)
      result.hash = v.verdict === 'invalid_input' ? 'invalid_input' : v.verdict
      if (v.verdict === 'invalid_input') result.reason = `${v.field}: ${v.reason}`
      result.link = checkV5Link(row, expectation)
      result.payload = await payloadCheck(true)
      result.agreement = acceptance.status.status === 'rejected' ? 'indeterminate' : checkV5Agreement(row, {
        position: positionOf(index, acceptance.marker, opts.startsAtChainStart),
        acceptedAgreementHash: opts.acceptedAgreementHash,
      })
    } else {
      const version = cls.version
      const r = row as Record<string, unknown>
      result.hash = stored.value === null || stored.value === undefined
        ? missingProof()
        : (await sha256Hex(eventCanonical(r as never, version))) === stored.value ? 'match' : 'mismatch'
      const prev = dataValue(obj, 'prev_event_hash').value
      if (version < 2) result.link = 'not_in_format'
      else if (prev === null || prev === undefined) result.link = missingProof()
      else if (expectation.kind === 'unknown_boundary') result.link = 'indeterminate'
      else result.link = prev === (expectation.kind === 'chain_start' ? GENESIS_HASH : expectation.hash) ? 'linked' : 'broken'
      // As today's export: a legacy row with no recorded payload digest was
      // never attested, which is not a failure.
      const recordedPayload = dataValue(obj, 'payload_hash').value
      result.payload = version < 3 ? 'not_in_format'
        : recordedPayload === null || recordedPayload === undefined ? missingProof()
        : await payloadCheck(false)
      if (!bindsWholeAgreement(version)) result.agreement = 'not_bound'
      else if (acceptance.status.status === 'rejected') result.agreement = 'indeterminate'
      else if (!isDigest(opts.legacyAgreementHash)) result.agreement = 'indeterminate'
      else result.agreement = r.agreement_hash === opts.legacyAgreementHash ? 'match' : 'mismatch'
    }
    out.push(result)

    // Advance the expected tip as today's export does: a row without a stored
    // hash leaves it where it was; a malformed one makes the next link unknown.
    if (isDigest(stored.value)) { expectation = { kind: 'after', hash: stored.value }; chainStarted = true }
    else if (stored.value !== null && stored.value !== undefined) expectation = { kind: 'unknown_boundary' }
  }

  // A rejected acceptance marker gates the aggregate whatever versions are
  // present (Codex T166): agreement cannot pass, so overall cannot be verified.
  // An actual failure still ranks above that indeterminacy.
  const agreement = dimension(out.map(r => r.agreement))
  const dimensions = {
    hash: dimension(out.map(r => r.hash)),
    link: dimension(out.map(r => r.link)),
    payload: dimension(out.map(r => r.payload)),
    agreement: acceptance.status.status === 'rejected' && agreement === 'pass' ? 'indeterminate' as Dimension : agreement,
    completeness: (opts.startsAtChainStart && opts.tailComplete && out.length > 0 ? 'pass' : 'indeterminate') as Dimension,
  }
  const all = Object.values(dimensions)
  const overall = all.includes('fail') ? 'failed' : all.every(d => d === 'pass') ? 'verified' : 'incomplete'
  return { rows: out, acceptance: acceptance.status, dimensions, overall }
}
