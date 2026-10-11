// src/lib/guestRecordExport.js
// The counterparty's copy of the record — a server-verified document.
//
// This is NOT the same artefact as auditExport.js produces, and the difference
// is the whole reason this file exists.
//
// The owning account can read the raw `events` rows, so its export carries
// every payload. A guest has no auth.users row: RLS returns them nothing from
// `events`, and their trail arrives from guest-contract-events already
// allowlist-filtered, with each payload reduced to the fields that party may
// see.
//
// WHAT CHANGED, AND WHY THE SPLIT MATTERS
// This file used to say the reader could reproduce nothing, which was true of
// the response it was built from: three of the nine canonical inputs were never
// sent, so the guest had the digests and not the material, and all they could
// do was believe the server. The response now carries a `canonical` block per
// act, so HALF of that is no longer true, and leaving the blanket disclaimer in
// place would understate the record exactly as badly as the old
// `integrity_status: VERIFIED` overstated it.
//
// The honest statement is a split, and this document makes it:
//
//   REPRODUCIBLE HERE — each act's event_hash, the chain linking the acts, and
//     the agreement_hash every act is bound to. Recomputable offline from this
//     file, with no access to TrustFlow. If the verifier disagrees with the
//     server's verdicts below, believe the verifier.
//   NOT REPRODUCIBLE HERE — payload_hash. Canonical v4 takes one digest over
//     the WHOLE payload and this document carries an allowlisted projection of
//     it, so recomputing it would fail on an untouched record as readily as on
//     a tampered one. `substance_valid` stays the server's word.
//
// The server's verdicts are still carried verbatim, and still labelled as the
// server's. What this module adds is that the reader can now check the first
// half for themselves rather than take all of it on trust.

const DOCUMENT_VERSION = '1.0'

/**
 * Why the chain carries the verdict it does.
 *
 * The server's own boolean stays authoritative and is reported verbatim; this
 * only names the reason, from the same per-event verdicts the server returned.
 * A record with nothing server-attested in it is not "unverified" — there was
 * never an attestation to check, which is a different statement.
 */
function chainStatusOf(events, chain) {
  if (!chain?.server_attested) return 'NOT_SERVER_ATTESTED'
  const verdicts = events.map(ev => ev.integrity ?? {})
  if (verdicts.some(v => v.hash_valid === false)) return 'HASH_MISMATCH_DETECTED'
  if (verdicts.some(v => v.substance_valid === false)) return 'PAYLOAD_MISMATCH_DETECTED'
  if (verdicts.some(v => v.chain_linked === false)) return 'CHAIN_LINK_BROKEN'
  return chain.verified ? 'VERIFIED' : 'NOT_VERIFIED'
}

/**
 * Build the counterparty's record document from a guest-contract-events
 * response. Pure, so it is testable without a DOM or a network.
 *
 * @param {object} evidence - the response body from guest-contract-events
 * @returns {object} the document, ready to serialize
 * @throws {Error} when there is nothing to record
 */
