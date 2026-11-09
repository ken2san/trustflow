// src/lib/auditExport.js
// Signed audit trail export — produce a self-contained JSON document
// that proves a contract's immutable event history.
//
// The exported document contains:
//   - Contract metadata + DoD hash
//   - Full event chain with per-event SHA-256 hashes and RFC 3161 TSA tokens
//   - A chain integrity report: each event's hash is re-verified AND its
//     prev_event_hash is checked against its chronological predecessor's
//     actual hash. The prev_hash link (not just each event's own hash) is
//     what lets a deleted, reordered, or forged-and-inserted event be
//     detected — a lone self-consistent hash on an isolated row proves
//     nothing about whether the row belongs where it claims to be in the
//     sequence. See eventLog.js's logEvent() for how the chain is built.
//   - Export metadata (generated_at, generator version)
//
// Anyone can verify by re-computing the hashes (including each event's
// prev_hash) and comparing against on-chain anchors or TSA tokens without
// access to TrustFlow servers.

import {
  GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
  isSupportedHashVersion, payloadHash, sha256Hex,
} from '../../supabase/functions/_shared/eventCanonical.ts'

const EXPORT_VERSION = '1.1'

/**
 * Build and download a signed JSON audit trail for a contract.
 *
 * @param {object} params
 * @param {string}   params.contractId   - contract identifier
 * @param {string}   params.dodHash      - SHA-256 of the original DoD
 * @param {object[]} params.events       - array of event objects from eventLog
 * @param {object}   [params.meta]       - optional extra metadata (title, parties, etc.)
 */
