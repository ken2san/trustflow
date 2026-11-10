// supabase/functions/_shared/eventRecord.ts
//
// How a stored event is assembled — the companion to eventCanonical.ts, which
// defines only what the hash covers.
//
// Two Edge Functions now write events: log-event, for assertions a party makes
// during a transaction, and validate-invite-token, for the acceptance that
// begins one. The acceptance had to move there because acceptance and its
// evidence must commit together, and only that function owns the invitation.
//
// Both go through this module rather than each building a row of their own.
// The single production bug this chain has had came from two implementations of
// the same rule drifting apart, and "what an event records" is exactly such a
// rule: an acceptance written by one path and an assertion written by the other
// must be the same kind of object, or a verifier has to know which produced it.

import {
  HASH_VERSION, SNAPSHOT_VERSION, buildAgreementSnapshot, deriveAgreementHash, deriveDodHash, eventCanonical, isSupportedSnapshotVersion, payloadHash, sha256Hex,
} from './eventCanonical.ts'
import {
  type AuthAssurance, assuranceForRecord, legacyAuthMethod,
} from './authAssurance.ts'

/** The event that records a counterparty accepting an agreement. */
export const ACCEPTANCE_TYPE = 'dod.consent_recorded'

/**
 * The states in which no acceptance event exists yet, so an owner event may be
 * recorded without one.
 *
 * Anything else means the contract HAS been accepted, and a missing acceptance
 * event is then a refusal rather than a default — see `acceptedSnapshotVersion`.
 * Listed as the pre-acceptance set rather than the accepted set on purpose: a
 * new state added later is treated as accepted, which refuses, and refusing a
 * write is recoverable while recording one against a guessed version is not.
 */
export const PRE_ACCEPTANCE_STATES: ReadonlySet<string> = new Set([
  'DRAFTING',
  'AWAITING_ACCEPTANCE',
])

/**
 * Which role a party holds in this particular agreement.
 *
 * `party` is which side of the account/guest divide the caller is on — the
 * account that owns the agreement, or the invited counterparty. `performed_by`
 * says which of those two does the work. The role is the combination.
 *
 * Note on naming: the owning account is still called 'earner' and the
 * counterparty 'guest_hirer', and contracts.earner_user_id still holds the
 * owner. Those names predate performed_by and are misleading when the owner is
 * not the performer. Recorded as debt; renaming them is schema and data surgery.
 */
export function roleInAgreement(
  party: 'earner' | 'guest_hirer',
  performedBy: string | null,
): 'performer' | 'receiver' {
  const performingParty = performedBy === 'counterparty' ? 'guest_hirer' : 'earner'
  return party === performingParty ? 'performer' : 'receiver'
}

/**
 * Drop the server's own namespace from anything a caller sent.
 *
 * Underscore-prefixed keys are facts TrustFlow derived, not ones a party
 * asserted. A caller that sent `_agreement` could not forge the hash — that is
 * derived from the contract row — but it could leave a reader looking at terms
 * nobody agreed to.
 */
function partyAssertedOnly(payload: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries((payload as Record<string, unknown>) ?? {})
      .filter(([key]) => !key.startsWith('_')))
}

/**
 * What an acceptance permanently records, beyond the assertion itself.
 *
 * The snapshot is embedded, not merely hashed. A hash proves that content
 * matches; it cannot reproduce content that has since changed. Storing the deal
 * as it stood lets the historical record SHOW what was accepted without
 * consulting the contract row, which may have moved on.
 *
 * The two email fields are kept apart on purpose. They may legitimately differ —
 * an invitation can be forwarded — and that divergence is itself evidence.
 * Neither is verified, and nothing here says otherwise.
 */