export function buildGuestRecordDocument(evidence) {
  const events = evidence?.events ?? []
  const contract = evidence?.contract ?? null

  // A record with nothing in it still looks like a signed record. The owner's
  // export refuses in the same situation and for the same reason.
  if (!contract?.id) throw new Error('no agreement in this evidence response')
  if (events.length === 0) throw new Error('no readable events for this agreement')

  const chain = evidence.chain ?? {}
  const status = chainStatusOf(events, chain)

  return {
    trustflow_counterparty_record: {
      version:       DOCUMENT_VERSION,
      // Named so it can never be mistaken for the owner's re-verifiable export.
      document_type: 'server_verified_record',
      generated_at:  new Date().toISOString(),
      agreement_id:  contract.id,

      // Stated up front, because a reader who assumes the wrong kind of
      // document draws the wrong conclusion from it.
      what_this_document_is: [
        'A copy of the record TrustFlow holds for this agreement, as released to the counterparty.',
        'Each act below carries a `canonical` block: every input its event_hash is computed over. From those alone a reader can recompute each hash and follow the chain offline, with no access to TrustFlow and no need to trust the verdicts in this file.',
        'The payload digest CANNOT be reproduced from this file. One digest covers each whole payload, and the detail shown here is filtered to what this party may see, so recomputing it would not match on an untampered record any more than on a tampered one. `substance_valid` below is the server\'s word for that check, not a result a reader can repeat.',
        'The integrity verdicts below were computed by the TrustFlow server against the complete stored rows. Where a reader can repeat a check and disagrees, the reader is right.',
        'TrustFlow records what each party stated. It does not establish that a statement is true, who the parties are, or that any work or payment happened.',
      ],

      verification: {
        performed_by: 'TrustFlow server (guest-contract-events)',
        // The server's own verdict, carried through untouched.
        server_verdict: chain.verified ?? null,
        status,
        event_count:      chain.event_count ?? events.length,
        server_attested:  chain.server_attested ?? null,
        // Rows from before the server assigned actor, timestamp and hash. One
        // that verifies proves only that it has not changed since it was
        // stored, not that it says anything true.
        client_asserted:  chain.client_asserted ?? null,
        // Whether the detail fields are covered by the hashes at all, rather
        // than merely recorded next to fields that are.
        payload_covered_by_hash: chain.payload_covered_by_hash ?? null,
        // If the record was cut short, the absence of an event below means
        // nothing. Surfaced here rather than buried.
        truncated: chain.truncated ?? false,
      },

      // What was AGREED, taken from the acceptance event rather than from the
      // agreement row, which may legitimately have moved on since. Null for
      // agreements accepted before the snapshot existed — absent, not
      // reconstructed.
      accepted_agreement: evidence.accepted_agreement ?? null,

      // Terms on which the current row and the accepted snapshot disagree.
      // Empty when they still match; null when there is no snapshot to compare
      // against. A non-empty list is not proof of wrongdoing, but it is the
      // thing a reader most needs to see.
      terms_changed_since_acceptance: evidence.terms_changed_since_acceptance ?? null,

      // Who accepted, with what authority, and what they claimed. The invited
      // address and the claimed address are kept apart: an invitation can be
      // forwarded, and the divergence is itself evidence. Neither is verified.
      acceptance_identity: evidence.acceptance_identity ?? null,

      // How to check the reproducible half, and what no amount of checking in
      // this file will establish. Carried from the server response so the two
      // documents cannot drift into saying different things; defaulted here so
      // an older response still produces a document that states its limits.
      independent_verification: evidence.verification ?? {
        canonical_definition: 'supabase/functions/_shared/eventCanonical.ts',
        recompute: 'sha256 over the canonical string built from each act\'s '
          + '`canonical` block, under that block\'s own hash_version',
        not_verifiable_here: [
          'This response predates the canonical blocks, so nothing in it can be recomputed.',
        ],
      },

      // The agreement as it stands NOW. May differ from accepted_agreement.
      current_terms: {
        project_name:        contract.project_name ?? null,
        dod:                 contract.dod ?? null,
        amount_jpy:          contract.amount_jpy ?? null,
        currency:            contract.currency ?? null,
        deadline:            contract.deadline ?? null,
        state:               contract.state ?? null,
        performed_by:        contract.performed_by ?? null,
        offered_by:          contract.earner_display_name ?? null,
        counterparty:        contract.hirer_email ?? null,
      },

      events: events.map(ev => ({
        id:         ev.id,
        type:       ev.type,
        created_at: ev.created_at,
        actor:      ev.actor ?? null,
        // Filtered to what this party may see — which is exactly why the
        // hashes below cannot be recomputed from it.
        payload:    ev.payload ?? null,
        dod_hash:   ev.dod_hash ?? null,
        // Every input this act's event_hash is taken over. Null on a response
        // from before the server sent them, which is itself worth seeing: it
        // says this act cannot be checked from this file.
        canonical:  ev.canonical ?? null,
        server_verification: ev.integrity ?? null,
      })),
    },
  }
}

/**
 * Build the document and hand it to the browser as a download.
 *
 * @param {object} evidence - the response body from guest-contract-events
 */
export async function downloadGuestRecord(evidence) {
  const doc = buildGuestRecordDocument(evidence)
  const agreementId = doc.trustflow_counterparty_record.agreement_id

  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = `trustflow-record-${agreementId}-${Date.now()}.json`
  window.document.body.appendChild(a)
  a.click()
  window.document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
