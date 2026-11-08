// supabase/functions/_shared/eventCanonical.ts
//
// The single definition of what an attested event's hash covers.
//
// This file is imported by the Edge Functions that WRITE events (log-event) and
// READ them back for verification (guest-contract-events), and directly by the
// browser verifier (src/lib/auditExport.js) — the same cross-boundary import
// pattern as _shared/trustpointsRules.ts. That is deliberate: the one production
// bug this chain has had came from two implementations of the canonical drifting
// apart (created_at was hashed as "…016Z" but read back as "…016+00:00", so
// every stored event verified as tampered with). One definition, three callers.
//
// WHAT THE HASH BINDS, AND WHAT IT DOES NOT
// The canonical covers who acted, on what agreement, under which version of its
// terms, when, and where the event sits in the chain. From v3 it also covers a
// hash of the payload, so the substance of an assertion — a rejection reason, a
// contested claim — is tamper-evident rather than merely recorded.
//
// It does not, and cannot, say anything about whether an assertion is TRUE.
// TrustFlow attests that a party said something, not that what they said is so.

/** Sentinel prev_hash for a contract's first event. */
export const GENESIS_HASH = 'GENESIS'

/**
 * Canonical versions.
 *   1 — pre-chain. {id,type,contract_id,actor_id,dod_hash,created_at}
 *   2 — adds prev_hash, making the chain a chain.
 *   3 — adds payload_hash, making the substance tamper-evident.
 *   4 — adds agreement_hash, binding the whole agreed deal rather than only
 *       its completion criteria.
 *
 * Historical rows are verified under the version they were written with. A row
 * with no recorded version predates the column and is v1. Each version's
 * meaning is permanent: a v3 row is a v3 row forever, and the arrival of v4
 * does not change what it said.
 */
export const HASH_VERSION = 4

export interface CanonicalEvent {
  id: string
  type: string
  contract_id: string
  actor_id: string | null
  dod_hash: string | null
  created_at: string
  prev_event_hash?: string | null
  payload_hash?: string | null
  agreement_hash?: string | null
}

/**
 * The meaningful deal, as the counterparty was shown it.
 *
 * WHAT BELONGS HERE, AND THE TEST FOR IT
 * A field belongs in the snapshot if a reasonable participant would say that
 * changing it means they agreed to a different deal. Price, date, what is being
 * done, what counts as finished, who does the work, and who they are dealing
 * with all pass that test. A database id, a protocol state, a token or an
 * internal timestamp all fail it — those describe where the transaction is or
 * how the software works, not what was agreed.
 *
 * The snapshot is deliberately NOT the contract row. Hashing a whole row would
 * bind protocol state and implementation details into the meaning of the
 * agreement, so an ordinary state transition would look like a changed deal.
 *
 * Field order is fixed and part of the format: stableStringify sorts keys, but
 * the shape itself is the contract with future verifiers.
 */
export interface AgreementSnapshot {
  snapshot_version: 1
  project_name: string | null
  dod: unknown
  /** Integer, in `currency`'s minor unit: yen for JPY, cents for CAD/HKD/USD/EUR/GBP. */
  amount: number | null
  currency: string | null
  deadline: string | null
  performed_by: string | null
  offered_by: string | null
}

/**
 * Build the snapshot from server-trusted contract data.
 *
 * Never from anything a caller supplied: the point of the snapshot is that it
 * records what the server showed the counterparty, so a client that could
 * influence it could record a different deal from the one on screen.
 */