/**
 * What the server observed about the terms-presentation check at an acceptance.
 *
 * `presented: false` is the whole reason this exists. The shown-terms digest is
 * optional for a JPY contract during the compatibility period — a client that
 * sends none is accepted, and the acceptance it produces is today
 * INDISTINGUISHABLE from one whose digest was checked and matched. That is a
 * fact about the act which can never be reconstructed afterwards: once the
 * acceptance is written, nothing anywhere says whether what the accepter saw
 * was ever compared against the terms.
 *
 * So it is recorded as an absence rather than left as one, the same way
 * `_claimed_identity_verified: false` already states a negative rather than
 * omitting the field. A reader of an old record cannot tell the two apart; a
 * reader of a new one can.
 *
 * WHAT IT DOES NOT MEAN. `verified: true` means the digest the client sent
 * equalled the one this server computed over its own copy of the terms. The
 * digest is computed BY THE CLIENT, so this says the client's rendering agreed
 * with the server's terms — not that a human read them, not that a screen
 * displayed them, and not that a hostile client could not have forged the
 * value. It is evidence against drift between the terms and what was shown,
 * which is the only thing it was ever built to be.
 */
export interface ShownTermsCheck {
  /** Did the caller send a digest at all? */
  presented: boolean
  /** Did it equal the digest this server computed? False when none was sent. */
  verified: boolean
  /**
   * The digest format version the caller NAMED, or null if it named none.
   *
   * Not the version the check effectively ran under. A caller that sends a
   * digest and no version is checked as v1 by the fallback in
   * validate-invite-token, and this field still records null — because what is
   * worth preserving is what the caller said, not what this build inferred from
   * its silence. A later build that changes the fallback must not be able to
   * retro-date its own inference onto these records. (Codex's observation on
   * review, 2026-11-08.)
   */
  version: number | null
}

export function acceptanceFacts(
  contract: Record<string, unknown>,
  shownTermsCheck: ShownTermsCheck | null = null,
) {
  return {
    _agreement: buildAgreementSnapshot(contract),
    _invited_recipient: (contract.invited_hirer_email as string | null) ?? null,
    _claimed_identity: (contract.hirer_email as string | null) ?? null,
    _claimed_identity_verified: false,
    // Null only for a caller that has not been taught to report it. Every
    // acceptance path in this repo passes one; the default exists so that a
    // path which forgets records nothing rather than recording a false
    // negative, which would be worse than silence.
    ...(shownTermsCheck ? { _shown_terms_check: { ...shownTermsCheck } } : {}),
  }
}

export interface EventRecord {
  id: string
  type: string
  contract_id: string
  actor_id: string
  dod_hash: string
  created_at: string
  payload: Record<string, unknown>
  payload_hash: string
  agreement_hash: string
  event_hash: string
  prev_event_hash: string
  hash_version: number
  idempotency_key: string | null
}

/**
 * Build the complete row for one event, hashes included.
 *
 * Everything that makes the row evidence is derived here from server-held data:
 * the terms pin, the agreement snapshot and its hash, the role the actor held,
 * and how they were authenticated. The caller supplies only which type of event
 * this is, who is making it, and the substance they are asserting.
 */
