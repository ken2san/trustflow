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
//   REPRODUCIBLE HERE — whether each act's event_hash recomputes from the
//     canonical fields given for its supported format, and whether the acts
//     link. Recomputable offline from this file, with no access to TrustFlow.
//     If the verifier disagrees with the server's results below, believe the
//     verifier. A hash that recomputes shows the recorded fields agree with
//     it; it does not show who wrote them, when, or that they were never
//     rewritten.
//   NOT GENERALLY CHECKABLE HERE — payload_hash. Formats v3 and v4 bind a
//     recorded digest field meant to cover the WHOLE stored payload (it may
//     be empty, or not match: a separate check), and this document carries the
//     server's projection of it, which may or may not equal it, so a reader
//     cannot generally establish a match from it. `substance_valid` stays the
//     server's word.
//
// VERSION 2.0: BUILT, NOT COPIED (rank-1 provenance fix, Tasks 124-129)
// 1.0 copied the response's actor, integrity block and verification notes
// verbatim, so it carried `trust_model: "server_attested"`, an actor role and
// label, and notes saying authorship and timing were "unaltered". Every
// structure this file generates is now built from a fixed key list, from a
// response of either version. Recorded VALUES inside allowed keys (canonical
// fields, payload text, the accepted snapshot) are kept exactly as received.

import { CANONICAL_INPUTS, guestVerificationNotesV2 } from '../../supabase/functions/_shared/guestEventView.ts'
import {
  parseGuestEvidence, formatPartition, guestChainStatus, checkSummary,
  RECORDED_ID_CLASSES, EARLIER_DOCUMENTS_NOTICE, STATUS_NOTE,
} from './eventFormat.js'

const DOCUMENT_VERSION = '2.0'

/** The server's per-event check results that the document carries. */
const SERVER_VERIFICATION_KEYS = [
  'hash_valid', 'chain_linked', 'substance_valid', 'canonical_version',
  'canonical_version_supported', 'binds_whole_agreement', 'event_hash', 'prev_event_hash',
]

const ACCEPTANCE_IDENTITY_KEYS = [
  'invited_recipient', 'claimed_identity', 'claimed_identity_verified',
  'authentication', 'authentication_detail',
]

/** A JSON value copied as received, so the document cannot share references. */
const copyJson = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/** Only the listed keys that are actually present; absent stays absent. */
function pick(source, keys) {
  const out = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = copyJson(source[key])
  }
  return out
}

/**
 * The canonical block, restricted to the inputs a hash is taken over. A key
 * the response did not send is NOT filled with null: an absent input and a
 * recorded null are different, and a filled block could recompute to a false
 * mismatch or look complete when it is not. The missing keys are listed.
 */
function canonicalOf(ev) {
  if (!ev.canonical) return { canonical: null, canonical_missing: [...CANONICAL_INPUTS] }
  const canonical = pick(ev.canonical, CANONICAL_INPUTS)
  return {
    canonical,
    canonical_missing: CANONICAL_INPUTS.filter(k => !(k in canonical)),
  }
}

/**
 * Who an act is recorded as being by. The raw actor id is kept because the
 * hash covers it. Nothing here names a person or a role: a v1 response's
 * `role` could come from a client-written payload field, so it is never read,
 * and only a v2 response's id class is carried.
 */
function actorOf(ev, version) {
  const actor = ev.actor && typeof ev.actor === 'object' ? ev.actor : {}
  const recordedClass = version >= 2 && RECORDED_ID_CLASSES.includes(actor.recorded_id_class)
    ? actor.recorded_id_class
    : null
  return {
    id: typeof actor.id === 'string' ? actor.id : null,
    attribution: 'as_recorded_not_verified',
    recorded_id_class: recordedClass,
  }
}

/**
 * Build the counterparty's record document from a guest-contract-events
 * response. Pure, so it is testable without a DOM or a network.
 *
 * @param {object} evidence - the response body from guest-contract-events
 * @returns {object} the document, ready to serialize
 * @throws {Error} when there is nothing to record or the response is malformed
 */
