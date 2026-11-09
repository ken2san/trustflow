// src/lib/contractStatus.js
//
// How a contract's server-owned `state` becomes something to read and act on.
//
// This is the only place that interprets contracts.state for the UI. It is
// deliberately pure and free of React and Supabase so the grouping rules can be
// tested directly — they decide what the home screen puts in front of you, and
// getting them wrong means quietly hiding work that needs doing.
//
// NOTE ON THE NUMERIC STEP: the contract flow screen tracks a local 1–5 `step`
// that has no relationship to this column. Nothing here reads it. Migrating
// that screen onto the state machine is a later boundary; until then the home
// screen and the flow screen can legitimately disagree, and the home screen is
// the one telling the truth.

import { formatMinor, DEFAULT_CURRENCY } from '../../supabase/functions/_shared/money.ts'

/**
 * Every state name this codebase knows. NOT every one it writes — the header
 * used to say "states the system actually writes", and four of these have no
 * writer:
 *
 *   IN_PROGRESS   described a Stripe authorisation that was never built.
 *   DELIVERED     no writer in this tree. `20260925000000_evidence_core.sql`
 *                 also measured it as never written when it was authored —
 *                 a dated measurement, not something source can establish.
 *   SETTLED       unreachable: `derive_contract_state()` returns early for it
 *                 and the projection only advances on the three
 *                 `performance.*` types.
 *   CANCELLED     no path writes it either; a `contract.cancelled` event
 *                 leaves the projection untouched. See
 *                 `.ada/codex-task12-mode3-review.md`.
 *
 * They stay because rows and exports from earlier builds can carry them and a
 * reader needs a label, and because `SETTLED` being unreachable is asserted by
 * a test. Nothing here is a roadmap.
 */
export const CONTRACT_STATES = {
  DRAFTING:            'DRAFTING',            // created before invites existed
  AWAITING_ACCEPTANCE: 'AWAITING_ACCEPTANCE', // invite issued, not yet accepted
  TERMS_ACCEPTED:      'TERMS_ACCEPTED',      // the Hirer agreed
  IN_PROGRESS:         'IN_PROGRESS',         // no writer; a Stripe step never built
  // Projected from the attested event log. AWAITING_CONFIRMATION says the
  // performer has ASSERTED performance and the protocol waits on the receiver.
  // It does not say the work was delivered — TrustFlow cannot observe that.
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  PERFORMANCE_ACCEPTED:  'PERFORMANCE_ACCEPTED',
  DELIVERED:           'DELIVERED',           // legacy; never written
  SETTLED:             'SETTLED',             // unreachable; nothing releases funds
  CANCELLED:           'CANCELLED',
}

const LABELS = {
  [CONTRACT_STATES.DRAFTING]:            'Draft',
  [CONTRACT_STATES.AWAITING_ACCEPTANCE]: 'Awaiting acceptance',
  [CONTRACT_STATES.TERMS_ACCEPTED]:      'Accepted',
  [CONTRACT_STATES.IN_PROGRESS]:         'In progress',
  [CONTRACT_STATES.AWAITING_CONFIRMATION]: 'Awaiting your review',
  // Where no money moves through TrustFlow, this is the end of the story.
  [CONTRACT_STATES.PERFORMANCE_ACCEPTED]:  'Completed',
  [CONTRACT_STATES.DELIVERED]:           'Awaiting review',
  [CONTRACT_STATES.SETTLED]:             'Completed',
  [CONTRACT_STATES.CANCELLED]:           'Cancelled',
}

// Terminal for the purpose of the home screen: nothing further is expected of
// either party. PERFORMANCE_ACCEPTED belongs here because payment happens
// outside TrustFlow — requiring a settlement that never comes would leave every
// finished agreement sitting in the active list forever.
const TERMINAL = new Set([
  CONTRACT_STATES.SETTLED,
  CONTRACT_STATES.CANCELLED,
  CONTRACT_STATES.PERFORMANCE_ACCEPTED,
])

/** How close to expiry an unaccepted invite has to be before clearing it
 *  becomes the Earner's problem rather than the client's. */
export const EXPIRY_WARNING_HOURS = 24

/** Human label for a state. Unknown states render as themselves rather than
 *  as a blank or a guess — a state this file has not been taught about is
 *  something to notice, not to smooth over.
 *
 *  Pass the contract rather than the bare state where possible: TERMS_ACCEPTED
 *  reads differently once a correction has been asked for, and the state alone
 *  cannot tell the two apart. */
