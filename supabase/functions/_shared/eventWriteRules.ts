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

/**
 * Is this guest capability still the one the contract carries, and still live?
 *
 * The same test as at the start of the request, meant to be applied again
 * against a row read later. A guest's authority is a bearer token held in one
 * browser's localStorage; `reissue-guest-access` replaces it, and replacing it
 * is the only credential revocation this system has. If the token is checked
 * once and the row is written some round trips later, a credential revoked in
 * between still writes — which makes revocation a cache invalidation rather
 * than a withdrawal of authority.
 *
 * Strict equality, not a prefix or a case-insensitive compare: the stored
 * value is a UUID the server minted, and anything looser would widen what
 * counts as the credential. A row with no token, no expiry, or an expiry that
 * does not parse is not a credential — absent is refused, never waved through.
 */
export function guestCredentialStillValid(
  contract: {
    guest_access_token?: unknown
    guest_access_token_expires_at?: unknown
  } | null | undefined,
  presentedToken: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!contract || !presentedToken) return false
  if (typeof contract.guest_access_token !== 'string') return false
  if (contract.guest_access_token !== presentedToken) return false
  const expires = contract.guest_access_token_expires_at
  if (typeof expires !== 'string' || !expires) return false
  const expiresAt = new Date(expires)
  if (Number.isNaN(expiresAt.getTime())) return false
  return expiresAt.getTime() >= now.getTime()
}

/**
 * May an event stamped `createdAt` follow a predecessor stamped `prevCreatedAt`?
 *
 * `events.created_at` is assigned in the Edge Function, from the clock of
 * whichever isolate served the request, and it is covered by the event hash —
 * so it cannot be corrected afterwards by the database or by anyone. Every
 * reader in the system nevertheless orders by it: the chain-tip read in
 * log-event and reissue-guest-access, `derive_contract_state()`, and the trail
 * both parties are shown.
 *
 * Nothing constrained it to advance. Two ways it does not:
 *
 *   * Two isolates whose clocks disagree. An event chained after its
 *     predecessor carries an earlier stamp, so the tip read returns the
 *     predecessor, the next write links to a tip that is not last, and
 *     `events_chain_no_fork_idx` refuses it — a chain that cannot be extended
 *     at all. Worse first: `derive_contract_state()` takes the latest
 *     performance event by that same ordering, so the agreement's state
 *     becomes the one the inverted event names. An acceptance followed by a
 *     rejection reads as a rejection followed by an acceptance.
 *   * Two events inside one millisecond, which `toISOString()` cannot tell
 *     apart. The readers break that tie on `id`, a random UUID, so the order
 *     of two equally-stamped events is whichever way the UUIDs happened to
 *     sort — arbitrary, and no better than an inversion. This one needs no
 *     skewed clock and no second region; an agent that retries quickly is
 *     enough.
 *
 * Hence strictly greater, which forbids both. A tie is transient and the
 * writer's next attempt resolves it; a skew is not, and the writer must
 * refuse rather than commit a record whose order cannot be read back.
 *
 * Refusing is not the only defensible answer, and the other two were left to
 * the owner rather than taken here: clamp the stamp to just after its
 * predecessor (fixes the order, but makes `created_at` something other than
 * the server's reading of its own clock, inside the hash, permanently), or
 * order every reader by the chain instead of the clock (correct, and a
 * migration to `derive_contract_state` plus every reader).
 */
export function createdAtFollows(
  prevCreatedAt: string | null | undefined,
  createdAt: string,
): boolean {
  if (!prevCreatedAt) return true
  const prev = new Date(prevCreatedAt).getTime()
  const next = new Date(createdAt).getTime()
  // An unreadable stamp is not a licence to write. The predecessor is a row
  // this server wrote, so a bad value there means something worse than
  // disorder, and treating it as "no predecessor" would wave the write past
  // the one check that would have shown it.
  if (Number.isNaN(prev) || Number.isNaN(next)) return false
  return next > prev
}

/**
 * What the database said when it refused an insert into `events`.
 *
 * The guards on that table raise a SQLSTATE of their own so that the answer to
 * the caller can be the right one. They were compared as string
 * literals at each site, which is how 'TF001' came to be handled in one place
 * and not another; naming them once removes that.
 *
 *   'wrong_state'        TF001, enforce_performance_order. The agreement is
 *                        not in a state this event can follow. Never retried:
 *                        the loop exists for a contested tip, and retrying a
 *                        wrong-state refusal does nothing the caller did not
 *                        already do.
 *   'contract_gone'      TF002, enforce_event_parent_contract. The agreement
 *                        was deleted while this write was in flight. Never
 *                        retried either — nothing brings it back.
 *   'clock_behind_chain' TF003, enforce_event_created_at_follows. This
 *                        writer's stamp is at or behind the last event on the
 *                        contract. Worth one more attempt, unlike the two
 *                        above: a tie resolves itself a round trip later
 *                        because the next attempt stamps a new time. A skew
 *                        does not, and ends as a refusal that names itself.
 *   'tip_taken'          23505, events_chain_no_fork_idx or
 *                        events_idempotency_idx. Which of the two it is has
 *                        to be read off the message, so that stays at the
 *                        call site; this only says the insert collided.
 *   'unknown'            anything else, which is a 500 and not a refusal.
 */
export type EventWriteFault =
  | 'wrong_state'
  | 'contract_gone'
  | 'clock_behind_chain'
  | 'tip_taken'
  | 'unknown'

export function eventWriteFault(code: string | null | undefined): EventWriteFault {
  switch (code) {
    case 'TF001': return 'wrong_state'
    case 'TF002': return 'contract_gone'
    case 'TF003': return 'clock_behind_chain'
    case '23505': return 'tip_taken'
    default:      return 'unknown'
  }
}