export function buildAgreementSnapshot(contract: Record<string, unknown>): AgreementSnapshot {
  return {
    snapshot_version: 1,
    project_name: (contract.project_name as string | null) ?? null,
    dod: contract.dod ?? [],
    // `amount_minor` is the column; `amount_jpy` is the name it had until
    // 2026-11-08 and is still read when the newer one is absent, so a caller
    // that has not been redeployed yet produces the same snapshot it always
    // did rather than one with a null amount in it.
    //
    // THE SNAPSHOT SHAPE DOES NOT CHANGE, AND THAT IS THE POINT. `amount` here
    // has always been an integer in the currency's minor unit — for JPY that
    // is yen, which is why the rename is only a rename. The migration backfills
    // `amount_minor = amount_jpy` for every existing row and a DB CHECK keeps
    // them equal while any reader is still on the old name, so every stored
    // agreement_hash recomputes to the same digest and `snapshot_version` stays
    // at 1. A currency with minor units is new data, not a reinterpretation of
    // old data: a JPY row means today exactly what it meant when it was written.
    amount: (contract.amount_minor as number | null)
      ?? (contract.amount_jpy as number | null)
      ?? null,
    currency: (contract.currency as string | null) ?? null,
    deadline: (contract.deadline as string | null) ?? null,
    // Who does the work. Flipping this inverts the entire transaction.
    performed_by: (contract.performed_by as string | null) ?? 'creator',
    // Who the counterparty understood themselves to be dealing with.
    offered_by: (contract.earner_display_name as string | null) ?? null,
  }
}

/** The hash of that snapshot. */
export function deriveAgreementHash(contract: Record<string, unknown>): Promise<string> {
  return sha256Hex(stableStringify(buildAgreementSnapshot(contract)))
}

/**
 * The timestamp exactly as it was hashed at write time.
 *
 * Events are hashed over `new Date().toISOString()` (trailing Z, milliseconds).
 * PostgREST returns the same instant with a +00:00 offset. Hashing the value as
 * read produces a different digest from the one stored.
 */
export function canonicalTimestamp(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

/**
 * Deterministic JSON: object keys sorted recursively, array order preserved,
 * no whitespace, undefined dropped from objects and nulled inside arrays (which
 * is what JSON.stringify does anyway).
 *
 * Needed because jsonb gives no key-order guarantee — Postgres stores object
 * keys in its own order, so serializing a payload as it comes back from the
 * database would produce a different string from the one hashed at write time.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return '[' + value.map(v => (v === undefined ? 'null' : stableStringify(v))).join(',') + ']'
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(k => record[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}'
}

/** SHA-256 hex, via Web Crypto — present in Deno and in the browser. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** The hash of an event's payload, as bound into a v3 canonical. */
export function payloadHash(payload: unknown): Promise<string> {
  return sha256Hex(stableStringify(payload ?? {}))
}

/**
 * The authoritative hash of an agreement's terms.
 *
 * Derived from the contract's own `dod`, never accepted from a caller: an event
 * must not be able to choose which version of the agreement it claims to refer
 * to. Two assertions made either side of a scope change will therefore carry
 * different values here, which is what makes a unilateral scope change visible
 * in the log rather than silent.
 */
export function deriveDodHash(dod: unknown): Promise<string> {
  return sha256Hex(stableStringify(dod ?? []))
}

/**
 * The exact string an event's hash is computed over, for a given version.
 * Key order is part of the format and must not be rearranged.
 */
export function eventCanonical(event: CanonicalEvent, version: number): string {
  const base = {
    id:          event.id,
    type:        event.type,
    contract_id: event.contract_id,
    actor_id:    event.actor_id,
    dod_hash:    event.dod_hash ?? null,
    created_at:  canonicalTimestamp(event.created_at),
  }
  if (version <= 1) return JSON.stringify(base)

  const chained = { ...base, prev_hash: event.prev_event_hash ?? GENESIS_HASH }
  if (version === 2) return JSON.stringify(chained)

  const withPayload = { ...chained, payload_hash: event.payload_hash ?? null }
  if (version === 3) return JSON.stringify(withPayload)

  return JSON.stringify({ ...withPayload, agreement_hash: event.agreement_hash ?? null })
}

/**
 * Which canonical a stored row must be verified under.
 * Recorded version wins; rows predating the column are identified by whether
 * they carry a chain link at all.
 */
export function canonicalVersionOf(row: { hash_version?: number | null, prev_event_hash?: string | null }): number {
  if (row.hash_version) return row.hash_version
  return row.prev_event_hash ? 2 : 1
}

/** Whether a version binds the whole agreement rather than only its criteria. */
export function bindsWholeAgreement(version: number): boolean {
  return version >= 4
}

/** Recompute a stored event's hash under its own rules. */
export async function recomputeEventHash(row: CanonicalEvent & { hash_version?: number | null }): Promise<string> {
  return sha256Hex(eventCanonical(row, canonicalVersionOf(row)))
}
