// supabase/functions/_shared/shownTerms.ts
//
// One definition of "the terms the counterparty was shown", so the browser and
// the acceptance function can agree on whether they moved.
//
// WHY THIS EXISTS
// The acceptance request carries only the invite token. The server re-reads the
// contract and builds the hashed agreement snapshot from THAT row, so what is
// recorded is the deal as it stands at the click, not the deal on the guest's
// screen — which may have loaded minutes earlier. The row_version check inside
// validate-invite-token guards only its own read-to-write window. Between the
// invitation rendering and the guest agreeing, the owner can edit the
// agreement, and the guest would be recorded as having accepted terms they were
// never shown. For a product whose only claim is "this is what was agreed",
// that is the claim failing. Found by Codex's review, 2026-11-05.
//
// So the browser sends the digest of what it displayed, and the acceptance
// refuses when the row no longer matches it.
//
// WHAT THIS IS NOT
// Not a security boundary, and not proof of what anyone read. The caller
// computes the digest it sends and can send any value it likes. It protects an
// honest guest from an honest edit, which is the failure that actually happens.
// Anything that must be unforgeable belongs in the server's own read.
//
// WHY IT IMPORTS RATHER THAN COPIES
// `stableStringify` already solves key ordering, and a second implementation of
// it would drift from the one the evidence chain uses. `src/lib/auditExport.js`
// already imports this directory from the browser, so the precedent and the
// bundling both exist. Keep this file free of Deno APIs and of anything that
// reads the environment: it is compiled into the web bundle as well.

import { sha256Hex, stableStringify } from './eventCanonical.ts'

/**
 * The format version this client computes.
 *
 * Changing WHICH fields are covered, their order, or how they are normalised
 * changes the digest for an unchanged contract, which would refuse every
 * in-flight acceptance.
 *
 * The version therefore travels WITH the digest rather than being implied by
 * it. A digest is opaque: a server that assumed its own version would reject
 * every acceptance from a client one deploy ahead or behind, which is the
 * blanket refusal this whole mechanism exists to avoid. Codex's review of the
 * first implementation caught exactly that — the comment here promised a
 * two-version deploy that the code could not perform.
 *
 * To add a version: add a builder to BUILDERS, bump this constant, ship the
 * server first so it can verify both, then the clients.
 */
export const SHOWN_TERMS_VERSION = 2

/** A contract row, or the invitation response built from one. */
type TermsSource = Record<string, unknown> | null | undefined

/**
 * The terms as a fixed shape: the fields the invitation puts on screen, and
 * nothing else.
 *
 * Deliberately excluded: `guest_access_token`, which is minted per read and
 * would differ on every comparison; `invited_hirer_email`, which the guest may
 * replace with their own address and which is not a term of the deal; and the
 * contract id, which cannot change for one invitation. Including any of them
 * would refuse acceptances that nobody edited.
 *
 * `dod` keeps its order — a reordered list of completion criteria is a
 * different agreement, and `buildAgreementSnapshot` hashes it in order too —
 * and `null` becomes `[]` to match that same function, so "unset" and "empty"
 * cannot produce two digests for one contract.
 */
export function shownTerms(
  source: TermsSource,
  version: number = SHOWN_TERMS_VERSION,
): Record<string, unknown> | null {
  const build = BUILDERS[version]
  return build ? build(source ?? {}) : null
}

/** Every version this build can verify. */
export const SUPPORTED_SHOWN_TERMS_VERSIONS = [1, 2]

const BUILDERS: Record<number, (row: Record<string, unknown>) => Record<string, unknown>> = {
  1: (row) => ({
    v: 1,
    project_name: row.project_name ?? null,
    dod: row.dod ?? [],
    amount_jpy: row.amount_jpy ?? null,
    currency: row.currency ?? null,
    deadline: row.deadline ?? null,
    // The invitation renders 'creator' when the column is absent, so the digest
    // has to read the same default or an older contract would never match.
    performed_by: row.performed_by ?? 'creator',
    earner_display_name: row.earner_display_name ?? null,
  }),

  // v2 — the amount is read from `amount_minor`.
  //
  // WHY THE BUMP IS NOT OPTIONAL. v1 covers `amount_jpy`, which on a contract
  // that is not in yen is NULL for every row (20261108161000). Left on v1, the
  // digest of a CAD invitation would be the same before and after the owner
  // changed its price — the one thing this mechanism exists to catch, silently
  // not caught, on exactly the contracts the currency work was done for. The
  // currency itself was already covered, so the gap is the amount alone.
  //
  // v1 stays verifiable, and that is what makes the deploy safe: a browser on
  // the previous bundle sends `{digest, version: 1}` and the server still
  // checks it. Deploy order is the one this file has always specified —
  // functions first, then the clients.
  2: (row) => ({
    v: 2,
    project_name: row.project_name ?? null,
    dod: row.dod ?? [],
    // `amount_jpy` is the fallback for one case only: a contract read through a
    // path that has not been redeployed yet, where it is still the same integer
    // as amount_minor by database CHECK.
    amount_minor: row.amount_minor ?? row.amount_jpy ?? null,
    currency: row.currency ?? null,
    deadline: row.deadline ?? null,
    performed_by: row.performed_by ?? 'creator',
    earner_display_name: row.earner_display_name ?? null,
  }),
}

/**
 * SHA-256 hex of those terms. Same input and version, same digest, on either
 * side. `null` when this build does not know the version asked for — the
 * caller decides what to do about that, because "I cannot check" and "they do
 * not match" are different answers and must not share a message.
 */
export async function shownTermsDigest(
  source: TermsSource,
  version: number = SHOWN_TERMS_VERSION,
): Promise<string | null> {
  const terms = shownTerms(source, version)
  return terms === null ? null : await sha256Hex(stableStringify(terms))
}