export function statusLabel(stateOrContract) {
  const contract = typeof stateOrContract === 'object' && stateOrContract !== null
    ? stateOrContract
    : null
  const state = contract ? contract.state : stateOrContract

  if (contract
    && (state === CONTRACT_STATES.TERMS_ACCEPTED || state === CONTRACT_STATES.IN_PROGRESS)
    && contract.last_performance_type === 'performance.rejected') {
    return 'Correction requested'
  }

  return LABELS[state] ?? state ?? 'Unknown'
}

export function isTerminal(state) {
  return TERMINAL.has(state)
}

/**
 * Whether the viewer — always the account that owns the agreement — is the one
 * doing the work. Defaults to true, matching every row written before
 * performed_by existed.
 */
export function performsHere(contract) {
  return (contract?.performed_by ?? 'creator') === 'creator'
}

function inviteExpiry(contract) {
  if (!contract.invite_token_expires_at) return null
  const at = new Date(contract.invite_token_expires_at)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * The three clocks this product has. They are kept apart on purpose, because
 * they mean entirely different things and only one of them is part of the
 * agreement:
 *
 *   deadline     — a term of the deal, inside the hashed agreement snapshot.
 *                  Nothing in the product acts on it; it is shown, not enforced.
 *   invite_link  — how long the invitation URL works (72h). Not a term.
 *   guest_access — how long the counterparty's credential works (90d). Not a
 *                  term either, and until now visible to nobody at all.
 *
 * Collapsing them into one "expires" line is how a reader comes to believe the
 * agreement lapses when a link does.
 */
export const CLOCKS = {
  DEADLINE:     'deadline',
  INVITE_LINK:  'invite_link',
  GUEST_ACCESS: 'guest_access',
}

/**
 * Whole days between two instants, counted as CALENDAR days in the reader's
 * own zone. Negative when `at` is in the future.
 *
 * Not elapsed milliseconds over 86,400,000, which was the first version and
 * was wrong twice over. A day is 23 or 25 hours on a DST change, so in
 * America/Toronto a deadline of 2026-03-08 read at 00:30 on 2026-03-09 is
 * 23.5 hours old and floors to 0 — the screen said "today" about a day that
 * had already ended. And "today"/"yesterday" are calendar words: an event an
 * hour before midnight is yesterday whatever the elapsed hours say. Found by
 * Codex, 2026-11-08.
 *
 * Date.UTC over the LOCAL year/month/day gives each calendar day a stable
 * number, with no zone arithmetic of our own.
 */
function calendarDay(at) {
  return Math.floor(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000)
}

function daysBetween(at, now) {
  return calendarDay(now) - calendarDay(at)
}

function instant(value) {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * How long ago, in the fewest words that are still true.
 *
 * Deliberately coarse, and counted in calendar days: "4 days" is the fact
 * someone acts on, "4 days, 3 hours" is noise, and a precise figure computed
 * in the browser against a server timestamp invites a precision the pair does
 * not have. Returns null rather
 * than a guess for a missing or unparseable stamp — see the note on
 * `last_performance_at` in contracts.js: null there can mean "no such event
 * yet" OR "the read failed", and neither is "since now".
 */
export function relativeAge(value, now = new Date()) {
  const at = instant(value)
  if (!at) return null
  const days = daysBetween(at, now)
  if (days < 0) return 'just now'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days`
  if (days < 31) {
    const weeks = Math.round(days / 7)
    return `${weeks} week${weeks === 1 ? '' : 's'}`
  }
  const months = Math.round(days / 30)
  return `${months} month${months === 1 ? '' : 's'}`
}

/**
 * The contractual deadline, and whether it has passed.
 *
 * `deadline` is a date with no time of day, so it is read at local midnight —
 * the same way formatDeadline reads it — and "passed" means the day itself is
 * over. `status` is never anything stronger than an observation: nothing in
 * TrustFlow acts on a deadline, so a passed one is a fact about the agreed
 * date and not a protocol consequence.
 */
export function deadlineStatus(contract, now = new Date()) {
  if (!contract?.deadline) return null
  const at = instant(`${contract.deadline}T00:00:00`)
  if (!at) return null
  const daysLate = daysBetween(at, now)
  if (daysLate > 0) {
    return { at, status: 'passed', days: daysLate, text: `${daysLate} day${daysLate === 1 ? '' : 's'} late` }
  }
  const daysLeft = -daysLate
  if (daysLeft === 0) return { at, status: 'today', days: 0, text: 'today' }
  if (daysLeft <= DEADLINE_SOON_DAYS) {
    return { at, status: 'soon', days: daysLeft, text: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` }
  }
  return { at, status: 'ok', days: daysLeft, text: null }
}

