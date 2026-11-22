// supabase/functions/_shared/eventCanonicalV5.ts
//
// The frozen v5 event canonical (row 3 step 1, Task 178). Pure: no I/O, no
// database, no writer. Nothing in this build writes or accepts a v5 row yet —
// `eventCanonical.ts` still supports only v1–v4, and readers are wired to v5
// in later slices ("readers before v5 writes").
//
// Contract: `docs/v5-preimage-review.md` (Codex T156, `d53fc5e`), confirmed by
// Kenji 2026-11-22. v5 is for delegated events only. It binds the nonsecret
// credential id and issuer kind inside the hashed object (Decisions.md C2,
// (c)), behind a domain separator and an explicit integer version.
//
// WHY A SEPARATE, STRICT MODULE
// v1–v4 are lenient on readback for historical reasons: a missing prev hash
// becomes GENESIS, a missing digest becomes null, an unparseable timestamp is
// hashed as given. Any of those in v5 would let an incomplete record come back
// as "verified". Here every input is required as an own property, nothing is
// defaulted, and a malformed input is reported as invalid input — never hashed
// under a guess, never handed to a legacy version.
//
// Once the first v5 row exists, everything in this file is permanent for v5.

import { GENESIS_HASH, sha256Hex } from './eventCanonical.ts'

export const V5_DOMAIN = 'trustflow.event'
export const V5_HASH_VERSION = 5

/** Outer key order. Part of the format; never rearrange. */
export const V5_KEYS = [
  'domain', 'hash_version', 'id', 'type', 'contract_id', 'actor_id', 'dod_hash',
  'created_at', 'prev_hash', 'payload_hash', 'agreement_hash', 'credential_id',
  'issuer_kind',
] as const

// Frozen, and validation reads a private copy: downstream JS cannot widen the
// accepted issuer kinds by mutating the export (Codex T158).
export const V5_ISSUER_KINDS: readonly string[] = Object.freeze(['owner_account', 'counterpart_account'])
const ISSUER_KINDS: ReadonlySet<string> = new Set(V5_ISSUER_KINDS)

/**
 * The stored-row shape a v5 hash is recomputed from. `prev_event_hash` is the
 * stored column; it becomes the outer `prev_hash`. `domain` is optional, but if
 * a transport carries it, it must be the exact constant.
 */
export interface V5EventInput {
  domain?: string
  hash_version: number
  id: string
  type: string
  contract_id: string
  actor_id: string
  dod_hash: string
  created_at: string
  prev_event_hash: string
  payload_hash: string
  agreement_hash: string | null
  credential_id: string
  issuer_kind: string
}

export type V5Result =
  | { ok: true, canonical: string }
  | { ok: false, field: string, reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
// At least one dot: a dotted identifier, as confirmed (Codex T158).
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysIn(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

/**
 * A readback timestamp as the v5 canonical string (UTC, exactly three
 * fractional digits, trailing Z), or null if it is not acceptable v5 input.
 *
 * Accepted: four-digit year 0001–9999, uppercase T, a real calendar day, hours
 * 00–23, minutes and seconds 00–59, 0–6 fractional digits of which any after
 * the third are zero, and `Z` or `±HH:MM` (00–23 / 00–59, not `-00:00`). The
 * UTC result must also fall in 0001–9999. No truncation, no fallback.
 */
export function canonicalTimestampV5(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = TIMESTAMP.exec(value)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, frac = '', zone, sign, ohs, oms] = m
  const y = Number(ys), mo = Number(mos), d = Number(ds)
  const h = Number(hs), mi = Number(mis), s = Number(ss)
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null
  if (h > 23 || mi > 59 || s > 59) return null
  if (/[^0]/.test(frac.slice(3))) return null
  const ms = Number((frac + '000').slice(0, 3))
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const oh = Number(ohs), om = Number(oms)
    if (oh > 23 || om > 59) return null
    if (zone === '-00:00') return null
    offsetMinutes = (sign === '+' ? 1 : -1) * (oh * 60 + om)
  }
  const local = new Date(0)
  local.setUTCFullYear(y, mo - 1, d)
  local.setUTCHours(h, mi, s, ms)
  const utc = new Date(local.getTime() - offsetMinutes * 60_000)
  const uy = utc.getUTCFullYear()
  if (Number.isNaN(utc.getTime()) || uy < 1 || uy > 9999) return null
  return utc.toISOString()
}

const MISSING = Symbol('missing')
const ACCESSOR = Symbol('accessor')

/**
 * Read one own property exactly once, as data. An accessor could validate one
 * value and serialize another (Codex T158), so it is refused, not called.
 */
