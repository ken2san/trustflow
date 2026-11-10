// The Amount field, as the New contract form reads it.
//
// The form used to treat an empty field as "nothing to say yet", so Send Invite
// stayed enabled and the submit sent 0. The database refuses that as
// `contracts_amount_minor_positive_check`, but only after the CAPTCHA and the
// emailed code. An empty amount is now a problem like any other, asked while
// the person is still looking at the field.

import { minorUnitsFrom } from '../../supabase/functions/_shared/money.ts'

/**
 * What to say when an amount cannot be recorded.
 *
 * One line each, in the terms of the thing the person typed rather than the
 * code the parser returned: `amount_too_precise` is the interesting one,
 * because for JPY it means "this currency has no decimals" and for CAD it
 * means "two at most", and those are different sentences.
 */
const AMOUNT_PROBLEMS = {
  amount_malformed: 'Digits, with an optional decimal point. No currency symbols or commas.',
  amount_too_precise: 'More decimal places than this currency has.',
  amount_not_positive: 'An amount has to be more than zero.',
  amount_too_large: 'Larger than this can record.',
  currency_unsupported: 'That currency is not one of the ones this records.',
}

/** What is wrong with this amount, in words, or null if nothing is. */
export function amountProblem(text, currency) {
  const typed = (text ?? '').trim()
  if (!typed) return 'Enter the amount you are agreeing to.'
  const parsed = minorUnitsFrom(typed, currency)
  return parsed.ok ? null : AMOUNT_PROBLEMS[parsed.reason] ?? 'That is not an amount this can record.'
}