export async function buildEventRecord({
  type, contract, actorId, party, assurance, payload, prevEventHash,
  idempotencyKey = null, shownTermsCheck = null, agreementSnapshotVersion,
}: {
  type: string
  contract: Record<string, unknown>
  actorId: string
  party: 'earner' | 'guest_hirer'
  /**
   * How the writer was authenticated, derived by the calling function from the
   * credential it verified. Required, with no default: a default would mean
   * some path could record an assurance nobody established, which is the
   * failure this whole change exists to remove.
   */
  assurance: AuthAssurance
  payload?: unknown
  prevEventHash: string
  idempotencyKey?: string | null
  /**
   * Only read for an acceptance, where it records whether the terms the
   * accepter was shown were checked against the terms the server holds. See
   * ShownTermsCheck. Ignored for every other type, because no other act has a
   * presentation to bind.
   */
  shownTermsCheck?: ShownTermsCheck | null
  /**
   * The snapshot version this agreement was ACCEPTED under, for any act that
   * follows an acceptance. **Required**, with no default.
   *
   * WHY NO DEFAULT. It used to call `deriveAgreementHash(contract)`, which
   * silently meant "whatever version is current". That is correct only while
   * exactly one version has ever existed. The day a v2 builder becomes current,
   * a later assertion on a v1 agreement would derive a v2 hash and so reference
   * terms in a shape nobody accepted — and the acceptance it was meant to
   * follow would still be v1. A default would make that failure silent and
   * dateless; a required parameter makes every caller say which version it
   * means. Codex's finding 2.
   *
   * The acceptance itself passes the current version: it is the act that
   * DEFINES the accepted version. Every later act passes the version it read
   * off the acceptance, and refuses to write if it cannot establish it.
   *
   * NOTE WHAT THIS IS NOT. It does not copy the accepted hash forward. The
   * hash is still derived from the CURRENT contract row, because that is what
   * makes a post-acceptance edit visible: a later act carrying a different
   * agreement_hash is how a reader learns the terms moved. Pinning the hash
   * instead would destroy that, which is a change to what the record means and
   * is written up as a proposed decision rather than made here.
   */
  agreementSnapshotVersion: number
}): Promise<EventRecord> {
  const roleHere = roleInAgreement(party, contract.performed_by as string | null)

  const recordedPayload = {
    ...partyAssertedOnly(payload),
    // Recorded, not accepted: how the writer was authenticated, and which role
    // they held in this agreement at the time.
    _actor_role: party,
    _role_in_agreement: roleHere,
    // How this party obtained the authority to act, read off the credential the
    // calling function verified rather than inferred from the role. See
    // authAssurance.ts for what each value does and does not prove; the limits
    // travel with the data because a machine reader cannot consult a document.
    _auth_method: legacyAuthMethod(assurance),
    _authentication: assuranceForRecord(assurance),
    ...(type === ACCEPTANCE_TYPE ? acceptanceFacts(contract, shownTermsCheck) : {}),
  }

  // A required TypeScript parameter is still `undefined` at run time, and
  // `deriveAgreementHash`'s own default would then quietly build the CURRENT
  // version — which is the exact failure this parameter exists to prevent. So
  // it is checked here, where the record is assembled, rather than trusted to
  // the type.
  if (!isSupportedSnapshotVersion(agreementSnapshotVersion)) {
    throw new Error(
      'buildEventRecord requires agreementSnapshotVersion: the snapshot version '
      + 'this agreement was accepted under. Got '
      + `${String(agreementSnapshotVersion)}.`,
    )
  }

  // The terms this event refers to, derived from the agreement rather than
  // taken from the caller, and the whole deal alongside them — dod_hash alone
  // left price and date unbound.
  const [termsHash, agreementHash, substanceHash] = await Promise.all([
    deriveDodHash(contract.dod),
    // Under the version this agreement was accepted under — see
    // `agreementSnapshotVersion`. `deriveAgreementHash` refuses a version it
    // cannot build, so an unsupported accepted version fails the write rather
    // than producing a hash against a shape this build guessed at.
    deriveAgreementHash(contract, agreementSnapshotVersion),
    payloadHash(recordedPayload),
  ])

  const event = {
    id: crypto.randomUUID(),
    type,
    contract_id: String(contract.id),
    actor_id: actorId,
    dod_hash: termsHash,
    created_at: new Date().toISOString(),
  }

  // One definition of the canonical, shared with the verifiers.
  const eventHash = await sha256Hex(eventCanonical({
    ...event,
    prev_event_hash: prevEventHash,
    payload_hash: substanceHash,
    agreement_hash: agreementHash,
  }, HASH_VERSION))

  return {
    ...event,
    payload: recordedPayload,
    payload_hash: substanceHash,
    agreement_hash: agreementHash,
    event_hash: eventHash,
    prev_event_hash: prevEventHash,
    hash_version: HASH_VERSION,
    idempotency_key: idempotencyKey,
  }
}