export function buildGuestRecordDocument(evidence) {
  const contract = evidence?.contract ?? null

  // A record with nothing in it still looks like a signed record. The owner's
  // export refuses in the same situation and for the same reason.
  if (!contract?.id) throw new Error('no agreement in this evidence response')
  if (!Array.isArray(evidence.events) || evidence.events.length === 0) {
    throw new Error('no readable events for this agreement')
  }
  // A response this build does not understand is refused whole. Leaving a
  // malformed row out of the counts could turn its mismatch into a clean status.
  const parsed = parseGuestEvidence(evidence)
  if (!parsed.ok) throw new Error(`unsupported or invalid response (${parsed.reason})`)

  const { events, chain } = evidence
  const partition = formatPartition(events)
  const changed = evidence.terms_changed_since_acceptance
  const identity = evidence.acceptance_identity

  return {
    trustflow_counterparty_record: {
      version:       DOCUMENT_VERSION,
      // Named so it can never be mistaken for the owner's re-verifiable export.
      document_type: 'server_verified_record',
      generated_at:  new Date().toISOString(),
      agreement_id:  contract.id,
      response_version: parsed.version,

      // Stated up front, because a reader who assumes the wrong kind of
      // document draws the wrong conclusion from it.
      what_this_document_is: [
        'A copy of the record TrustFlow holds for this agreement, as released to the counterparty.',
        'Where an act below carries a complete `canonical` block, it holds the inputs its event_hash is computed over, as recorded, and a reader can recompute the hash of a supported format and follow the chain offline, with no access to TrustFlow and no need to trust the results in this file. An act whose block is null, or whose `canonical_missing` lists inputs that were not sent, cannot be recomputed from this file.',
        'A hash that recomputes shows the recorded fields agree with it. It does not show who wrote an act, when it was actually written, or that the record was never rewritten.',
        'The payload digest cannot generally be checked from this file. Formats v3 and v4 bind the recorded payload-digest field, which is intended to represent the whole stored payload but may be empty; whether it matches the stored payload is a separate check, reported as `substance_valid` below. Formats v1 and v2 do not bind the payload at all. The detail here is a copy of the projection the server returned for this party, not filtered again here, and it may or may not equal the stored payload, so a reader cannot generally establish from it whether the digest matches. `substance_valid` below is the server\'s word for that check, not a result a reader can repeat.',
        'The check results below were computed by the TrustFlow server against the complete stored rows. Where a reader can repeat a check and disagrees, the reader is right.',
        'TrustFlow keeps what was recorded as stated in each act. It does not establish who made a statement, that it is true, who the parties are, or that any work or payment happened.',
      ],
      about_earlier_versions: EARLIER_DOCUMENTS_NOTICE,

      verification: {
        performed_by: 'TrustFlow server (guest-contract-events)',
        // The server's own boolean, carried through untouched. It covers rows
        // in format v2 or later only; the status and the per-event results
        // cover every row.
        server_verdict: chain.verified,
        status:         guestChainStatus(events, chain),
        status_note:    STATUS_NOTE,
        // Every row's results, independent of the status's precedence: a
        // mismatch in an older-format row is here even when the status
        // reports NO_EVENTS_FORMAT_V2_OR_LATER or VERIFIED.
        check_summary:  checkSummary(events),
        event_count:    events.length,
        events_format_v2_or_later:  partition.v2OrLater,
        events_format_below_v2:     partition.belowV2,
        events_format_not_recognised: partition.notRecognised,
        // Whether the detail fields are covered by the hashes at all, rather
        // than merely recorded next to fields that are.
        payload_covered_by_hash: typeof chain.payload_covered_by_hash === 'boolean'
          ? chain.payload_covered_by_hash
          : null,
        // Also true at exactly the server's cap, so later events may or may
        // not exist. Surfaced here rather than buried.
        truncated: chain.truncated,
        truncation_note: chain.truncated
          ? 'The response reached the most events the server returns. Additional events may exist and were not checked here.'
          : null,
      },

      // What was ACCEPTED, taken from the acceptance event rather than from the
      // agreement row, which may legitimately have moved on since. Kept whole,
      // as received: the snapshot is hashed as one object, so dropping a key or
      // an unknown version would change what it is. Null here can mean either
      // that the record has no snapshot or that the response did not include
      // the field; the note says which, rather than collapsing the two.
      accepted_agreement: evidence.accepted_agreement === undefined
        ? null
        : copyJson(evidence.accepted_agreement),
      accepted_agreement_note: !('accepted_agreement' in evidence)
        ? 'The response did not include an accepted snapshot field. Nothing was reconstructed.'
        : evidence.accepted_agreement === null
          ? 'The record has no accepted snapshot (an agreement accepted before snapshots existed). Nothing was reconstructed.'
          : 'Copied as the server returned it. This file does not check it against any hash.',

      // Terms on which the current row and the accepted snapshot disagree.
      // Empty when they still match; null when there is no snapshot to compare
      // against or its version is unknown. A non-empty list is not proof of
      // wrongdoing, but it is the thing a reader most needs to see.
      terms_changed_since_acceptance: Array.isArray(changed) && changed.every(k => typeof k === 'string')
        ? [...changed]
        : null,

      // Who accepted, with what authority, and what they claimed. The invited
      // address and the claimed address are kept apart: an invitation can be
      // forwarded, and the divergence is itself evidence. None of it is
      // verified, and the authentication fields are copied from the
      // acceptance's recorded payload, which a client could write before the
      // 2026-09-24 lockdown.
      acceptance_identity: identity && typeof identity === 'object'
        ? {
            ...pick(identity, ACCEPTANCE_IDENTITY_KEYS),
            authentication_fields_are: 'as recorded in the acceptance; not independently verified',
          }
        : null,

      // How to check the reproducible half, and what no amount of checking in
      // this file will establish. Built here, never copied from the response:
      // a version 1 response carries notes that claim more than a hash shows.
      independent_verification: guestVerificationNotesV2(),

      // The agreement as it stands NOW. May differ from accepted_agreement.
      current_terms: {
        project_name:        contract.project_name ?? null,
        dod:                 contract.dod ?? null,
        // Both names. amount_minor is the column; amount_jpy is kept so an
        // export opened beside one taken before 2026-11-08 has the same key in
        // it, and is null on a contract that is not in yen.
        amount_minor:        contract.amount_minor ?? contract.amount_jpy ?? null,
        amount_jpy:          contract.amount_jpy ?? null,
        currency:            contract.currency ?? null,
        deadline:            contract.deadline ?? null,
        state:               contract.state ?? null,
        performed_by:        contract.performed_by ?? null,
        offered_by:          contract.earner_display_name ?? null,
        counterparty:        contract.hirer_email ?? null,
      },

      events: events.map(ev => ({
        id:         ev.id ?? null,
        type:       ev.type ?? null,
        created_at: ev.created_at ?? null,
        actor:      actorOf(ev, parsed.version),
        // No event carries per-event evidence of who wrote it.
        provenance: { writer: 'unknown', basis: 'none_recorded' },
        // A copy of the projection the server already returned for this party
        // (the server is the disclosure boundary; nothing is filtered again
        // here) — which is exactly why the payload digest cannot be recomputed
        // from it. Values as received.
        payload:    ev.payload === undefined ? null : copyJson(ev.payload),
        dod_hash:   ev.dod_hash ?? null,
        ...canonicalOf(ev),
        server_verification: pick(ev.integrity, SERVER_VERIFICATION_KEYS),
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
