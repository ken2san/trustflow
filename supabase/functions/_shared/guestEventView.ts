// supabase/functions/_shared/guestEventView.ts
//
// What a guest Hirer is shown of their own evidence trail, and what they are
// given in order to check it themselves.
//
// WHY THIS IS A MODULE AND NOT A CLOSURE
// The shaping used to live inside guest-contract-events' request handler, where
// nothing could test it offline. Two of this project's three recurring bug
// classes were exactly that: a rule nobody could exercise outside a live
// request, and a projection that was checked only by the thing producing it.
// The allowlist decides what leaves the server, so it is the last code that
// should be unreachable from a test.
//
// THE ASYMMETRY THIS CLOSES, AND THE ONE IT DOES NOT
// The owner can export a receipt and recompute every event_hash from it
// offline. The guest could not: the response carried event_hash and
// prev_event_hash — the digests — but not three of the nine inputs those
// digests are taken over, so recomputation was impossible and the guest had
// nothing to do but believe the server's own `hash_valid`. CANONICAL_INPUTS
// below is derived from the canonical itself, so the set cannot drift from what
// is actually hashed.
//
// What it does NOT close: payload_hash is one digest over the WHOLE payload,
// and what the guest is shown is an allowlisted projection of that payload. So
// the guest can now verify authorship, ordering, timing and that the terms were
// bound — and still cannot verify that the text they are shown is the text that
// was committed to. That needs a per-claim commitment, which is a canonical
// change, not a read-path change. Saying so is this module's job; pretending
// otherwise would be the same overclaim as `integrity_status: VERIFIED`.

import {
  type CanonicalEvent, GENESIS_HASH, canonicalVersionOf, eventCanonical, sha256Hex,
} from './eventCanonical.ts'

/**
 * Every input the v4 canonical is computed over, named as the stored row names
 * it. `prev_hash` in the canonical string is `prev_event_hash` on the row.
 *
 * This list is asserted against `eventCanonical` by the tests rather than
 * merely written down, so adding a field to the canonical without exposing it
 * fails rather than silently taking verifiability away again.
 */
export const CANONICAL_INPUTS = [
  'id', 'type', 'contract_id', 'actor_id', 'dod_hash', 'created_at',
  'prev_event_hash', 'payload_hash', 'agreement_hash', 'hash_version',
] as const

/** Payload keys a guest may see, per event type. Everything else is dropped.
 *
 * An allowlist rather than a denylist: payloads are free-form jsonb written
 * over two trust models, so the set of keys that could appear is open-ended and
 * a denylist would silently leak whatever gets added next. Notable exclusions:
 *   _actor_role      — internal; surfaced as actor.role instead
 *   _authentication  — the server's report of how the OTHER party got in
 *   user_agent       — the accepting browser's UA, recorded by legacy consent rows
 *
 * Nothing underscore-prefixed is ever allowlisted. That is checked by a test
 * rather than left to whoever edits this table next.
 */
export const PAYLOAD_ALLOWLIST: Record<string, string[]> = {
  'contract.initiated':    ['step', 'title', 'budgetPoints'],
  'contract.accepted':     ['step'],
  'performance.asserted':  ['step', 'note'],
  // 'note' is here for the same reason it is on performance.asserted: the
  // receiver writes it, and a party who cannot read back their own statement
  // has no way to tell whether the record says what they said.
  'performance.accepted':  ['step', 'note'],
  'performance.rejected':  ['step', 'reason'],
  // Retired names, kept so historical rows still render their detail.
  'work.submitted':        ['step'],
  'work.approved':         ['step'],
  'work.rejected':         ['step', 'reason'],
  'contract.cancelled':    ['reason'],
  'contract.completed':    [],
  'dod.consent_recorded':  ['counterparty_name', 'counterparty_email', 'dod_items'],
  'dispute.opened':        ['reason'],
  'rating.submitted':      ['rating'],
  // The owner replaced this guest's access credential. Nothing is allowlisted
  // because nothing was asserted — the type is the entire statement — but it
  // must appear in the trail rather than be filtered out of it: it is how a
  // reader knows the events after it may not be the same person as the ones
  // before, and the guest is the party most entitled to see that.
  'access.reissued':       [],
  // A party's claim about payment sent/received/disputed outside TrustFlow.
  'payment.reported':      ['note'],
  'payment.acknowledged':  ['note'],
  'payment.disputed':      ['note'],
}

