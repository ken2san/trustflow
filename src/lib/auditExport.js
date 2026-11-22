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
import {
  classifyStoredEvent, verifyEvidenceSlice, verifyV5EventHash,
} from '../../supabase/functions/_shared/eventVerifyV5.ts'
import { acceptedAgreementHashOf } from '../../supabase/functions/_shared/guestEventView.ts'

const EXPORT_VERSION = '2.0'

/**
 * Build and download a signed JSON audit trail for a contract.
 *
 * @param {object} params
 * @param {string}   params.contractId   - contract identifier
 * @param {string}   params.dodHash      - SHA-256 of the original DoD
 * @param {object[]} params.events       - array of event objects from eventLog
 * @param {object}   [params.meta]       - optional extra metadata (title, parties, etc.)
 * @param {object}   [params.evidence]   - what the caller can prove about the read, used only
 *   when the trail holds v5 (or v5-shaped invalid) rows: `start` is 'first_event' only if the
 *   read provably began at the deal's first event, `tailComplete` only if nothing after the
 *   last row was left out. Absent means unknown, so completeness is never claimed by omission.
 */
export async function buildAuditDocument({ contractId, dodHash, events, meta = {}, evidence = {} }) {
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
    //
    // `versionSupported` first: `hashVersion >= 3` would assume the payload
    // semantics of a version this build has never seen, and then report the
    // result as a check. Caught by its own test, after the same fix had been
    // made in the guest view and missed here — which is the argument for
    // testing both readers rather than the shared primitive.
    const substanceMatch = versionSupported && hashVersion >= 3 && ev.payload_hash
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
        // Whether this row's hash format includes a payload digest: true from
        // supported v3, false for v1 and v2, null for a format this build does
        // not know (its coverage is unknown, not absent). It says nothing
        // about who wrote the row. Export 1.1 had `trust_model` here, set from
        // the format alone, which read as authorship; it is gone.
        payload_hash_in_format: versionSupported ? hashVersion >= 3 : null,
      },
    })

    // Advance the expected tip regardless of match — a break should surface
    // as a mismatch on the NEXT event too if the gap wasn't the last one,
    // not silently reset the chain.
    prevHash = ev.event_hash ?? prevHash
  }

  // `!== false` is deliberate for the two cases where null means "there was
  // never anything to check": a pre-chain row has no stored hash, and a pre-v3
  // row never had its payload attested. Neither is a failure.
  //
  // It is NOT acceptable for a row this build cannot verify at all. Codex's
  // finding 1: an unsupported version sets hash_match to null, null is not
  // false, and the export therefore came out VERIFIED — the one word a reader
  // takes at face value — for a row nothing had checked. So unsupported rows
  // are counted separately and they dominate the aggregate.
  // ── Strict v5 rows (row 3 step 3C-core) ──────────────────────────────────
  // Gated: a trail with no v5 or v5-shaped row produces exactly today's
  // document. A strict row is never hashed through the legacy canonical — an
  // authority-bearing row labelled v4 would otherwise recompute as legacy.
  const strictKinds = chronological.map(ev => classifyStoredEvent(ev))
  const hasStrict = strictKinds.some(k => k.kind === 'v5' || k.kind === 'invalid')
  let v5Verification = null
  let slice = null
  if (hasStrict) {
    const accepted = await acceptedAgreementHashOf(chronological)
    slice = await verifyEvidenceSlice(chronological, {
      startsAtChainStart: evidence.start === 'first_event',
      tailComplete: evidence.tailComplete === true,
      acceptance: 'unknown',
      acceptedAgreementHash: accepted.hash,
      legacyAgreementHash: accepted.hash,
    })
    const tri = (value, yes, no) => (value === yes ? true : value === no ? false : null)
    for (let i = 0; i < chronological.length; i++) {
      const kind = strictKinds[i].kind
      if (kind !== 'v5' && kind !== 'invalid') continue
      const row = slice.rows[i]
      const ev = chronological[i]
      const v = kind === 'v5' ? await verifyV5EventHash(ev, ev.event_hash) : null
      verifiedEvents[i]._export_verification = {
        ...verifiedEvents[i]._export_verification,
        canonical_version: kind === 'v5' ? 5 : verifiedEvents[i]._export_verification.canonical_version,
        // Supported means this build verified the row under strict v5 rules;
        // an invalid row is not an unsupported version, it is invalid evidence.
        canonical_version_supported: kind === 'v5' ? true : null,
        substance_match: tri(row.payload, 'match', 'mismatch'),
        binds_whole_agreement: kind === 'v5',
        recomputed_hash: v && v.verdict !== 'invalid_input' ? v.hash : null,
        hash_match: tri(row.hash, 'match', 'mismatch'),
        chain_link_match: tri(row.link, 'linked', 'broken'),
        payload_hash_in_format: kind === 'v5' ? true : null,
        strict_v5: { kind, hash: row.hash, link: row.link, payload: row.payload, agreement: row.agreement,
          reason: row.reason ?? null },
      }
    }
    v5Verification = {
      evidence: { start: evidence.start === 'first_event' ? 'first_event' : 'unknown',
        tail_complete: evidence.tailComplete === true },
      accepted_agreement: accepted,
      overall: slice.overall,
      dimensions: slice.dimensions,
      acceptance: slice.acceptance,
      meaning: 'Strict canonical v5 verification over the whole trail: event hash, chain link, full payload '
        + 'and accepted agreement are separate checks, and VERIFIED requires every one to pass on a trail '
        + 'known to start at the first event and to be complete. The credential_id and issuer_kind in a v5 '
        + 'hash are recorded inputs, not proof of who acted.',
    }
  }

  const unsupportedEvents = verifiedEvents.filter(
    ev => ev._export_verification.canonical_version_supported === false
  )
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
      // A detected mismatch still outranks an unverifiable row: a broken hash
      // is a finding, while an unknown version is an absence of one. But
      // VERIFIED is reserved for a trail where every row was actually checked.
      integrity_status: !hasStrict
        ? (!allHashesMatch ? 'HASH_MISMATCH_DETECTED'
          : !chainIntact ? 'CHAIN_LINK_BROKEN'
          : unsupportedEvents.length > 0 ? 'INDETERMINATE_UNSUPPORTED_VERSION'
          : 'VERIFIED')
        // With strict rows a known mismatch still ranks first, and VERIFIED
        // additionally needs the strict slice verdict, never an omission.
        : (!allHashesMatch || slice.rows.some(r => r.hash === 'mismatch' || r.payload === 'mismatch')
            ? 'HASH_MISMATCH_DETECTED'
          : slice.rows.some(r => r.hash === 'invalid_input' || r.kind === 'invalid') ? 'INVALID_EVIDENCE_DETECTED'
          : !chainIntact || slice.dimensions.link === 'fail' ? 'CHAIN_LINK_BROKEN'
          : slice.dimensions.agreement === 'fail' ? 'AGREEMENT_MISMATCH_DETECTED'
          : unsupportedEvents.length > 0 ? 'INDETERMINATE_UNSUPPORTED_VERSION'
          : slice.overall !== 'verified' ? 'INDETERMINATE_INCOMPLETE_EVIDENCE'
          : 'VERIFIED'),
      // Named so a reader does not have to scan every event to find out why.
      unsupported_canonical_versions: unsupportedEvents.length === 0 ? null : {
        count: unsupportedEvents.length,
        event_ids: unsupportedEvents.map(ev => ev.id ?? null),
        versions: [...new Set(unsupportedEvents.map(
          ev => ev._export_verification.canonical_version))],
        meaning: 'This build cannot compute the canonical form for these '
          + 'versions, so their hashes were neither confirmed nor refuted. '
          + 'Verify them with a build that supports the version.',
      },
      ...(hasStrict ? { v5_verification: v5Verification } : {}),
      counterparty_consent: counterpartyConsent,
      meta,
      events:               verifiedEvents,
      verification_instructions: [
        '1. Sort events by created_at ascending.',
        '2. Normalise created_at to the form it was hashed in: an ISO-8601 instant in UTC with milliseconds and a trailing Z (2026-09-24T12:52:40.016Z). A timestamp rendered any other way — for example with a +00:00 offset — produces a different digest even though it is the same instant.',
        '3. For each event, recompute SHA-256 over a JSON object with keys in this exact order. For events where _export_verification.canonical_version is 2: {id, type, contract_id, actor_id, dod_hash, created_at, prev_hash}, where prev_hash is that event\'s own prev_event_hash field (or the literal string "GENESIS" for the first event). For canonical_version 1 — events written before the chain existed — omit prev_hash entirely; those rows were hashed without it, and including it will produce a mismatch on an untampered row. Compare with event.event_hash. A mismatch means the stored fields and the stored hash disagree; this export cannot say why — alteration, damage and a recording error look the same.',
        '4. Separately, confirm each event\'s prev_event_hash equals the PRECEDING event\'s event_hash. A break here, even if every individual event\'s own hash still matches itself, means the stored order and links disagree: an event deleted, reordered or inserted produces it, and so can a recording error. This export cannot say which.',
        '5. In supported canonical_version 4, the event hash also covers the recorded agreement_hash, which may be null. agreement_hash is meant to be the SHA-256 of the deterministically serialized agreement snapshot — project name, completion criteria, amount, currency, deadline, which side performs, and the offering party — and whether it matches a given snapshot is a separate comparison. Versions 1 to 3 cover only the recorded dod_hash, so amount and deadline are not covered on those events. _export_verification.binds_whole_agreement says which applies; it is false for a version this build does not recognise.',
        '6. From supported canonical_version 3, the event hash also covers the recorded payload_hash, the SHA-256 of the event payload serialized deterministically — object keys sorted recursively, arrays left in order, no whitespace. For versions 1 and 2 the hash does NOT cover payload: those detail fields were recorded but not covered. _export_verification.payload_hash_in_format says which applies: true, false, or null for a version this build does not recognise.',
        '7. Nothing in this export establishes who wrote an event or when. actor_id and created_at are the values recorded in each row; any client could set them before 2026-09-24, and an operator with database access could rewrite rows and recompute the chain at any time. A hash that recomputes shows the recorded fields agree with it, not that they are true. Exports before version 2.0 carried _export_verification.trust_model: "server_attested" meant canonical_version 2 or later and "client_asserted" meant below 2; neither identified who wrote an event.',
        '8. tsa_token_present only means a token was returned at logging time — it has not been cryptographically verified here. To actually verify one, check its RFC 3161 signature against FreeTSA\'s public certificate. No event in this system currently carries one.',
        '9. dod_hash is the recorded digest of the Definition of Done. Whether it matches a given text is a separate comparison; the event hash covers the digest, not the text.',
        ...(hasStrict ? [
          '10. For events with canonical_version 5, recompute SHA-256 over exactly {domain: "trustflow.event", hash_version: 5, id, type, contract_id, actor_id, dod_hash, created_at, prev_hash, payload_hash, agreement_hash, credential_id, issuer_kind} in that key order, compact JSON, UTF-8, where created_at is the UTC instant with exactly three fractional digits and a trailing Z, and prev_hash is the event\'s own prev_event_hash (never defaulted). Every field is required; only agreement_hash may be null, and null means no agreement was cited, not that one was accepted. A missing or malformed input is invalid evidence, not a mismatch. _export_verification.strict_v5 and v5_verification report each check separately.',
        ] : []),
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
