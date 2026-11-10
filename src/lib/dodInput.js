// "What counts as complete", as the New contract form reads it.
//
// The form used to parse this only on submit, after the CAPTCHA and the emailed
// code, so an empty field was reported as the database's constraint name
// (`contracts_dod_shape_check`) once the person had already spent a code. This
// is the same parse, asked while they are still looking at the field.

import { violationsOf, UNRATIFIED_LIMITS } from '../../supabase/functions/_shared/agreementRules.ts'

/** One item per line; surrounding whitespace and blank lines dropped. */
export function dodItemsFrom(text) {
  return (text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
}

// Only the rules the database itself enforces. agreementRules also has a
// per-item length limit, but it is unratified and no CHECK backs it, so the
// form must not be stricter than the record it is guarding.
const DOD_PROBLEMS = {
  dod_empty: 'Add at least one item, one per line.',
  dod_too_many_items: `At most ${UNRATIFIED_LIMITS.dodMaxItems} items, one per line.`,
}

/** What is wrong with these items, in words, or null if nothing is. */
export function dodProblem(items) {
  const code = violationsOf({ dod: items }).find(c => c in DOD_PROBLEMS)
  return code ? DOD_PROBLEMS[code] : null
}
