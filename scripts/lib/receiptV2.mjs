// Receipt format v2 (docs/v5-receipt-format.md), built from already-read rows.
// Pure: no network. make-receipt.mjs calls it after a paged read; tests call it
// to prove that what is written is what verify-receipt.mjs accepts.

import {
  buildAgreementSnapshot, deriveAgreementHash,
} from '../../supabase/functions/_shared/eventCanonical.ts';
import { classifyStoredEvent } from '../../supabase/functions/_shared/eventVerifyV5.ts';
import {
  CANONICAL_INPUTS_V5, acceptedAgreementHashOf,
} from '../../supabase/functions/_shared/guestEventView.ts';
import { assuranceMeaning, bearerAssurance } from '../../supabase/functions/_shared/authAssurance.ts';

export const RECEIPT_VERSION = 2;

/** The legacy (v1–v4) canonical block: exactly receipt v1's ten fields. */
function legacyBlock(r) {
  return {
    id:              r.id,
    type:            r.type,
    contract_id:     r.contract_id,
    actor_id:        r.actor_id,
    dod_hash:        r.dod_hash ?? null,
    created_at:      r.created_at,
    prev_event_hash: r.prev_event_hash ?? null,
    payload_hash:    r.payload_hash ?? null,
    agreement_hash:  r.agreement_hash ?? null,
    hash_version:    r.hash_version ?? null,
  };
}

/** v5 (or v5-shaped invalid) rows: an exact own-key projection, nothing synthesized. */
function strictBlock(r) {
  const block = {};
  for (const key of CANONICAL_INPUTS_V5) {
    if (Object.prototype.hasOwnProperty.call(r, key) && r[key] !== undefined) block[key] = r[key];
  }
  return block;
}

export async function buildReceiptV2({ contract, rows, read, source, issuedAt = new Date().toISOString() }) {
  const accepted = await acceptedAgreementHashOf(rows);
  const acceptance = accepted.status === 'ok' ? rows[accepted.acceptance_index] : null;
  const acceptedSnapshot = acceptance?.payload?._agreement ?? null;

  const acts = rows.map((r, i) => {
    const kind = classifyStoredEvent(r).kind;
    return {
      sequence: i,
      canonical: kind === 'v5' || kind === 'invalid' ? strictBlock(r) : legacyBlock(r),
      event_hash: r.event_hash ?? null,
      recorded_at: r.created_at,
      actor_role: r.payload?._actor_role ?? null,
      role_in_agreement: r.payload?._role_in_agreement ?? null,
      authentication_as_recorded: r.payload?._auth_method ?? null,
      authentication: r.payload?._authentication ?? null,
      claimed_identity_verified: r.payload?._claimed_identity_verified ?? null,
      idempotency_key: r.idempotency_key ?? null,
      timestamp_token_present: Boolean(r.tsa_token),
    };
  });

  return {
    receipt_version: RECEIPT_VERSION,
    issued_at: issuedAt,
    source,
    // What the issuer can prove about its read. A capped read says so.
    read,
    agreement: {
      contract_id: contract.id,
      // The terms as accepted, from the acceptance event's own validated
      // snapshot. null on a draft or when the snapshot does not validate.
      accepted: accepted.status === 'ok'
        ? {
            snapshot: acceptedSnapshot,
            snapshot_version: acceptedSnapshot.snapshot_version,
            agreement_hash: accepted.hash,
            acceptance_event_id: acceptance.id,
          }
        : null,
      accepted_status: accepted.status,
      // Today's terms, for drift comparison only. Never the historical record.
      current: {
        snapshot: buildAgreementSnapshot(contract),
        agreement_hash: await deriveAgreementHash(contract),
      },
      state: contract.state,
    },
    acts,
    how_to_verify: {
      command: 'node scripts/verify-receipt.mjs <this-file>',
      requires: 'Node 22.18 or newer. On Node 22.6-22.17 or 23.x, add '
        + '--experimental-strip-types. Older runtimes cannot load the canonical '
        + 'definition at all.',
      offline: true,
      recomputes: ['event_hash per act (v1–v4 and strict v5)', 'chain linkage from a known start',
        'the accepted agreement digest from its snapshot', 'the current terms digest'],
      canonical_definition: [
        'supabase/functions/_shared/eventCanonical.ts',
        'supabase/functions/_shared/eventCanonicalV5.ts',
        'supabase/functions/_shared/eventVerifyV5.ts',
      ],
      note: 'The verifier needs no network and no access to TrustFlow. If it '
        + 'disagrees with this file, believe the verifier.',
    },
    not_verifiable_here: [
      'That the text of any statement matches what was committed to. The event hash '
      + '(v3 and later) commits to one payload_hash over the whole payload, and no '
      + 'payload is carried here, so payload checks are unavailable from this file.',
      'Who operated an account or acted under a grant. In a v5 act, credential_id and '
      + 'issuer_kind are recorded inputs to the hash, not proof of who acted.',
      'The identity of any party. The counterparty holds a transferable bearer '
      + 'capability and their address is self-claimed and recorded unverified.',
      'How any account holder authenticated, beyond what the record states.',
      'That the work described was performed, or that any payment moved. TrustFlow '
      + 'records that a party said so.',
      'That TrustFlow showed both parties the same history. Only comparing this file '
      + 'with the other party\'s receipt can show that.',
      'That anyone authenticated in order to perform an act. Consent given through '
      + 'an authenticated session is not a signature.',
    ],
    counterparty_authority: assuranceMeaning(bearerAssurance('guest_access_token')),
  };
}
