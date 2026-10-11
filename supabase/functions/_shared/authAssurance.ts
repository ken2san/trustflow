// supabase/functions/_shared/authAssurance.ts
//
// What the record should say about HOW a party authenticated — and, just as
// importantly, what it must not claim.
//
// THE DEFECT THIS REPLACES
// `eventRecord.ts` currently writes:
//
//     _auth_method: party === 'guest_hirer' ? 'invite_capability' : 'account_session'
//
// a hardcoded ternary on the actor's role. It sits next to `_actor_role`, which
// already holds that role, so the field carries no information at all while
// looking exactly like an assurance claim. Measured across production's 2396
// events it takes precisely two values, one per role, and 2134 events predate
// it and have none.
//
// Meanwhile the JWT on every request already carries what the field pretends to
// hold. Observed live:
//
//     aal: "aal1"
//     amr: [{ "method": "password", "timestamp": 1791731476 }]
//
// So the authentication method, its assurance level and the instant it happened
// are available and discarded. Worse: the API harness signs in with a password
// and its events are recorded as `account_session`, which is byte-identical to
// what a human's emailed-OTP sign-in produces. **The record cannot currently
// distinguish a test script from a person.**
//
// WHAT AUTHENTICATION IS NOT
// Three things get conflated and this module keeps them apart:
//
//   AUTHENTICATION  — evidence that whoever acted controls a credential.
//   AUTHORIZATION   — evidence they were permitted to act on this agreement.
//   SIGNATURE / CONSENT — evidence they intended to be bound by these terms.
//
// An authentication event is not a signature. Ontario's Electronic Commerce Act
// treats a signature as electronic information "created or adopted in order to
// sign" and "associated with" the document — so what makes consent evidential
// is the BINDING between an authenticated action and a specific agreement
// version, not the strength of the login. TrustFlow already has that binding:
// every event carries `agreement_hash` over the exact terms. The missing half
// is an honest record of the authentication it was bound to.
//
// And a deliberately unflattering note, which belongs in the code rather than a
// doc: NIST SP 800-63B-4 does not accept email as an out-of-band authenticator.
// An emailed OTP demonstrates control of a mailbox at a moment in time. It is
// not identity proofing, and this module never labels it as such.

/** The subset of a Supabase JWT this module reads. */
export interface SessionClaims {
  aal?: string | null
  amr?: Array<{ method?: string; timestamp?: number }> | null
  is_anonymous?: boolean | null
  session_id?: string | null
}

/**
 * How much the record is entitled to claim. Ordered, and deliberately coarse:
 * a finer scale would invite reading it as identity assurance.
 */
export type AssuranceLevel =
  /** A bearer capability was presented. No account, no authentication event. */
  | 'bearer_capability'
  /** An authenticated account session, method recorded below. */
  | 'account_session'
  /** Anonymous session. Must never reach an evidence write. */
  | 'anonymous'

export interface AuthAssurance {
  assurance: AssuranceLevel
  /** From `amr`, e.g. 'otp', 'magiclink', 'password'. null when unknown. */
  method: string | null
  /** Supabase's own level, e.g. 'aal1'. Recorded verbatim, not interpreted. */
  aal: string | null
  /** When the credential was actually presented — NOT when this event was written. */
  authenticated_at: string | null
  /**
   * Seconds between authenticating and writing this event.
   *
   * Worth recording because a Supabase session outlives its access token
   * through refresh, so `amr.timestamp` can be days or weeks before the act.
   * "Signed in at some point" and "signed in moments ago" are different
   * facts, and only this number tells them apart.
   *
   * It is a fact about the SESSION, not about the act. See below.
   */
  seconds_since_authentication: number | null
  /**
   * Whether the authentication happened inside the recency window. Nothing more.
   *
   * An earlier version of this module called this `reauthenticated_for_this_act`
   * and `assuranceMeaning` reported that "the credential was presented as part
   * of this act". Both were overclaims, of exactly the kind this project keeps
   * paying for: recency is not binding. A party who authenticated five minutes
   * ago and then performed some other action entirely produces an identical
   * value, so the field cannot distinguish "authenticated in order to do this"
   * from "happened to have authenticated recently".
   */
  recent_authentication: boolean
  /**
   * Whether the authentication was cryptographically bound to THIS act.
   *
   * Always false today, and it is important that it is a recorded false rather
   * than an absent field: a reader should be able to see that the question was
   * asked and answered negatively.
   *
   * Making it true requires a challenge the actor could not have answered for
   * any other act: a server-issued nonce bound to this `agreement_hash` and
   * this action, presented back and verified at write time. No such mechanism
   * exists, so no value of `seconds_since_authentication` may ever be allowed
   * to imply one. This is also the honest boundary between "a signature" and
   * "consent given through an authenticated session" — only act-bound
   * authentication is in the neighbourhood of the former.
   */
  act_bound_authentication: false
  /** Why act-binding is absent, so the gap is legible rather than inferred. */
  act_binding_mechanism: null
}

/**
 * The recency window. A POLICY CANDIDATE, not a guarantee and not grounded in
 * any standard — 300 seconds is a round number, and nothing in the product has
 * ratified it. It exists so the threshold is a named, reviewable value instead
 * of a bare comparison buried in a function.
 */
export const RECENT_AUTHENTICATION_WINDOW_SECONDS = 300

