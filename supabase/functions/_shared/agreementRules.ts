// supabase/functions/_shared/agreementRules.ts
//
// What a proposed agreement must look like to be worth freezing into evidence.
//
// WHY THIS FILE EXISTS, AND WHY HERE
// Authority is enforced at the server and meaning is enforced only in the
// browser. Column grants and RLS are genuinely strong — `state`, `invite_token`,
// `dod_hash` and the settlement columns are server-owned, the client's INSERT
// grant on them is revoked, UPDATE on `contracts` is denied to `authenticated`
// outright, and freeze_accepted_terms() raises on any post-acceptance change to
// an agreed field. So a row cannot be tampered with after the fact.
//
// What is not checked anywhere is what may be in the row to begin with. Ten
// probes went in as plain PostgREST inserts on 2026-10-11 and all ten were
// accepted: a deadline in 2020, a zero amount, a negative amount, an empty
// definition of done, a `dod` that was a string rather than an array, an empty
// project name, currency 'ZZZ', a malformed address, and a 10,000-character
// display name. Each would then be frozen into the agreement snapshot at
// acceptance and hashed into every event of the chain, permanently.
//
// This module sits in _shared/ for the same reason eventCanonical.ts and
// trustpointsRules.ts do: the browser imports from here, and so will the
// server-side creation path. One definition. The one production bug this
// project's hash chain has ever had came from two implementations of a rule
// drifting apart, and a validation rule duplicated between a React form and an
// Edge Function would drift the same way — with the UI copy silently becoming
// the lenient one, which is exactly today's situation.
//
// WHAT IS DELIBERATELY NOT HERE
// Anything about whether the deal is wise, fair, or true. These rules decide
// only whether a proposal is well-formed enough to be recorded. TrustFlow
// attests that a party said something; it does not vet what they said.

/** Every rule violation this module can report. Stable strings: they are an API. */
export type RuleViolation =
  | 'project_name_required' | 'project_name_too_long'
  | 'dod_not_array' | 'dod_empty' | 'dod_too_many_items'
  | 'dod_item_not_string' | 'dod_item_blank' | 'dod_item_too_long'
  | 'amount_not_an_integer' | 'amount_not_positive'
  | 'currency_unsupported'
  | 'deadline_malformed' | 'deadline_in_the_past'
  | 'invited_email_malformed'
  | 'display_name_too_long'
  | 'performed_by_invalid'

/**
 * The only currency.
 *
 * Not a judgement about the future: the amount column is literally
 * `amount_jpy`, and 1466 of 1466 rows across both projects are JPY. A second
 * currency is a schema change and a product decision, not a validation relaxation.
 */
export const SUPPORTED_CURRENCIES = ['JPY'] as const

/** `performed_by` already has a database CHECK; this mirrors it for the caller. */
export const PERFORMED_BY_VALUES = ['creator', 'counterparty'] as const

/**
 * Bounds whose SHAPE is ratified but whose NUMBER is not.
 *
 * Each is a cap on length, never on meaning, and each is set well clear of
 * every value that exists. Observed maxima across production (1321 contracts,
 * 2051 dod items) and E2E (145 contracts) on 2026-10-11:
 *
 *   project_name         44 characters
 *   dod                   3 items
 *   dod item             23 characters
 *   earner_display_name  28 characters
 *
 * No prior specification sets any of these, so the numbers below are headroom,
 * not policy, and are marked UNRATIFIED for that reason. They exist to stop a
 * 10,000-character field from being hashed into a chain forever, which is a
 * different question from what a sensible maximum is. Raising one is backwards
 * compatible; lowering one is not, so they start generous.
 */
export const UNRATIFIED_LIMITS = {
  projectNameMaxChars: 500,
  dodMaxItems: 50,
  dodItemMaxChars: 1000,
  displayNameMaxChars: 200,
} as const

/**
 * NO UPPER BOUND ON AMOUNT, on purpose.
 *
 * It is tempting to add one, and it would contradict the only specification
 * this project has on the subject. The Progressive Trust Ladder
 * (src/lib/constants.js) caps contracts by level — ¥100k, ¥500k, ¥2M — and
 * then `contractLimit: null`, explicitly unlimited at level 10. A hard database
 * ceiling would make that final tier undeliverable.
 *
 * So an amount cap is a per-account policy check against the actor's level,
 * which is a different layer with a different owner, and it is not part of
 * well-formedness. What belongs here is only that the number is a positive
 * integer: JPY has no minor unit, the column is `integer`, and all 1466
 * existing rows are >= 1.
 */
export const AMOUNT_HAS_NO_UPPER_BOUND = true

/**
 * Deliberately permissive address shape.
 *
 * It rejects what is certainly not an address — no `@`, no dot in the domain,
 * embedded whitespace — and nothing else. Validating email properly is famously
 * unreachable, and the consequence of a false rejection here is worse than a
 * false acceptance: this address is the only handle on a counterparty who has
 * no account, so refusing a legitimate one blocks a real agreement. A typo'd
 * but well-shaped address is already handled honestly elsewhere, by recording
 * it as `_claimed_identity_verified: false`.
 *
 * The same expression matched 100% of existing values in both projects.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * How much timezone slack a deadline floor must allow. One day, and the reason
 * is concrete rather than defensive.
 *
 * Both Supabase projects run with TimeZone = UTC, so `current_date` on the
 * server is a UTC date. A user west of Greenwich can be a calendar day behind
 * it: at 00:30 UTC on the 11th it is still the 10th in Vancouver, so a server
 * rule of `deadline >= current_date` would reject "today" as already past for
 * someone sitting in UTC-7. That is the same off-by-one that produced the UI
 * bug fixed on 2026-10-11, where `toISOString()` made today read as past east
 * of Greenwich — the identical mistake, mirrored, and a server-side version of
 * it would be worse because it would refuse the write rather than warn.
 *
 * One day of slack covers every real offset (UTC-12..UTC+14 spans 26 hours, so
 * a one-day floor is correct in both directions) and costs only the ability to
 * reject a deadline that is at most 24 hours stale. Rejecting 2020-01-01 is the
 * point; rejecting yesterday is not worth a false refusal.
 */
