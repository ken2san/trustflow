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
 * How long a guest access token stays valid, in days.
 *
 * **30, reduced from 90** (reviewer finding M3). It lives here, next to
 * `guestCredentialStillValid`, because the two functions that mint one —
 * `validate-invite-token` at acceptance and `reissue-guest-access` when the
 * owner replaces it — each had their own `const GUEST_ACCESS_TOKEN_TTL_DAYS =
 * 90`, and two copies of a security lifetime is one copy too many.
 *
 * WHY 30 AND NOT LESS. This token is a bearer credential sitting in one
 * browser's localStorage, and it is also the counterparty's **only** route back
 * to their own record — there is no account to sign into, and
 * `src/lib/guestSession.js` exists because a guest who navigated away had no
 * way back at all. So the lifetime has to outlast the deal and a reasonable
 * period of looking at the record afterwards. 30 days covers the small service
 * agreements this is built for end to end, plus weeks of reading, while cutting
 * the window a forwarded or screenshotted link stays usable by two thirds.
 *
 * WHY NOT LONGER. Nothing expires it early. Re-issuing is the only revocation
 * this system has, and it needs the owner to act, so an unnoticed leak stays
 * live for the whole TTL.
 *
 * WHAT IT COSTS. A counterparty who comes back on day 31 is refused and has to
 * ask the owner to re-issue — a path that exists, is tested, and records
 * `access.reissued`. That is a real cost, paid deliberately: the alternative is
 * a credential that works for a quarter of a year after anyone involved has
 * stopped thinking about the deal.
 *
 * Changing this affects tokens minted AFTER a deploy. Tokens already issued
 * keep the expiry stored on their row; nothing rewrites them, and nothing
 * should — shortening a credential already granted would lock out a
 * counterparty who did nothing wrong.
 */
export const GUEST_ACCESS_TOKEN_TTL_DAYS = 30

/**
 * Compare two strings without an early exit at the first differing character.
 *
 * WHAT THIS IS, STATED AT THE SIZE IT HOLDS. It is **fixed-work, best-effort**:
 * for a non-empty candidate it always walks the full stored length and decides
 * once at the end. It is **not** a cryptographic constant-time guarantee, and
 * an earlier version of this comment claimed otherwise. Codex's finding 3
 * listed exactly why that claim was too strong, and all of it stands:
 *
 *   - an empty candidate returns before the loop runs at all, so it does not
 *     take the same path as a wrong non-empty one;
 *   - JavaScript gives no timing guarantees. String representations, the
 *     `charCodeAt` path and whatever the JIT decides are all outside this
 *     function's control;
 *   - and `!==` *typically* short-circuits but is not required by the language
 *     to, so the thing being improved on was itself an implementation detail.
 *
 * What it does remove is the obvious structural leak: the position of the first
 * mismatch no longer decides how much work happens. If a real guarantee is ever
 * needed, that means a vetted primitive — `node:crypto`'s `timingSafeEqual`
 * over fixed-size buffers — and verifying it is available in the actual Edge
 * Runtime before relying on it.
 *
 * Hand-written rather than that primitive, deliberately and for one reason:
 * this module is bundled into Deno Edge Functions and the commit that
 * introduced it could not be deploy-tested, so a `node:` specifier would have
 * meant shipping a runtime dependency whose availability there was unverified.
 *
 * Length is not hidden and does not need to be: the stored value is a
 * 36-character UUID, that length is public, and the caller knows the length of
 * what it sent.
 */
function secretEquals(stored: string, presented: string): boolean {
  // Fold the length difference into the same accumulator rather than returning
  // early on it, and then walk the stored length whatever the candidate's
  // length is. This does not make a short candidate *cost* the same — see the
  // empty-input caveat above — it removes length as a separate early exit.
  let differences = stored.length ^ presented.length
  for (let i = 0; i < stored.length; i++) {
    // charCodeAt past the end is NaN, and NaN | 0 is 0 — a value no real
    // character shares with a UUID's alphabet, so a truncated candidate cannot
    // match by falling off the end.
    differences |= stored.charCodeAt(i) ^ (presented.charCodeAt(i) | 0)
  }
  return differences === 0
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
 *
 * The equality is **fixed-work**, which is a weaker claim than constant-time
 * and is the one the implementation can actually support — see `secretEquals`.
 * The reason for it is hygiene rather than a demonstrated attack: an attacker
 * would have to already know the `contract_id`, and then recover 122 bits of
 * v4 UUID through the Supabase gateway and a Deno isolate, over the internet,
 * with every request also doing a database read. Nobody is doing that. It is
 * changed because a credential comparison with an obvious early exit stays
 * flagged in every review until it is fixed, and the fix costs no behaviour.
 * Reviewer finding M3; the claim was narrowed after Codex's finding 3.
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
  if (!secretEquals(contract.guest_access_token, presentedToken)) return false
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
 *                        TF005 is deliberately here rather than named: it
 *                        means the write ran at an isolation level the guards
 *                        cannot make promises at (20261108134500), which is a
 *                        server misconfiguration and not something the caller
 *                        did or can retry.
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

/**
 * The one refusal that has to reach an operator rather than a caller.
 *
 * TF005 means a write ran at an isolation level the guards cannot promise
 * anything at, so they refused it (20261108134500). `eventWriteFault` calls
 * that 'unknown' on purpose — it is a 500, not something the caller did — and
 * a 500 alone tells whoever reads the logs nothing about which of a dozen
 * things went wrong. Codex's condition for passing the TF005 design was that
 * the SQLSTATE and the level reach the operational log, and that nothing
 * retries it as if it were tip contention.
 *
 * Returns the line to log, or null when this error is not that. The level is
 * carried in the database's own message, which is why it is included verbatim
 * rather than re-derived here: this function reads no settings.
 */
export function isolationFaultLine(
  where: string,
  error: { code?: string | null, message?: string | null } | null | undefined,
): string | null {
  if (error?.code !== 'TF005') return null
  return `[${where}] TF005 refused the write: the transaction was not READ COMMITTED. `
    + `This is a server configuration fault, not a caller error, and it must not be retried. `
    + `${error.message ?? '(no message)'}`
}