export function filterPayload(type: string, payload: unknown): Record<string, unknown> {
  const allowed = PAYLOAD_ALLOWLIST[type]
  // An unknown type gets an empty payload rather than a pass-through: a type
  // this function has not been taught about is one whose payload shape nobody
  // has reviewed.
  if (!allowed || typeof payload !== 'object' || payload === null) return {}
  const source = payload as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    // Defence in depth: the loop reads only allowlisted keys, and an
    // underscore-prefixed one could still be added to the table by hand.
    if (key.startsWith('_')) continue
    if (key in source) out[key] = source[key]
  }
  return out
}

/**
 * The inputs to one event's hash, as a self-contained block.
 *
 * Deliberately redundant with the fields beside it in the response. A
 * verification block that depends on reading values out of three other places
 * in a nested document is one nobody will implement correctly, and this is the
 * same ten-field shape `scripts/verify-receipt.mjs` already requires — so a
 * guest's own export can be checked by the same verifier the owner uses,
 * rather than by a second implementation that can drift from it.
 *
 * `contract_id` is passed in rather than read from the row because the token,
 * not the row, is what resolved the contract. Nothing here comes from a request.
 */
export function canonicalInputsOf(
  row: Record<string, unknown>,
  contractId: string,
): Record<string, unknown> {
  return {
    id:              row.id ?? null,
    type:            row.type ?? null,
    contract_id:     contractId,
    actor_id:        row.actor_id ?? null,
    dod_hash:        row.dod_hash ?? null,
    created_at:      row.created_at ?? null,
    prev_event_hash: row.prev_event_hash ?? null,
    payload_hash:    row.payload_hash ?? null,
    agreement_hash:  row.agreement_hash ?? null,
    hash_version:    row.hash_version ?? canonicalVersionOf(row as never),
  }
}

/** Which canonical inputs a shaped block is missing. Empty means recomputable. */
export function missingCanonicalInputs(block: Record<string, unknown> | null): string[] {
  if (!block) return [...CANONICAL_INPUTS]
  return CANONICAL_INPUTS.filter(k => !(k in block))
}

/**
 * Recompute one event's hash from a canonical block alone.
 *
 * Exported so the guest path and the tests use the same code the writers use,
 * and so a test can prove the block is sufficient by never consulting anything
 * outside it.
 */
export function recomputeFromCanonicalBlock(
  block: Record<string, unknown>,
): Promise<string> {
  const version = (block.hash_version as number | null)
    ?? canonicalVersionOf(block as never)
  return sha256Hex(eventCanonical(block as unknown as CanonicalEvent, version))
}

/**
 * What a guest can and cannot establish from what they were given. Carried in
 * the response for the same reason the receipt carries it: an agent acting for
 * a counterparty has no document to consult.
 */
export function guestVerificationNotes(): Record<string, unknown> {
  return {
    canonical_definition: 'supabase/functions/_shared/eventCanonical.ts',
    recompute: 'sha256 over the canonical string built from each act\'s '
      + '`canonical` block, under that block\'s own hash_version',
    chain: `each act\'s prev_event_hash must equal the previous act\'s event_hash; the first is ${GENESIS_HASH}`,
    independently_verifiable: [
      'that each act\'s authorship, timing, ordering and terms-pin are unaltered',
      'that the chain has no gap, reorder or removal between the acts shown',
      'that every act was bound to the same agreement_hash',
    ],
    not_verifiable_here: [
      'That the statement text shown matches what was committed to. One '
        + 'payload_hash covers the whole payload and this response carries an '
        + 'allowlisted projection of it, so the digest cannot be reproduced from '
        + 'what is shown. The hashes prove the record was not altered; they do '
        + 'not prove this projection is the whole of it.',
      'The identity of either party. This credential is a transferable bearer '
        + 'capability and the accepting address is self-claimed.',
      'That the work was performed or that any payment moved.',
      'That TrustFlow showed both parties the same history. Comparing this '
        + 'response against the other party\'s export is the only check.',
    ],
  }
}
