// supabase/functions/_shared/delegatedEvent.ts
//
// Builds a delegated v5 proposal for append_delegated_event (row 4b,
// docs/plans/row4-owner-append.md §4b). Pure apart from hashing.
//
// ONE FINAL RECORDED TREE
// The payload is parsed once (JSON.parse: an ordinary duplicate key is last-key
// -wins), checked against the delegated domain, stripped of every top-level
// `_` key the caller sent, given the four server fields, checked again, and
// then that one object is hashed, sent and stored. The database never rewrites
// it; it verifies the reserved fields under its lock instead.
//
// RESERVED FIELDS: EDGE PREDICTS, THE DATABASE PROVES
// Edge cannot see the resolver's answer before it hashes, so it builds what a
// successful delegated append must record: the owner acting as 'earner', the
// role the pre-read `performed_by` gives, and grant possession. The RPC checks
// the exact key set and every value against the locked grant and contract.

import { assuranceForRecord, grantAssurance, legacyAuthMethod } from './authAssurance.ts'
import {
  GENESIS_HASH, buildAgreementSnapshot, deriveAgreementHash, deriveDodHash, payloadHash, sha256Hex,
} from './eventCanonical.ts'
import { buildEventCanonicalV5, V5_HASH_VERSION } from './eventCanonicalV5.ts'
import { PRE_ACCEPTANCE_STATES, roleInAgreement } from './eventRecord.ts'

/** The types a delegated owner grant may write in row 4; the resolver enforces the same list. */
export const DELEGATED_TYPES: ReadonlySet<string> = new Set([
  'performance.asserted', 'performance.accepted', 'performance.rejected',
  'payment.reported', 'payment.acknowledged', 'payment.disputed',
])

/**
 * The delegated payload domain: strings, safe integers, booleans, null, and
 * plain arrays and objects of these. Floats and unsafe integers are refused,
 * and so are `\u0000` and lone surrogates, which jsonb rejects or would store
 * differently from what was hashed.
 */
export function inDelegatedDomain(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value === 'string') {
    if (value.includes('\u0000')) return false
    // A lone surrogate is a high not followed by a low, or a low not preceded by a high.
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  }
  if (Array.isArray(value)) return value.every(inDelegatedDomain)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value as Record<string, unknown>)
      .every(([k, v]) => inDelegatedDomain(k) && inDelegatedDomain(v))
  }
  return false
}

export type PerformedBy = 'creator' | 'counterparty'

/** The four server fields a delegated row must carry, for a given performed_by. */
export function expectedReservedFields(performedBy: PerformedBy): Record<string, unknown> {
  return {
    _actor_role: 'earner',
    _role_in_agreement: roleInAgreement('earner', performedBy),
    _auth_method: legacyAuthMethod(grantAssurance()),
    _authentication: assuranceForRecord(grantAssurance()),
  }
}

/**
 * The final recorded tree, or null when the client payload or the result is
 * outside the domain. `clientPayload` is the already-parsed request value.
 */
export function finalRecordedTree(clientPayload: unknown, performedBy: PerformedBy): Record<string, unknown> | null {
  const client = clientPayload ?? {}
  if (typeof client !== 'object' || Array.isArray(client) || !inDelegatedDomain(client)) return null
  const partyAsserted = Object.fromEntries(
    Object.entries(client as Record<string, unknown>).filter(([key]) => !key.startsWith('_')))
  const tree = { ...partyAsserted, ...expectedReservedFields(performedBy) }
  return inDelegatedDomain(tree) ? tree : null
}

export interface DelegatedProposal {
  /** p_event: exactly the keys append_delegated_event accepts. */
  event: {
    id: string, type: string, contract_id: string, actor_id: string, dod_hash: string, created_at: string,
    prev_event_hash: string, payload: Record<string, unknown>, payload_hash: string,
    agreement_hash: string | null, event_hash: string, idempotency_key: string | null,
  }
  /** p_hashed_inputs: what the inner digests were taken over, for SQL to compare. */
  hashedInputs: { dod: unknown, agreement: unknown }
  performedBy: PerformedBy
}

/**
 * Build one delegated v5 proposal from a pre-read contract. `acceptedVersion`
 * is null for a pre-acceptance deal (explicit null agreement evidence) and the
 * accepted snapshot version otherwise.
 */
export async function buildDelegatedEventV5(input: {
  type: string
  contract: Record<string, unknown>
  ownerId: string
  credentialId: string
  issuerKind: 'owner_account'
  tree: Record<string, unknown>
  prevEventHash: string | null
  idempotencyKey: string | null
  acceptedVersion: number | null
  now?: () => Date
}): Promise<DelegatedProposal> {
  const contract = input.contract
  const performedBy = contract.performed_by === 'counterparty' ? 'counterparty' : 'creator'
  const preAcceptance = PRE_ACCEPTANCE_STATES.has(String(contract.state ?? ''))
  const dod = contract.dod ?? []
  const agreement = preAcceptance ? null : buildAgreementSnapshot(contract, input.acceptedVersion ?? NaN)
  const [dodHash, agreementHash, substanceHash] = await Promise.all([
    deriveDodHash(dod),
    preAcceptance ? Promise.resolve(null) : deriveAgreementHash(contract, input.acceptedVersion ?? NaN),
    payloadHash(input.tree),
  ])
  const prev = input.prevEventHash ?? GENESIS_HASH
  const createdAt = (input.now ?? (() => new Date()))().toISOString()
  const id = crypto.randomUUID()
  const built = buildEventCanonicalV5({
    hash_version: V5_HASH_VERSION, id, type: input.type, contract_id: String(contract.id),
    actor_id: input.ownerId, dod_hash: dodHash, created_at: createdAt, prev_event_hash: prev,
    payload_hash: substanceHash, agreement_hash: agreementHash,
    credential_id: input.credentialId, issuer_kind: input.issuerKind,
  })
  if (!built.ok) throw new Error(`delegated v5 proposal invalid at ${built.field}: ${built.reason}`)
  return {
    event: {
      id, type: input.type, contract_id: String(contract.id), actor_id: input.ownerId, dod_hash: dodHash,
      created_at: createdAt, prev_event_hash: prev, payload: input.tree, payload_hash: substanceHash,
      agreement_hash: agreementHash, event_hash: await sha256Hex(built.canonical),
      idempotency_key: input.idempotencyKey,
    },
    hashedInputs: { dod, agreement },
    performedBy,
  }
}
