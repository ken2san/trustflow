// src/lib/eventLog.js
// Append-only contract event log.
//
// WRITES GO THROUGH THE SERVER. This module no longer inserts into `events`.
// logEvent() calls the log-event Edge Function, which derives actor_id from the
// caller's credentials, assigns created_at from its own clock, computes
// event_hash and prev_event_hash itself, and checks the type against an
// allowlist. Nothing this file sends can influence those fields.
//
// Why it changed: the previous path let any holder of the public anon key
// insert an event with any actor_id, type and prev_event_hash, so the chain
// proved nothing about who did what. It had also been failing outright — it
// sent a prev_event_hash column that did not exist in production, and
// persistEvent swallowed the resulting 400 into a console.warn.
//
// Chain integrity is now a database guarantee, not best effort: a unique index
// on (contract_id, prev_event_hash) means two concurrent events cannot both
// claim the same predecessor, so the chain cannot fork. See the log-event
// function and auditExport.js.
//
// Reads stay client-side: fetchContractEvents and subscribeToContractEvents go
// straight to PostgREST under the party-scoped SELECT policy.

import { supabase } from './supabase.js'
import { getGuestAccessToken } from './guestSession.js'

// ── Event type constants ────────────────────────────────────────────────────

export const EVENT_TYPES = {
  CONTRACT_INITIATED:   'contract.initiated',    // DoD agreed, hash created
  CONTRACT_ACCEPTED:    'contract.accepted',     // both parties confirmed
  // What a party SAYS about performance, never what is objectively so.
  // TrustFlow can attest that the Earner asserted delivery; it cannot observe
  // whether anything was delivered. The old work.* names blurred that and are
  // no longer accepted by the server (they remain in historical rows).
  PERFORMANCE_ASSERTED: 'performance.asserted',  // earner asserts they performed
  PERFORMANCE_ACCEPTED: 'performance.accepted',  // hirer confirms that assertion
  PERFORMANCE_REJECTED: 'performance.rejected',  // hirer disputes that assertion
  // What a party SAYS about payment sent by a rail TrustFlow does not
  // control (bank transfer, cash, anything outside Stripe) — a claim, not a
  // processor fact, same shape as performance.* above. Distinct from the
  // Stripe-only payment.* lifecycle further down, which no party may ever
  // write.
  PAYMENT_REPORTED:      'payment.reported',     // payer says they sent it
  PAYMENT_ACKNOWLEDGED:  'payment.acknowledged',  // payee confirms receipt
  PAYMENT_DISPUTED:      'payment.disputed',      // payee says it wasn't received
  MILESTONE_APPROVED:   'milestone.approved',    // milestone payment released
  PAYMENT_RELEASED:     'payment.released',      // full payment released
  DISPUTE_OPENED:       'dispute.opened',        // dispute raised by either party
  DISPUTE_RESOLVED:     'dispute.resolved',      // arbiter or system resolved dispute
  CONTRACT_CANCELLED:   'contract.cancelled',
  CONTRACT_COMPLETED:   'contract.completed',    // step 5 reached
  RATING_SUBMITTED:     'rating.submitted',      // blind rating submitted
  // Bad-actor events — permanently attached to an actor's reputation record
  DISPUTE_LOST:          'dispute.lost',           // arbiter / resolution ruled against this actor
  DISPUTE_WON:           'dispute.won',            // arbiter / resolution ruled in this actor's favor
  FORCED_CANCELLATION:   'contract.forced_cancellation', // contract cancelled by the other party's action
  GHOSTING_FLAG:         'actor.ghosting_flag',    // unresponsive; auto-release timer triggered

  // Stripe payment events — tied to contract state transitions
  PAYMENT_INTENT_CREATED: 'payment.intent_created',  // Stripe PaymentIntent created (funds authorized)
  PAYMENT_CAPTURED:       'payment.captured',         // funds released to Earner via Stripe Transfer
  PAYMENT_REFUNDED:       'payment.refunded',         // funds returned to Hirer (cancellation/dispute)

  // TrustPoints events
  TRUSTPOINTS_EARNED:     'trustpoints.earned',       // points awarded for good behavior
  TRUSTPOINTS_SPENT:      'trustpoints.spent',        // points spent on platform benefit

  // Legal consent events
  DOD_CONSENT_RECORDED:   'dod.consent_recorded',     // counterparty explicitly accepted DoD terms via invite link
}

// ── Event builder ────────────────────────────────────────────────────────────

