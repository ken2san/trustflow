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
  HASH_VERSION, eventCanonical, payloadHash, deriveDodHash, sha256Hex,
  buildAgreementSnapshot, deriveAgreementHash,
} from './eventCanonical.ts'
import {
  type AuthAssurance, assuranceForRecord, legacyAuthMethod,
} from './authAssurance.ts'

/** The event that records a counterparty accepting an agreement. */
export const ACCEPTANCE_TYPE = 'dod.consent_recorded'

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
export function acceptanceFacts(contract: Record<string, unknown>) {
  return {
    _agreement: buildAgreementSnapshot(contract),
    _invited_recipient: (contract.invited_hirer_email as string | null) ?? null,
    _claimed_identity: (contract.hirer_email as string | null) ?? null,
    _claimed_identity_verified: false,
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
  idempotencyKey = null,
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
    ...(type === ACCEPTANCE_TYPE ? acceptanceFacts(contract) : {}),
  }

  // The terms this event refers to, derived from the agreement rather than
  // taken from the caller, and the whole deal alongside them — dod_hash alone
  // left price and date unbound.
  const [termsHash, agreementHash, substanceHash] = await Promise.all([
    deriveDodHash(contract.dod),
    deriveAgreementHash(contract),
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
