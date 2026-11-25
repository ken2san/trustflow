// supabase/functions/_shared/receiptV2.ts
//
// Receipt format v2 (docs/v5-receipt-format.md), built from already-read rows.
// Pure: no network. Shared by the owner-session CLI (scripts/make-receipt.mjs,
// through scripts/lib/receiptV2.mjs) and the delegated owner read route (row
// 5b), so both write exactly what scripts/verify-receipt.mjs judges.
//
// Two read shapes reach it. A CLI row carries the stored `tsa_token`; an owner
// read row (read_delegated_owner_deal) carries only `timestamp_token_present`
// and lists in `withheld` what its projection left out. A canonical input the
// read withheld is absent from the act's block and named in
// `canonical_withheld`; nothing stands in for it.

import { buildAgreementSnapshot, deriveAgreementHash } from './eventCanonical.ts'
import { classifyStoredEvent } from './eventVerifyV5.ts'
import { CANONICAL_INPUTS_V5, acceptedAgreementHashOf } from './guestEventView.ts'
import { assuranceMeaning, bearerAssurance } from './authAssurance.ts'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

export const RECEIPT_VERSION = 2;

/** The legacy (v1–v4) canonical block: exactly receipt v1's ten fields. */
function legacyBlock(r: Row): Row {
  const block: Row = {
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
  // A withheld input is absent, not an own key holding undefined.
  for (const k of withheldCanonical(r)) if (block[k] === undefined) delete block[k];
  return block;
}

/** v5 (or v5-shaped invalid) rows: an exact own-key projection, nothing synthesized. */
function strictBlock(r: Row): Row {
  const block: Row = {};
  for (const key of CANONICAL_INPUTS_V5) {
    if (Object.prototype.hasOwnProperty.call(r, key) && r[key] !== undefined) block[key] = r[key];
  }
  return block;
}

// Stated only on a receipt with an act that declares a withheld input.
export const WITHHELD_LIMIT = 'The event hash of any act listing canonical_withheld. Its read withheld that '
  + 'canonical input by design (a legacy counterparty actor is recorded as their contact '
  + 'address), so its hash cannot be recomputed and is reported unavailable, never as a '
  + 'match. The accepted snapshot can still match the agreement digest the acceptance act '
  + 'recorded while that act\'s own event hash remains unavailable; links to and from it '
  + 'are checked through its stored event_hash.'

/** Canonical inputs this row's read withheld (owner read `withheld`), in key order. */
function withheldCanonical(r: Row): string[] {
  const withheld = Array.isArray(r.withheld) ? r.withheld : []
  return CANONICAL_INPUTS_V5.filter(k => withheld.includes(k))
}

export async function buildReceiptV2({
  contract, rows, read, source, issuedAt = new Date().toISOString(), accepted: acceptedOverride,
  carriesIdempotencyKey = true,
}: {
  contract: Row, rows: Row[], read: Row, source: unknown, issuedAt?: string,
  /**
   * false when the read never carries idempotency keys (the delegated owner
   * read): the acts then omit the field, so an uncarried key is not mistaken
   * for a stored null. The CLI keeps the field.
   */
  carriesIdempotencyKey?: boolean,
  /** Set by a reader that knows more than its rows (the owner read's anchor and count): no accepted terms, this status. */
  accepted?: { status: string },
}) {
  const accepted = acceptedOverride
    ? { hash: null, status: acceptedOverride.status, acceptance_index: null }
    : await acceptedAgreementHashOf(rows);
  const acceptance = accepted.status === 'ok' ? rows[accepted.acceptance_index as number] : null;
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
      ...(carriesIdempotencyKey ? { idempotency_key: r.idempotency_key ?? null } : {}),
      timestamp_token_present: typeof r.timestamp_token_present === 'boolean'
        ? r.timestamp_token_present : Boolean(r.tsa_token),
      ...(withheldCanonical(r).length ? { canonical_withheld: withheldCanonical(r) } : {}),
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
            snapshot_version: (acceptedSnapshot as Row).snapshot_version,
            agreement_hash: accepted.hash,
            acceptance_event_id: (acceptance as Row).id,
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
      ...(acts.some(a => 'canonical_withheld' in a) ? [WITHHELD_LIMIT] : []),
    ],
    counterparty_authority: assuranceMeaning(bearerAssurance('guest_access_token')),
  };
}