export async function buildAuditDocument({ contractId, dodHash, events, meta = {} }) {
  // Chain verification depends on chronological order — the events array as
  // received isn't guaranteed to be in that order (fetchContractEvents
  // returns newest-first; realtime-appended events may be mixed in).
  //
  // id breaks the tie, matching the ordering the writers build the chain with
  // (log-event and accept_invitation both take the tip by `created_at desc, id
  // desc`). created_at has millisecond resolution, so two events can share one;
  // sorting on it alone leaves their relative order to the sort's input, and
  // replaying them the other way round reports chain_link_match false on an
  // untouched chain. The ids are compared by code unit rather than with
  // localeCompare, whose result depends on the runtime's locale: every id is a
  // lowercase canonical UUID, so the dashes sit at identical positions and the
  // hex digits compare in the same order as the bytes the database sorts on.
  const chronological = [...events].sort((a, b) => {
    const byTime = new Date(a.created_at) - new Date(b.created_at)
    if (byTime) return byTime
    const [x, y] = [String(a.id), String(b.id)]
    return x < y ? -1 : x > y ? 1 : 0
  })

  // Re-verify each event's own hash AND its link to its chronological
  // predecessor at export time.
  //
  // Three canonical formats exist and a row must be verified under the one it
  // was written with: v1 hashed the event's own fields, v2 added prev_hash, v3
  // added payload_hash. Verifying a row under the wrong one reports an
  // untampered event as altered — which is exactly what this function used to
  // do to every historical row. The canonical itself is defined once, in
  // _shared/eventCanonical.ts, and shared with the server that writes it.
  let prevHash = GENESIS_HASH
  const verifiedEvents = []
  for (const ev of chronological) {
    const hashVersion = canonicalVersionOf(ev)
    // A version this build cannot produce is reported as unsupported, not
    // hashed under a guess. eventCanonical throws rather than falling through
    // to the newest shape, so an export must ask first — otherwise one row
    // from a future build would make the whole export fail, and a guessed
    // digest would read as a verification.
    const versionSupported = isSupportedHashVersion(hashVersion)
    const recomputedHash = versionSupported
      ? await sha256Hex(eventCanonical(ev, hashVersion))
      : null

    // From v3 the payload is bound into the hash. null for older rows — their
    // substance was never attested, which is not the same as failing a check.
    const substanceMatch = hashVersion >= 3 && ev.payload_hash
      ? (await payloadHash(ev.payload ?? {})) === ev.payload_hash
      : null
    const hashMatch = ev.event_hash && recomputedHash !== null
      ? ev.event_hash === recomputedHash
      : null  // hash not yet stored (pre-chain events), or a version this
              // build cannot verify. Either way: cannot say, not "altered".
    const chainLinkMatch = ev.prev_event_hash
      ? ev.prev_event_hash === prevHash
      : null  // pre-chain event — no prev_event_hash was ever recorded for it

    verifiedEvents.push({
      ...ev,
      _export_verification: {
        canonical_version: hashVersion,
        canonical_version_supported: versionSupported,
        substance_match:   substanceMatch,
        binds_whole_agreement: bindsWholeAgreement(hashVersion),
        recomputed_hash:   recomputedHash,
        stored_hash:       ev.event_hash ?? null,
        hash_match:        hashMatch,
        expected_prev_hash: prevHash,
        chain_link_match:  chainLinkMatch,
        tsa_token_present: Boolean(ev.tsa_token),
        // v1 rows were written by the browser under the previous trust model:
        // the client chose actor_id, type and the hash. They are preserved as
        // history, but they are not server-attested evidence. v2 rows were
        // written by the log-event Edge Function, which derives all of those.
        trust_model:       hashVersion >= 2 ? 'server_attested' : 'client_asserted',
        // What the attestation covers. From v3 the payload is bound in too, so
        // the substance of an assertion is tamper-evident and not merely
        // recorded alongside one that is.
        substance_attested: hashVersion >= 3,
      },
    })

    // Advance the expected tip regardless of match — a break should surface
    // as a mismatch on the NEXT event too if the gap wasn't the last one,
    // not silently reset the chain.
    prevHash = ev.event_hash ?? prevHash
  }

  const allHashesMatch = verifiedEvents.every(
    ev => ev._export_verification.hash_match !== false
      && ev._export_verification.substance_match !== false
  )
  const chainIntact = verifiedEvents.every(
    ev => ev._export_verification.chain_link_match !== false
  )

  // Extract consent record from events — surfaces prominently for legal review
  const consentEvent = verifiedEvents.find(ev => ev.type === 'dod.consent_recorded')
  const counterpartyConsent = consentEvent
    ? {
        counterparty_name:  consentEvent.payload?.counterparty_name ?? null,
        counterparty_email: consentEvent.payload?.counterparty_email ?? consentEvent.actor_id,
        dod_items_agreed:   consentEvent.payload?.dod_items ?? [],
        consented_at:       consentEvent.created_at,
        event_id:           consentEvent.id,
        // A TSA token being present is NOT the same as it having been
        // cryptographically verified — nothing in this codebase validates a
        // TSA token's RFC 3161 signature. Named honestly; see instruction 3
        // below for what a reader still has to do themselves.
        tsa_token_present:  Boolean(consentEvent.tsa_token),
      }
    : null

  const auditDoc = {
    trustflow_audit_trail: {
      version:              EXPORT_VERSION,
      generated_at:         new Date().toISOString(),
      contract_id:          contractId,
      dod_hash:             dodHash ?? null,
      // VERIFIED means: every event's own hash matches its recomputation,
      // AND every event's prev_event_hash matches its chronological
      // predecessor's actual hash. The second check is what catches
      // deletion/reordering/insertion — a lone tampered or removed row
      // breaks the link to its neighbor even if its own hash is internally
      // consistent. It does NOT mean any TSA token was cryptographically
      // verified (see tsa_token_present) and it does NOT mean writes are
      // guaranteed atomic against concurrent inserts (see eventLog.js).
      integrity_status:
        allHashesMatch && chainIntact ? 'VERIFIED'
        : !allHashesMatch ? 'HASH_MISMATCH_DETECTED'
        : 'CHAIN_LINK_BROKEN',
      counterparty_consent: counterpartyConsent,
      meta,
      events:               verifiedEvents,
      verification_instructions: [
        '1. Sort events by created_at ascending.',
        '2. Normalise created_at to the form it was hashed in: an ISO-8601 instant in UTC with milliseconds and a trailing Z (2026-09-24T12:52:40.016Z). A timestamp rendered any other way — for example with a +00:00 offset — produces a different digest even though it is the same instant.',
        '3. For each event, recompute SHA-256 over a JSON object with keys in this exact order. For events where _export_verification.canonical_version is 2: {id, type, contract_id, actor_id, dod_hash, created_at, prev_hash}, where prev_hash is that event\'s own prev_event_hash field (or the literal string "GENESIS" for the first event). For canonical_version 1 — events written before the chain existed — omit prev_hash entirely; those rows were hashed without it, and including it will produce a mismatch on an untampered row. Compare with event.event_hash; any mismatch indicates that event was altered.',
        '4. Separately, confirm each event\'s prev_event_hash equals the PRECEDING event\'s event_hash. A break here — even if every individual event\'s own hash still matches itself — indicates an event was deleted, reordered, or a forged event was inserted.',
        '5. For canonical_version 4 and above, agreement_hash is the SHA-256 of the deterministically serialized agreement snapshot — project name, completion criteria, amount, currency, deadline, which side performs, and the offering party — and is covered by the event hash. Versions 1 to 3 bound only the completion criteria via dod_hash, so amount and deadline were NOT tamper-evident on those events. _export_verification.binds_whole_agreement says which applies.',
        '6. For canonical_version 3 and above, payload_hash is the SHA-256 of the event payload serialized deterministically — object keys sorted recursively, arrays left in order, no whitespace — and is itself covered by the event hash, so the detail fields are tamper-evident. For versions 1 and 2 the hash does NOT cover payload: those detail fields were recorded but never attested, and _export_verification.substance_attested says which applies.',
        '7. _export_verification.trust_model distinguishes server_attested events, whose actor, timestamp and hash were assigned by the server, from client_asserted ones, written under an earlier model where the browser chose all three. A client_asserted event that verifies proves only that it has not changed since it was stored, not that it says anything true.',
        '8. tsa_token_present only means a token was returned at logging time — it has not been cryptographically verified here. To actually verify one, check its RFC 3161 signature against FreeTSA\'s public certificate. No event in this system currently carries one.',
        '9. dod_hash proves the Definition of Done text was not modified after contract initiation',
      ],
    },
  }

  return auditDoc
}

/**
 * Build the audit document and hand it to the browser as a download.
 * The document itself is built by buildAuditDocument, which is pure and
 * therefore testable without a DOM.
 *
 * @param {object} params - see buildAuditDocument
 */
export async function downloadAuditTrail(params) {
  const auditDoc = await buildAuditDocument(params)
  const contractId = params.contractId

  const blob = new Blob([JSON.stringify(auditDoc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = `trustflow-audit-${contractId}-${Date.now()}.json`
  window.document.body.appendChild(a)
  a.click()
  window.document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
