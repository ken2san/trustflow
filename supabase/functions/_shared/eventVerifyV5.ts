// supabase/functions/_shared/eventVerifyV5.ts
//
// Strict v5 READ support (row 3 step 2, Task 182). Pure: no I/O. Nothing here
// writes, and the default writer stays on v4.
//
// WHY THIS IS NOT A BRANCH IN eventCanonical.ts
// Adding 5 to SUPPORTED_HASH_VERSIONS would make every existing reader call the
// lenient `eventCanonical(ev, 5)` path — the one that turns a missing
// predecessor into GENESIS and a missing digest into null. That is precisely
// the legacy fallback a v5 row must never get. So the legacy module still says
// "unsupported" for 5, and readers adopt the functions below explicitly (step
// 3). Until they do, a v5 row is reported as unsupported: safe, not verified.
//
// THE CHECKS ARE SEPARATE ON PURPOSE
// Shape+hash, chain link and agreement each return their own verdict. A row
// can recompute correctly and still sit in the wrong place in the chain, or
// cite an agreement that is not the deal's. Collapsing them into one boolean
// is how a sliced or pre-acceptance record would read as "verified".

import {
  GENESIS_HASH, canonicalVersionOf, isSupportedHashVersion,
} from './eventCanonical.ts'
import { V5_HASH_VERSION, verifyEventHashV5, type V5Verdict } from './eventCanonicalV5.ts'

const HEX64 = /^[0-9a-f]{64}$/

/** Fields only a v5 row may carry a value in. */
export const V5_AUTHORITY_FIELDS: readonly string[] = Object.freeze(['credential_id', 'issuer_kind'])

export type StoredEventKind =
  | { kind: 'legacy', version: number }
  | { kind: 'v5' }
  | { kind: 'unsupported', version: unknown }
  | { kind: 'invalid', field: string, reason: string }

function dataValue(row: object, key: string): { present: boolean, value: unknown, accessor: boolean } {
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
 * Which verification path a stored row takes. No v5 row, and no row carrying
 * v5 authority values, can come back as legacy: a malformed v5 row is invalid
 * or unsupported, never verified under a version it did not claim.
 */
export function classifyStoredEvent(row: unknown): StoredEventKind {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { kind: 'invalid', field: '(row)', reason: 'not an object' }
  }
  const version = dataValue(row, 'hash_version')
  if (version.accessor) return { kind: 'invalid', field: 'hash_version', reason: 'not a data property' }
  if (version.value === V5_HASH_VERSION) return { kind: 'v5' }

  for (const field of V5_AUTHORITY_FIELDS) {
    const f = dataValue(row, field)
    if (f.accessor) return { kind: 'invalid', field, reason: 'not a data property' }
    if (f.value !== null && f.value !== undefined) {
      return { kind: 'invalid', field, reason: 'v5 authority value on a row not recorded as v5' }
    }
  }

  const prev = dataValue(row, 'prev_event_hash')
  if (prev.accessor) return { kind: 'invalid', field: 'prev_event_hash', reason: 'not a data property' }
  const legacy = canonicalVersionOf({
    hash_version: version.value as number | null | undefined,
    prev_event_hash: prev.value as string | null | undefined,
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
 * v5 verifier reads. `prev_hash` is the preimage spelling; `prev_event_hash`
 * the stored column. Either may be carried; both may be carried only if they
 * agree. Nothing is defaulted: an absent predecessor stays absent and fails
 * verification.
 */
export function fromV5Transport(block: unknown): TransportResult {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, field: '(block)', reason: 'not an object' }
  }
  const row: Record<string, unknown> = {}
  for (const key of Object.keys(block)) {
    const f = dataValue(block, key)
    if (f.accessor) return { ok: false, field: key, reason: 'not a data property' }
    row[key] = f.value
  }
  const hasShort = Object.prototype.hasOwnProperty.call(row, 'prev_hash')
  const hasStored = Object.prototype.hasOwnProperty.call(row, 'prev_event_hash')
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

export type LinkVerdict = 'linked' | 'broken' | 'invalid_input'

/**
 * Chain link. `expectedPrev` is the predecessor's STORED hash, or GENESIS when
 * the caller has the whole chain and this is its first hashed event. A caller
 * holding only a slice cannot know that, and must pass null: the answer is
 * then invalid_input, never "linked".
 */
export function checkV5Link(row: unknown, expectedPrev: unknown): LinkVerdict {
  if (row === null || typeof row !== 'object') return 'invalid_input'
  const prev = dataValue(row, 'prev_event_hash')
  const valid = (v: unknown) => v === GENESIS_HASH || (typeof v === 'string' && HEX64.test(v))
  if (prev.accessor || !valid(prev.value) || !valid(expectedPrev)) return 'invalid_input'
  return prev.value === expectedPrev ? 'linked' : 'broken'
}

export type AgreementVerdict = 'pre_acceptance' | 'match' | 'mismatch' | 'invalid_input'

/**
 * Agreement. An explicit null is a pre-acceptance record: not applicable, and
 * deliberately not "match". A cited digest is compared with the deal's current
 * agreement digest under its recorded snapshot version; if that is missing,
 * the check cannot be made and says so.
 */
export function checkV5Agreement(row: unknown, currentAgreementHash: unknown): AgreementVerdict {
  if (row === null || typeof row !== 'object') return 'invalid_input'
  const cited = dataValue(row, 'agreement_hash')
  if (cited.accessor || !cited.present || cited.value === undefined) return 'invalid_input'
  if (cited.value === null) return 'pre_acceptance'
  if (typeof cited.value !== 'string' || !HEX64.test(cited.value)) return 'invalid_input'
  if (typeof currentAgreementHash !== 'string' || !HEX64.test(currentAgreementHash)) return 'invalid_input'
  return cited.value === currentAgreementHash ? 'match' : 'mismatch'
}