export const DEADLINE_TIMEZONE_SLACK_DAYS = 1

/** A date `days` before the given instant, as YYYY-MM-DD in UTC. */
export function deadlineFloor(now: Date = new Date(), days = DEADLINE_TIMEZONE_SLACK_DAYS): string {
  const d = new Date(now.getTime() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

export interface ProposedAgreement {
  project_name?: unknown
  dod?: unknown
  amount_jpy?: unknown
  currency?: unknown
  deadline?: unknown
  invited_hirer_email?: unknown
  earner_display_name?: unknown
  performed_by?: unknown
}

/**
 * Every violation in a proposal, not the first.
 *
 * All of them, because a caller that fixes one field per round trip is an agent
 * in a retry loop, and because a form can only highlight what it was told
 * about. Order is stable so a test can assert on it.
 *
 * `now` is injectable for the same reason the deadline rule needs slack: a test
 * that cannot control the clock either skips the boundary or fails at midnight.
 */
export function violationsOf(
  proposal: ProposedAgreement,
  { now = new Date() }: { now?: Date } = {},
): RuleViolation[] {
  const bad: RuleViolation[] = []
  const {
    project_name, dod, amount_jpy, currency, deadline,
    invited_hirer_email, earner_display_name, performed_by,
  } = proposal

  // ── project name ──────────────────────────────────────────────────────────
  const name = typeof project_name === 'string' ? project_name.trim() : ''
  if (name.length === 0) bad.push('project_name_required')
  else if (name.length > UNRATIFIED_LIMITS.projectNameMaxChars) bad.push('project_name_too_long')

  // ── definition of done ────────────────────────────────────────────────────
  // The terms themselves. dod_hash is derived from this server-side and is
  // cited by every event, so an empty or malformed one produces a chain whose
  // every link points at nothing.
  if (!Array.isArray(dod)) {
    bad.push('dod_not_array')
  } else if (dod.length === 0) {
    bad.push('dod_empty')
  } else {
    if (dod.length > UNRATIFIED_LIMITS.dodMaxItems) bad.push('dod_too_many_items')
    // Reported once per kind rather than once per element: a caller needs to
    // know the shape is wrong, not to receive fifty identical complaints.
    if (dod.some(item => typeof item !== 'string')) bad.push('dod_item_not_string')
    if (dod.some(item => typeof item === 'string' && item.trim().length === 0)) bad.push('dod_item_blank')
    if (dod.some(item => typeof item === 'string' && item.length > UNRATIFIED_LIMITS.dodItemMaxChars)) {
      bad.push('dod_item_too_long')
    }
  }

  // ── amount ────────────────────────────────────────────────────────────────
  if (typeof amount_jpy !== 'number' || !Number.isInteger(amount_jpy)) {
    bad.push('amount_not_an_integer')
  } else if (amount_jpy <= 0) {
    bad.push('amount_not_positive')
  }

  // ── currency ──────────────────────────────────────────────────────────────
  if (typeof currency !== 'string'
      || !(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    bad.push('currency_unsupported')
  }

  // ── deadline ──────────────────────────────────────────────────────────────
  // Nullable, and that must not change: 957 of 1321 production contracts have
  // no deadline. An agreement without one is a real agreement.
  if (deadline !== null && deadline !== undefined && deadline !== '') {
    if (typeof deadline !== 'string' || !ISO_DATE.test(deadline)
        || Number.isNaN(Date.parse(`${deadline}T00:00:00Z`))) {
      bad.push('deadline_malformed')
    } else if (deadline < deadlineFloor(now)) {
      bad.push('deadline_in_the_past')
    }
  }

  // ── counterparty address ──────────────────────────────────────────────────
  if (invited_hirer_email !== null && invited_hirer_email !== undefined && invited_hirer_email !== '') {
    if (typeof invited_hirer_email !== 'string' || !EMAIL_SHAPE.test(invited_hirer_email)) {
      bad.push('invited_email_malformed')
    }
  }

  // ── display name ──────────────────────────────────────────────────────────
  // Nullable, and it is `offered_by` in the agreement snapshot: who the
  // counterparty understood themselves to be dealing with.
  if (typeof earner_display_name === 'string'
      && earner_display_name.length > UNRATIFIED_LIMITS.displayNameMaxChars) {
    bad.push('display_name_too_long')
  }

  // ── which side performs ───────────────────────────────────────────────────
  // Flipping this inverts the entire transaction, which is why it is already
  // the one field with a database CHECK.
  if (performed_by !== undefined && performed_by !== null
      && !(PERFORMED_BY_VALUES as readonly string[]).includes(performed_by as string)) {
    bad.push('performed_by_invalid')
  }

  return bad
}

/** Convenience for a caller that only needs a yes or no. */
export function isWellFormed(proposal: ProposedAgreement, opts?: { now?: Date }): boolean {
  return violationsOf(proposal, opts).length === 0
}