/**
 * A `since` as one short phrase.
 *
 * Kept here rather than in a view because both screens say it and the grammar
 * is the whole subtlety: "Sent 4 days ago" is right and "Sent today ago" is
 * not, so the phrases that are already adverbs take no suffix.
 */
export function sinceText(since) {
  if (!since?.ago) return null
  const bare = since.ago === 'today' || since.ago === 'yesterday' || since.ago === 'just now'
  return bare ? `${since.what} ${since.ago}` : `${since.what} ${since.ago} ago`
}

/** How close a deadline has to be before the days remaining are worth saying. */
export const DEADLINE_SOON_DAYS = 7

/**
 * Every clock that currently applies to this contract, each named for what it
 * actually is.
 *
 * Only the ones that mean something right now: the invite link stops mattering
 * once it is used, and the counterparty's access stops mattering before they
 * have any.
 *
 * Once the agreement is over the credential clocks are hidden and the deadline
 * loses its lateness note. That is a presentation choice, not a claim that the
 * clocks stopped: a finished agreement's access credential still expires on its
 * own date, and the counterparty still loses their view of the record when it
 * does. It is simply not something either party is waiting on. Each entry carries its
 * own date, so a caller never has to decide which "expires" it is looking at.
 */
export function clocksFor(contract, now = new Date()) {
  const out = []
  if (!contract) return out
  const over = isTerminal(contract.state)

  const deadline = deadlineStatus(contract, now)
  if (deadline) {
    out.push({
      kind: CLOCKS.DEADLINE,
      label: 'Due',
      at: deadline.at,
      on: formatDeadline(contract),
      status: over ? 'ok' : deadline.status,
      text: over ? null : deadline.text,
    })
  }

  const inviteExpires = inviteExpiry(contract)
  if (!over && inviteExpires && !contract.invite_token_used_at) {
    const hoursLeft = (inviteExpires - now) / 3_600_000
    out.push({
      kind: CLOCKS.INVITE_LINK,
      label: 'Invite link',
      at: inviteExpires,
      on: formatStamp(inviteExpires),
      status: hoursLeft <= 0 ? 'passed' : hoursLeft <= EXPIRY_WARNING_HOURS ? 'soon' : 'ok',
      text: hoursLeft <= 0
        ? 'expired'
        : hoursLeft <= EXPIRY_WARNING_HOURS
          ? `${Math.max(1, Math.round(hoursLeft))}h left`
          : null,
    })
  }

  const accessExpires = instant(contract.guest_access_token_expires_at)
  if (!over && accessExpires && contract.invite_token_used_at) {
    // An INSTANT comparison, deliberately not the calendar-day arithmetic the
    // deadline uses. `guest_access_token_expires_at` is a timestamptz — a
    // moment the server enforces — where `deadline` is a date with no time of
    // day. Counting calendar days here was a regression introduced by the DST
    // fix and caught by Codex: a credential expiring at 23:00 today is zero
    // calendar days away, so it was reported as already expired while it still
    // had thirteen hours of life. The two clocks look alike and are not.
    const msLeft = accessExpires.getTime() - now.getTime()
    const daysLeft = Math.ceil(msLeft / 86_400_000)
    out.push({
      kind: CLOCKS.GUEST_ACCESS,
      label: 'Their access',
      at: accessExpires,
      on: formatStamp(accessExpires),
      status: msLeft <= 0 ? 'passed' : daysLeft <= GUEST_ACCESS_WARNING_DAYS ? 'soon' : 'ok',
      text: msLeft <= 0 ? 'expired'
        : daysLeft <= GUEST_ACCESS_WARNING_DAYS
          ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
          : null,
    })
  }

  return out
}

/** When the counterparty losing access becomes the owner's problem. */
export const GUEST_ACCESS_WARNING_DAYS = 14

