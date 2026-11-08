// supabase/functions/_shared/eventWriteRules.ts
//
// The rules that decide whether an event may be written, pulled out of the
// function that writes it.
//
// WHY THEY ARE HERE AND NOT INLINE IN log-event
// Each of these was inline, stated more than once in that file, and in each
// case one of the copies was the lenient one. That is the same drift
// that produced the only production bug this hash chain has ever had, and it
// is why eventCanonical.ts and eventRecord.ts already live here. Inline in a
// `serve()` handler they are also untestable without a Deno runtime, a
// database and two credentials — so the only check they had was the one path
// an end-to-end harness happens to walk, which for a race is no path at all.
//
// All of them are pure. None reads the clock, the request or the database;
// the caller supplies what it has already read.

/**
 * What an existing row under this idempotency key means for THIS operation.
 *
 * `events_idempotency_idx` is unique on (contract_id, idempotency_key) and
 * nothing more, so a row found under a key is not necessarily the caller's.
 * A key identifies an operation — one actor, one type — not a contract:
 *
 *   'replay'   the caller's own earlier write. Return it; that is the promise
 *              idempotency makes to an agent that retries.
 *   'conflict' someone else's write, or the same caller's different
 *              operation. Refuse. Returning it would disclose another party's
 *              event in full, payload and internal fields included, bypassing
 *              the allowlist projection `guest-contract-events` exists to
 *              apply — measured 2026-11-06, HTTP 200 with the owner's
 *              internal note in the guest's response.
 *   'none'     no such row.
 *
 * The caller must never return a row this function called a conflict, and
 * must never decide for itself that a row is a replay: the three sites in
 * log-event that answer an idempotency hit — the lookup before the insert,
 * the TF001 twin check, and the unique-violation branch — had three different
 * answers, and the last one returned the row unconditionally.
 */
export type IdempotencyOutcome = 'none' | 'replay' | 'conflict'

export function idempotencyOutcome(
  existing: { type?: unknown; actor_id?: unknown } | null | undefined,
  operation: { type: string; actorId: string },
): IdempotencyOutcome {
  if (!existing) return 'none'
  return existing.type === operation.type && existing.actor_id === operation.actorId
    ? 'replay'
    : 'conflict'
}