/**
 * The snapshot version an agreement was ACCEPTED under, for an act that follows
 * the acceptance.
 *
 * WHY THIS NEEDS A READ. The accepted version lives in the acceptance event's
 * payload, under `_agreement.snapshot_version` — it is not on the contract row,
 * because the row is mutable and the accepted terms are not. So a later act has
 * to go and look. One indexed select per write, on a path that already makes
 * several round trips.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE POINT:
 *
 *   {version}            the acceptance says which version it bound.
 *   {version: current}   there is NO acceptance event AND the caller says none
 *                        is expected. A draft can legitimately carry events
 *                        before anyone accepts it, so nothing is pinned and the
 *                        current version is correct rather than a guess.
 *   {error}              the read failed; or the acceptance records a version
 *                        this build cannot build; or there is no acceptance
 *                        event where one MUST exist. **Refuse the write.** An
 *                        act that cannot establish which terms it refers to
 *                        must not be recorded referring to a guess — the whole
 *                        append-only point is that nobody can fix it later.
 *
 * A read failure is deliberately not treated as "no acceptance": those look
 * identical to a caller that only checks for rows, and one of them means the
 * terms are pinned to something unknown.
 *
 * WHY THE CALLER HAS TO SAY. `mustBeAccepted` has no default, because the two
 * situations are indistinguishable from here and the safe answer differs:
 *
 *   - an owner recording against an untouched draft: no acceptance exists, and
 *     expecting one would refuse a legitimate write;
 *   - a reissue, or any act on a contract whose state says it was accepted:
 *     the acceptance MUST be there, and its absence means the evidence this act
 *     should refer to cannot be found. Defaulting that to the current version
 *     is a guess about the most important thing in the record.
 *
 * The second case was Codex's finding 3 on the Task 28 re-review: the helper
 * returned the current version whenever the row was missing, so a reissue on an
 * accepted contract whose acceptance event could not be found appended against
 * an assumption.
 */
export async function acceptedSnapshotVersion(
  // deno-lint-ignore no-explicit-any
  admin: any,
  contractId: string,
  { mustBeAccepted }: { mustBeAccepted: boolean },
): Promise<{ version: number } | { error: string }> {
  const { data, error } = await admin
    .from('events')
    .select('payload')
    .eq('contract_id', contractId)
    .eq('type', ACCEPTANCE_TYPE)
    .order('created_at', { ascending: true })
    // `id` breaks the tie, and it has to be here because the backfill in
    // 20261109210000 orders by (created_at, id) and the two must agree. They
    // did not: this read ordered by created_at alone, so on two acceptances
    // sharing a timestamp — one valid, one malformed — the migration and the
    // writers could pick different rows, and the cached column would disagree
    // with the refusal the writers were already making. Codex's finding 1 on
    // the Task 30 re-review, and my own comment in that migration had claimed
    // they matched.
    //
    // Ties cannot be CREATED any more: `events_require_monotonic_created_at`
    // (20261108121500) refuses an event whose created_at is not strictly later
    // than the last on the same contract. They can still be READ — rows
    // written before that trigger existed are exactly why it was added — so
    // the order has to be total for historical rows, not merely for the ones
    // today's writers produce.
    //
    // Ascending `id`, matching the migration. `log-event` and
    // `reissue-guest-access` use (created_at desc, id desc) for the chain tip,
    // which is the same rule read from the other end.
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) return { error: 'accepted_version_unreadable' }
  if (!data) {
    return mustBeAccepted
      ? { error: 'accepted_version_missing' }
      : { version: SNAPSHOT_VERSION }
  }

  const recorded = (data.payload as Record<string, unknown> | null)?._agreement as
    Record<string, unknown> | null | undefined
  const version = recorded?.snapshot_version

  // An acceptance with no recorded version is refused on purpose, not by
  // accident. Acceptances written before 60b30b3 ("bind the whole agreed deal
  // to an acceptance") carry no `_agreement` at all: they bound the criteria
  // only, never an agreement snapshot, so there is no version for a later act
  // to refer to. Production held 468 of them on 2026-11-10 (Task 33); E2E,
  // created after that commit, holds none. Guessing 1 for them would claim a binding that
  // never happened, so absent is treated exactly like an unsupported version.
  if (!isSupportedSnapshotVersion(version)) {
    return { error: 'accepted_version_unsupported' }
  }
  return { version: version as number }
}