/** A date, short, in the reader's own locale. */
function formatStamp(at) {
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * What happens next on this contract, and whose move it is.
 *
 * `owner` is 'you' when the viewing account has to do something, 'client' when
 * the agreement is legitimately waiting on the other party, and 'none' when it
 * is over. Only 'you' pulls a contract into the Needs you group.
 *
 * The viewer is the account that owns the agreement. Whether that account is
 * the performer or the receiver comes from performed_by, so the same state
 * produces opposite answers for the two sides — which is the point.
 *
 * `since` is when the current wait began, as the chain records it, with null
 * for anything the data cannot answer. It is read from stamps the list query
 * already loads — `created_at`, `accepted_at` and `last_performance_at` — so
 * no state needs a timestamp of its own.
 *
 * @param {object} contract  a row from listContracts()
 * @param {Date}   [now]
 * @returns {{ owner: 'you'|'client'|'none', label: string, detail: string|null,
 *            since: { at: string|null, what: string, ago: string|null }|null }}
 */
export function nextActionFor(contract, now = new Date()) {
  const state = contract?.state
  // `created_at` is labelled "Created", never "Sent". Whether the invitation
  // was ever delivered is not knowable server-side — the token exists from the
  // moment the row does, and copying the link is client-side (Decisions.md,
  // 2026-09-29) — so "Sent 5 days ago" would state an unobserved fact about an
  // agreement that may have been shared with nobody. Codex caught it, and it is
  // the same class of claim this file's own comments exist to prevent.
  const since = (at, what) => {
    const ago = relativeAge(at, now)
    return ago ? { at, what, ago } : null
  }

  if (state === CONTRACT_STATES.SETTLED) {
    return { owner: 'none', label: 'Completed', detail: null, since: null }
  }
  if (state === CONTRACT_STATES.CANCELLED) {
    return { owner: 'none', label: 'Cancelled', detail: null, since: null }
  }

  if (state === CONTRACT_STATES.DRAFTING) {
    return {
      owner: 'you', label: 'Send the invite',
      detail: 'No invitation has been issued for this agreement.',
      since: since(contract.created_at, 'Created'),
    }
  }

  if (state === CONTRACT_STATES.AWAITING_ACCEPTANCE) {
    // Waiting on the client is normal and not something to nag about — but an
    // invite link that has expired, or is about to, is dead weight only the
    // Earner can clear. That is the Earner's move, not the client's.
    //
    // None of the detail strings below says the invitation was SENT, for the
    // same reason `since` says "Created": delivery is manual and client-side,
    // so the server cannot observe it. "Invite sent." was the last of these to
    // go (ADA spotted it after the first fix), and "The invite was opened."
    // went with it — `invite_token_used_at` is stamped when the invitation is
    // CONSUMED at acceptance, so it never meant opened. That branch is also
    // close to unreachable, since consuming the token moves the agreement out
    // of this state; it is left in place rather than removed, because this
    // function surfaces states it does not expect rather than hiding them.
    const expiresAt = inviteExpiry(contract)
    if (contract.invite_token_used_at) {
      return {
        owner: 'client', label: 'Waiting on your client',
        detail: 'The invitation has been used.',
        since: since(contract.created_at, 'Created'),
      }
    }
    if (!expiresAt) {
      return {
        owner: 'client', label: 'Waiting on your client',
        detail: 'Invite link created.',
        since: since(contract.created_at, 'Created'),
      }
    }
    const hoursLeft = (expiresAt - now) / 3_600_000
    if (hoursLeft <= 0) {
      return {
        owner: 'you', label: 'Send a new invite',
        detail: 'The invite link has expired.',
        since: since(contract.created_at, 'Created'),
      }
    }
    if (hoursLeft <= EXPIRY_WARNING_HOURS) {
      return {
        owner: 'you',
        label: 'Invite expires soon',
        detail: `The link expires in ${Math.max(1, Math.round(hoursLeft))} hour${Math.round(hoursLeft) === 1 ? '' : 's'}.`,
        since: since(contract.created_at, 'Created'),
      }
    }
    return {
      owner: 'client', label: 'Waiting on your client',
      detail: 'They have not accepted yet.',
      since: since(contract.created_at, 'Created'),
    }
  }

  if (state === CONTRACT_STATES.PERFORMANCE_ACCEPTED) {
    // The end of the story where money moves outside TrustFlow.
    return { owner: 'none', label: 'Completed', detail: null, since: null }
  }

  // From here the answer depends on which side does the work, so the same
  // state means opposite things to the two parties.
  const youPerform = performsHere(contract)

  if (state === CONTRACT_STATES.TERMS_ACCEPTED || state === CONTRACT_STATES.IN_PROGRESS) {
    // A rejection returns the agreement here, so this state means two quite
    // different things. Saying "ready to deliver" to someone who has just been
    // asked to fix something would lose the only fact that matters.
    const afterCorrection = contract?.last_performance_type === 'performance.rejected'
    if (afterCorrection) {
      const asked = since(contract.last_performance_at, 'Asked')
      return youPerform
        ? { owner: 'you', label: 'Correction requested', detail: 'They asked for a change. Deliver again when ready.', since: asked }
        : { owner: 'client', label: 'Correction requested', detail: 'You asked for a change. Waiting on them.', since: asked }
    }
    const agreed = since(contract.accepted_at, 'Accepted')
    return youPerform
      ? { owner: 'you', label: 'Ready for you to deliver', detail: 'They accepted the terms.', since: agreed }
      : { owner: 'client', label: 'Waiting on them to deliver', detail: 'They accepted the terms.', since: agreed }
  }

  if (state === CONTRACT_STATES.AWAITING_CONFIRMATION) {
    const delivered = since(contract.last_performance_at, 'Marked delivered')
    return youPerform
      ? { owner: 'client', label: 'Waiting on them to review', detail: 'You marked the work delivered.', since: delivered }
      : { owner: 'you', label: 'Review the delivery', detail: 'They marked the work delivered.', since: delivered }
  }

  if (state === CONTRACT_STATES.DELIVERED) {
    return {
      owner: 'client', label: 'Waiting on their review',
      detail: 'Delivery is with them.',
      since: since(contract.last_performance_at, 'Marked delivered'),
    }
  }

  // An unrecognised state is surfaced, not hidden: a contract in a state this
  // file does not know about still belongs somewhere visible.
  return {
    owner: 'you', label: 'Check this agreement',
    detail: `Unrecognised status: ${state}`,
    since: null,
  }
}

/**
 * Split contracts into the three groups the home screen shows.
 *
 * Sorted so the most urgent sits at the top of each group: soonest deadline
 * first, and a contract with no deadline after ones that have one.
 *
 * @param {object[]} contracts
 * @param {Date}     [now]
 * @returns {{ needsYou: object[], inProgress: object[], completed: object[] }}
 */
export function groupContracts(contracts, now = new Date()) {
  const needsYou = []
  const inProgress = []
  const completed = []

  for (const contract of contracts ?? []) {
    if (isTerminal(contract.state)) {
      completed.push(contract)
      continue
    }
    const { owner } = nextActionFor(contract, now)
    if (owner === 'you') needsYou.push(contract)
    else inProgress.push(contract)
  }

  return {
    needsYou: needsYou.sort(byUrgency),
    inProgress: inProgress.sort(byUrgency),
    completed: completed.sort(byRecency),
  }
}

function byUrgency(a, b) {
  const da = a.deadline ? Date.parse(a.deadline) : Infinity
  const db = b.deadline ? Date.parse(b.deadline) : Infinity
  if (da !== db) return da - db
  return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
}

function byRecency(a, b) {
  return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
}

/**
 * Which step the existing contract flow screen should open at for a contract
 * in this state.
 *
 * The flow screen tracks its own local 1–5 counter and has not been migrated
 * onto the state machine — that is a later boundary. This mapping exists only
 * so that opening a real contract does not drop you at step 1 as though
 * nothing had happened yet. It is approximate by construction: CANCELLED has
 * no position in a five-step forward flow and lands at the start, where the
 * screen's own controls are least likely to imply progress that isn't real.
 *
 * Treat contracts.state as the authority on status; this is a starting
 * position for a screen that does not yet read it.
 */
export function stepForState(state) {
  switch (state) {
    case CONTRACT_STATES.TERMS_ACCEPTED:
    case CONTRACT_STATES.IN_PROGRESS:
      return 2
    case CONTRACT_STATES.DELIVERED:
    case CONTRACT_STATES.AWAITING_CONFIRMATION:
      return 3
    case CONTRACT_STATES.PERFORMANCE_ACCEPTED:
      return 5
    case CONTRACT_STATES.SETTLED:
      return 5
    case CONTRACT_STATES.DRAFTING:
    case CONTRACT_STATES.AWAITING_ACCEPTANCE:
    case CONTRACT_STATES.CANCELLED:
    default:
      return 1
  }
}

/**
 * Format an amount the way the contract records it — in its own currency.
 *
 * It used to hard-code a yen sign and `amount_jpy`, which was true of every
 * row that existed. Since 2026-11-08 a contract carries one of six currencies
 * and an integer in that currency's minor unit, so both the symbol and the
 * number of decimals come from the contract rather than from here.
 */
export function formatAmount(contract) {
  const minor = contract?.amount_minor ?? contract?.amount_jpy
  if (minor === null || minor === undefined) return '—'
  return formatMinor(Number(minor), contract?.currency ?? DEFAULT_CURRENCY)
}

/** Deadline as a short, readable date. Null when there isn't one. */
export function formatDeadline(contract) {
  if (!contract?.deadline) return null
  const date = new Date(`${contract.deadline}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