/**
 * Read assurance off the claims. Never throws: a missing claim becomes an
 * explicit null, because inventing a value here would be the whole problem.
 */
export function assuranceFromClaims(
  claims: SessionClaims | null | undefined,
  now: Date = new Date(),
): AuthAssurance {
  if (!claims) {
    return {
      assurance: 'bearer_capability', method: null, aal: null,
      authenticated_at: null, seconds_since_authentication: null,
      recent_authentication: false,
      act_bound_authentication: false, act_binding_mechanism: null,
    }
  }

  // Most recent factor wins: amr is append-ordered, and a step-up adds an entry.
  const factors = Array.isArray(claims.amr) ? claims.amr : []
  const latest = factors.reduce<{ method?: string; timestamp?: number } | null>(
    (best, f) => (!best || (f?.timestamp ?? 0) > (best.timestamp ?? 0) ? f : best), null)

  const ts = typeof latest?.timestamp === 'number' ? latest.timestamp : null
  const authenticatedAt = ts === null ? null : new Date(ts * 1000).toISOString()
  const age = ts === null ? null : Math.max(0, Math.floor(now.getTime() / 1000 - ts))

  return {
    assurance: claims.is_anonymous ? 'anonymous' : 'account_session',
    method: typeof latest?.method === 'string' ? latest.method : null,
    aal: typeof claims.aal === 'string' ? claims.aal : null,
    authenticated_at: authenticatedAt,
    seconds_since_authentication: age,
    recent_authentication: age !== null && age <= RECENT_AUTHENTICATION_WINDOW_SECONDS,
    // Never computed from recency. There is no challenge mechanism to satisfy.
    act_bound_authentication: false,
    act_binding_mechanism: null,
  }
}

/** The guest's authority: a capability, with no authentication event behind it. */
export function bearerAssurance(): AuthAssurance {
  return {
    assurance: 'bearer_capability', method: null, aal: null,
    authenticated_at: null, seconds_since_authentication: null,
    recent_authentication: false,
    act_bound_authentication: false, act_binding_mechanism: null,
  }
}

/**
 * What a reader may and may not conclude, carried WITH the assurance rather
 * than left to a footnote in an export.
 *
 * This exists because the strongest finding of the audit was not that the
 * assurance was weak — it is that the record implied more than it held. A
 * machine reader (an agent acting for a counterparty) has no way to consult a
 * document, so the limits travel inside the data.
 */
export function assuranceMeaning(a: AuthAssurance): { proves: string[]; does_not_prove: string[] } {
  const does_not_prove = [
    'the identity of the person who acted',
    'that the work described was actually performed',
    'that any payment actually moved',
    // The distinction the whole module exists to keep straight. Consent given
    // through an authenticated session is evidence; it is not a signature, and
    // recency of login does not narrow the gap.
    'that the actor authenticated IN ORDER TO perform this act — there is no '
      + 'challenge bound to this agreement and action, so a recent login proves '
      + 'recency and not intent',
  ]

  if (a.assurance === 'bearer_capability') {
    return {
      proves: [
        'the actor presented a capability this agreement\'s owner issued',
        'the action was bound to a specific agreement version by agreement_hash',
      ],
      does_not_prove: [
        'that the holder is the invited counterparty — the credential is transferable and the address is self-claimed',
        'any authentication event whatsoever: no credential of the actor\'s own was tested',
        ...does_not_prove,
      ],
    }
  }

  if (a.assurance === 'anonymous') {
    return { proves: [], does_not_prove: ['anything — an anonymous session must not write evidence', ...does_not_prove] }
  }

  const emailBased = a.method === 'otp' || a.method === 'magiclink' || a.method === 'email'
  return {
    proves: [
      `the actor held an authenticated account session (${a.method ?? 'method unrecorded'})`,
      'the action was bound to a specific agreement version by agreement_hash',
      a.recent_authentication
        ? `the session's last authentication was within ${RECENT_AUTHENTICATION_WINDOW_SECONDS} seconds of this record being written`
        : 'the session was authenticated earlier, not close to the time of this record',
    ],
    does_not_prove: [
      ...(emailBased
        ? ['that the mailbox belongs to the named person — NIST SP 800-63B-4 does not accept email as an out-of-band authenticator, so this shows mailbox control at a point in time and not identity']
        : []),
      ...does_not_prove,
    ],
  }
}

/**
 * Should this act require re-authentication before it is accepted?
 *
 * A candidate design, not a policy: the thresholds are deliberately absent,
 * because what counts as high-risk is a business decision and no number here
 * would be grounded in anything. What this function fixes is the SHAPE — that
 * a step-up requirement is a property of (act, assurance), decided server-side,
 * and recorded when it is satisfied.
 */
export function stepUpRequired(
  act: string,
  a: AuthAssurance,
  policy: { actsRequiringFreshAuth?: string[] } = {},
): boolean {
  const acts = policy.actsRequiringFreshAuth ?? []
  if (!acts.includes(act)) return false
  // Satisfied by recency only, which is the weaker of the two things it could
  // mean. A step-up that actually bound the authentication to the act would
  // need the nonce described on act_bound_authentication; until that exists,
  // this gate reduces the window of a stolen session and nothing more, and must
  // not be described to a user as confirming they signed anything.
  return !a.recent_authentication
}