/**
 * Build an event object locally. This is the shape the UI holds in React
 * state; it is NOT what gets recorded. Persistence goes through logEvent,
 * which sends only the client-supplied fields and lets the server decide the
 * rest — so id, actor_id and created_at here are placeholders that the server
 * replaces on a successful write.
 *
 * @param {object} params
 * @param {string} params.type       - one of EVENT_TYPES
 * @param {string} params.contractId - contract identifier (UUID or mock ID)
 * @param {string} params.actorId    - who triggered this event
 * @param {object} [params.payload]  - arbitrary structured data
 * @param {string} [params.dodHash]  - SHA-256 of DoD (required for contract.initiated)
 * @returns {object} event object
 */
export function createEvent({ type, contractId, actorId, payload = {}, dodHash }) {
  return {
    id: crypto.randomUUID(),
    type,
    contract_id: contractId,
    actor_id: actorId,
    payload,
    dod_hash: dodHash ?? null,
    created_at: new Date().toISOString(),
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

// Sentinel prev_hash for the first event in a contract's chain — distinguishes
// "genuinely the first event" from "prev_hash lookup failed/was skipped".
// Must match GENESIS_HASH in supabase/functions/log-event/index.ts.
export const GENESIS_HASH = 'GENESIS'

/**
 * Record an event on a contract.
 *
 * Only type, contractId, payload and idempotencyKey reach the server.
 * actorId is accepted for the returned local object (App.jsx compares it
 * against the current actor to ignore its own realtime echo) but is NOT sent:
 * the server derives the recorded actor_id from the caller's credentials.
 *
 * Failure is non-fatal and always has been — the caller puts the returned
 * object into React state either way, so the UI behaves identically. What
 * changed is that a rejection is now reported with the server's reason rather
 * than swallowed.
 *
 * Rejections that are expected, not bugs:
 *   contract_not_found — the marketplace demo flow passes fixture ids ('1',
 *                        'mock'). Those are not contracts, so no evidence is
 *                        recorded for them. Resolves itself when that flow is
 *                        wired to real contract rows.
 *   not_a_party        — no verified Earner session and no guest credential.
 *
 * @param {object} params
 * @param {string} params.type
 * @param {string} params.contractId
 * @param {string} [params.actorId]
 * @param {object} [params.payload]
 * @param {string} [params.idempotencyKey] - retrying with the same key returns
 *                                           the event already recorded
 * @returns {Promise<object>} the persisted event, or the local object with
 *                            persisted:false and persist_error set
 */
export async function logEvent({ type, contractId, actorId, payload = {}, idempotencyKey }) {
  // dod_hash is deliberately absent. The server derives which version of the
  // agreement an assertion refers to from the contract itself — a party that
  // could choose it could pin their assertion to terms nobody agreed to. The
  // server rejects the field outright rather than ignoring it.
  const local = createEvent({ type, contractId, actorId, payload })

  if (!supabase) return local

  const guestToken = getGuestAccessToken(contractId)

  const { data, error } = await supabase.functions.invoke('log-event', {
    body: {
      type,
      contract_id: contractId,
      payload,
      idempotency_key: idempotencyKey ?? null,
    },
    ...(guestToken ? { headers: { 'x-guest-access-token': guestToken } } : {}),
  })

  const reason = data?.error ?? (error ? error.message : null)
  if (reason || !data?.event) {
    console.warn(`[TrustFlow] event not recorded (${type}): ${reason ?? 'no event returned'}`)
    return { ...local, persisted: false, persist_error: reason ?? 'unknown' }
  }

  return data.event
}

/**
 * Read latest events for a contract.
 * Returns [] in local/mock mode or on query failure.
 *
 * @param {string} contractId
 * @returns {Promise<Array<object>>}
 */
export async function fetchContractEvents(contractId) {
  if (!supabase || !contractId) return []

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.warn('[TrustFlow] contract events fetch failed:', error.message)
    return []
  }

  return data || []
}

/**
 * Subscribe to realtime inserts for one contract.
 * Returns an unsubscribe function.
 *
 * @param {string} contractId
 * @param {(event: object) => void} onInsert
 * @returns {() => void}
 */
export function subscribeToContractEvents(contractId, onInsert) {
  if (!supabase || !contractId) return () => {}

  const channel = supabase
    .channel(`events:${contractId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'events',
        filter: `contract_id=eq.${contractId}`,
      },
      payload => {
        if (payload?.new) onInsert(payload.new)
      }
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}