function readOnce(input: object, key: string): unknown {
  let desc: PropertyDescriptor | undefined
  try {
    desc = Object.getOwnPropertyDescriptor(input, key)
  } catch {
    return ACCESSOR
  }
  if (desc === undefined) return MISSING
  if (!('value' in desc)) return ACCESSOR
  return desc.value
}

/**
 * Validate a v5 row and build its canonical string. Every field is required
 * as an own property; `undefined` is missing; the only nullable value is
 * `agreement_hash`. Unknown extra properties (other row columns) are ignored.
 */
export function buildEventCanonicalV5(input: unknown): V5Result {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: '(input)', reason: 'not an object' }
  }
  const fail = (field: string, reason: string): V5Result => ({ ok: false, field, reason })
  const required = [
    'hash_version', 'id', 'type', 'contract_id', 'actor_id', 'dod_hash', 'created_at',
    'prev_event_hash', 'payload_hash', 'agreement_hash', 'credential_id', 'issuer_kind',
  ]
  // Snapshot: each value is read once and only the snapshot is validated and
  // emitted. Nothing below touches `input` again.
  const row: Record<string, unknown> = {}
  for (const key of required) {
    const value = readOnce(input, key)
    if (value === ACCESSOR) return fail(key, 'not a data property')
    if (value === MISSING || value === undefined) return fail(key, 'missing')
    row[key] = value
  }
  const domain = readOnce(input, 'domain')
  if (domain === ACCESSOR) return fail('domain', 'not a data property')
  if (domain !== MISSING && domain !== V5_DOMAIN) return fail('domain', 'not the v5 domain')
  if (row.hash_version !== V5_HASH_VERSION) return fail('hash_version', 'not the integer 5')
  for (const key of ['id', 'contract_id', 'actor_id', 'credential_id']) {
    if (typeof row[key] !== 'string' || !UUID.test(row[key] as string)) return fail(key, 'not a lowercase UUID')
  }
  if (typeof row.type !== 'string' || !EVENT_TYPE.test(row.type)) return fail('type', 'not a dotted event identifier')
  for (const key of ['dod_hash', 'payload_hash']) {
    if (typeof row[key] !== 'string' || !HEX64.test(row[key] as string)) return fail(key, 'not a SHA-256 hex digest')
  }
  const prev = row.prev_event_hash
  if (!(prev === GENESIS_HASH || (typeof prev === 'string' && HEX64.test(prev)))) {
    return fail('prev_event_hash', 'not a SHA-256 hex digest or GENESIS')
  }
  const agreement = row.agreement_hash
  if (!(agreement === null || (typeof agreement === 'string' && HEX64.test(agreement)))) {
    return fail('agreement_hash', 'not a SHA-256 hex digest or null')
  }
  if (typeof row.issuer_kind !== 'string' || !ISSUER_KINDS.has(row.issuer_kind)) {
    return fail('issuer_kind', 'not a known issuer kind')
  }
  const createdAt = canonicalTimestampV5(row.created_at)
  if (createdAt === null) return fail('created_at', 'not an acceptable v5 timestamp')

  // A fresh object literal in V5_KEYS order; every value is validated ASCII
  // or null, so compact JSON.stringify is the whole encoding.
  const canonical = JSON.stringify({
    domain: V5_DOMAIN,
    hash_version: V5_HASH_VERSION,
    id: row.id,
    type: row.type,
    contract_id: row.contract_id,
    actor_id: row.actor_id,
    dod_hash: row.dod_hash,
    created_at: createdAt,
    prev_hash: prev,
    payload_hash: row.payload_hash,
    agreement_hash: agreement,
    credential_id: row.credential_id,
    issuer_kind: row.issuer_kind,
  })
  return { ok: true, canonical }
}

export type V5Verdict =
  | { verdict: 'match', hash: string }
  | { verdict: 'mismatch', hash: string }
  | { verdict: 'invalid_input', field: string, reason: string }

/**
 * Recompute a v5 row's hash and compare it with the stored one. Invalid or
 * incomplete inputs (including a malformed stored hash) are `invalid_input`,
 * never `mismatch` and never a legacy verdict. Only valid, complete inputs
 * with a different digest are a `mismatch`.
 */
export async function verifyEventHashV5(input: unknown, storedHash: unknown): Promise<V5Verdict> {
  const built = buildEventCanonicalV5(input)
  if (!built.ok) return { verdict: 'invalid_input', field: built.field, reason: built.reason }
  if (typeof storedHash !== 'string' || !HEX64.test(storedHash)) {
    return { verdict: 'invalid_input', field: 'event_hash', reason: 'not a SHA-256 hex digest' }
  }
  const hash = await sha256Hex(built.canonical)
  return { verdict: hash === storedHash ? 'match' : 'mismatch', hash }
}
