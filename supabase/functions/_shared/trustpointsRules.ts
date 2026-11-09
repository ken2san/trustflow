// supabase/functions/_shared/trustpointsRules.ts
//
// The TrustPoints deltas, as plain numeric constants with no Deno-specific
// APIs, so the file can be imported straight from the frontend.
//
// IT HAS ONE IMPORTER NOW: src/lib/trustpoints.js, in the web bundle. The two
// Edge Functions that awarded and deducted these — capture-payment and
// cancel-payment — are deleted (Task 20), so nothing server-side reads this
// file and no points are awarded anywhere. It is kept because the frontend
// still imports the constants and tests/unit/trustpoints.test.js covers them;
// deleting it would be a frontend change wearing a cleanup's clothes.
//
// This file originally existed because those two functions each hardcoded
// their own copies of the numbers, with nothing keeping them in step with what
// the frontend called the rule. That problem is gone with them.

export const TP_CONTRACT_COMPLETED = 50
export const TP_ON_TIME_BONUS = 20
export const TP_CONTRACT_COMPLETED_HIRER = Math.round(TP_CONTRACT_COMPLETED * 0.4)
export const TP_CANCELLATION_PENALTY = -30
