// supabase/functions/_shared/guestResponse.ts
//
// The whole guest-contract-events success body, by response version.
//
// WHY THIS MOVED OUT OF THE ENDPOINT (Task 202)
// Version 1 must stay byte-identical while version 2 is added beside it, and
// the endpoint cannot be exercised by a test (Deno.serve plus an esm.sh
// import). So the version-1 body literal and termsChangedSinceAcceptance moved
// here VERBATIM, and version 2 is built in separate code from the same rows.
// Nothing version 1 calls was edited.
//
// VERSION 2, IN ONE PARAGRAPH
// Opt-in with `?response_version=2`. It drops version 1's format-as-authorship
// labels (`trust_model`, the server_attested / client_asserted counts, actor
// role and label), gives v5 rows an exact 12-input canonical block, and adds
// the strict reader's verdicts: per event in `integrity.strict`, and for the
// trail in `strict_verification`.
//
// WHAT VERSION 2 `chain.verified` MEANS (option D, Kenji 2026-11-22, Codex T175)
// True only when the strict server slice is `verified` AND the read boundary
// is established (started at the deal's first event, tail proven complete).
// The boolean and `strict_verification.server.overall` come from ONE decision,
// `serverDecision`, so they cannot disagree. Version 1's rule ignored payload
// checks, invalid rows and agreement failures; version 1 keeps it, frozen.

import { isSupportedSnapshotVersion, buildAgreementSnapshot } from './eventCanonical.ts'
import {
  type GuestTrailVerdicts, chainSummary, guestCanonicalBlock, guestStrictVerdicts, guestVerificationNotes,
  guestVerificationNotesV2, filterPayload, shapeGuestEventsV1,
} from './guestEventView.ts'
import type { RowResult } from './eventVerifyV5.ts'

type StrictReader = typeof guestStrictVerdicts

// Rows and the contract as PostgREST hands them to the endpoint (untyped).
// deno-lint-ignore no-explicit-any
type StoredRow = Record<string, any>

export type ResponseVersion = 1 | 2

export type VersionRequest =
  | { ok: true, version: ResponseVersion }
  | { ok: false, status: 400, error: 'invalid_response_version' | 'unsupported_response_version' }

/**
 * Which response version a request asked for.
 *
 * Absent means version 1, until the announced flip. Exactly one value of `2`
 * means version 2. Anything else is refused rather than read as the nearest
 * version: another integer is a version this build does not serve; a
 * duplicate, an empty value or a non-integer is malformed. The caller checks
 * this AFTER the credential refusals, which come first.
 */
export function requestedResponseVersion(url: string): VersionRequest {
  const values = new URL(url).searchParams.getAll('response_version')
  if (values.length === 0) return { ok: true, version: 1 }
  if (values.length === 1 && values[0] === '2') return { ok: true, version: 2 }
  if (values.length === 1 && /^(0|[1-9][0-9]*)$/.test(values[0])) {
    return { ok: false, status: 400, error: 'unsupported_response_version' }
  }
  return { ok: false, status: 400, error: 'invalid_response_version' }
}

/**
 * Which agreed terms the contract row no longer matches.
 *
 * Built by re-deriving the snapshot from the CURRENT row under THE VERSION THE
 * AGREEMENT WAS ACCEPTED UNDER, so this comparison cannot drift from what the
 * hash actually binds. An empty list means the row still says what was agreed;
 * a non-empty one means the record moved and the accepted terms are the ones
 * the evidence proves.
 *
 * THE VERSION IS READ FROM THE ACCEPTED SNAPSHOT, and that is the whole point
 * of this change. It used to build with the CURRENT version, which was correct
 * only while there has only ever been one. Codex's data-model review found what
 * happens on the day there are two: a v2 builder that adds, say,
 * `deadline_zone: null` would make every v1 agreement look CHANGED to its own
 * counterparty — `undefined` on the accepted side, `null` on the rebuilt one —
 * and the screen would tell them their terms had moved when nobody touched
 * them. For a product whose only claim is the record, that is the claim
 * failing.
 *
 * An accepted snapshot whose version this build does not know returns `null`:
 * "cannot say", which is what the field means elsewhere. It is not an empty
 * list, because an empty list asserts the terms are unchanged.
 */
export function termsChangedSinceAcceptance(
  accepted: Record<string, unknown> | null,
  contract: Record<string, unknown>,
): string[] | null {
  if (!accepted) return null
  const acceptedVersion = accepted.snapshot_version
  if (!isSupportedSnapshotVersion(acceptedVersion)) return null
  const current = buildAgreementSnapshot(
    contract, acceptedVersion as number,
  ) as unknown as Record<string, unknown>
  return Object.keys(current)
    .filter(key => key !== 'snapshot_version')
    .filter(key => JSON.stringify(current[key]) !== JSON.stringify(accepted[key]))
}

/** The only recorded actor-id classes version 2 reports. A fact about the string, not a role. */
export function recordedIdClass(actorId: unknown, contract: StoredRow): string {
  if (actorId === null || actorId === undefined || actorId === '') return 'missing'
  if (typeof actorId !== 'string') return 'other'
  if (contract.earner_user_id && actorId === contract.earner_user_id) return 'matches_contract_earner_id'
  if (actorId.startsWith('guest:')) return 'guest_prefixed'
  return 'other'
}

const triState = (value: string, pass: string, fail: string): boolean | null =>
  value === pass ? true : value === fail ? false : null

/** One row's strict result, as version 2 carries it. `reason` only when the row is invalid. */
function strictBlock(result: RowResult): Record<string, unknown> {
  const block: Record<string, unknown> = {
    kind: result.kind, hash: result.hash, link: result.link, payload: result.payload, agreement: result.agreement,
  }
  if (result.kind === 'invalid' && typeof result.reason === 'string') block.reason = result.reason
  return block
}

/**
 * Version-2 integrity for one event.
 *
 *   legacy, unsupported  version 1's values, minus trust_model (published as
 *                        unchanged)
 *   v5                   the tri-states from the strict row result; this build
 *                        verifies the format, so it is supported
 *   invalid              nothing checked: version 1 could report an authority-
 *                        bearing v4 row as verified under a version it did not
 *                        claim, and version 2 must not
 */
function integrityV2(v1: Record<string, unknown>, result: RowResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event_hash:                  v1.event_hash,
    prev_event_hash:             v1.prev_event_hash,
    hash_valid:                  v1.hash_valid,
    chain_linked:                v1.chain_linked,
    substance_valid:             v1.substance_valid,
    binds_whole_agreement:       v1.binds_whole_agreement,
    canonical_version:           v1.canonical_version,
    canonical_version_supported: v1.canonical_version_supported,
  }
  if (result.kind === 'v5') {
    out.hash_valid = triState(result.hash, 'match', 'mismatch')
    out.chain_linked = triState(result.link, 'linked', 'broken')
    out.substance_valid = triState(result.payload, 'match', 'mismatch')
    out.binds_whole_agreement = true
    out.canonical_version = 5
    out.canonical_version_supported = true
  } else if (result.kind === 'invalid') {
    out.hash_valid = null
    out.chain_linked = null
    out.substance_valid = null
    out.binds_whole_agreement = false
    out.canonical_version_supported = false
  }
  out.strict = strictBlock(result)
  return out
}

/**
 * Version 1's counts under version 2's names. `verified` is NOT version 1's
 * rule: it is the caller's `serverDecision`, and `truncated` is true whenever
 * the tail is not proven complete.
 */
function chainSummaryV2(
  events: { id: unknown, integrity: Record<string, unknown> }[], truncated: boolean, verified: boolean,
) {
  // chainSummary's `server_attested` is `canonical_version >= 2`, exactly as
  // version 1 sets trust_model; it is recomputed here because v2 drops the label.
  const c = chainSummary(events.map(e => ({
    id: e.id as string | null,
    integrity: {
      ...e.integrity,
      trust_model: (e.integrity.canonical_version as number) >= 2 ? 'server_attested' : 'client_asserted',
    },
  })), { truncated })
  return {
    event_count:                    c.event_count,
    events_format_v2_or_later:      c.server_attested,
    events_format_below_v2:         c.client_asserted,
    verified,
    unsupported_canonical_versions: c.unsupported_canonical_versions,
    truncated:                      c.truncated,
    payload_covered_by_hash:        c.payload_covered_by_hash,
  }
}

export type TailEvidence = 'complete' | 'truncated' | 'unknown'

export interface ReadBoundary {
  /** The endpoint reads one deal ascending from its first event. */
  start: 'first_event'
  tail: TailEvidence
  /** PostgREST's exact count for the same scoped statement, when it gave one. */
  recorded_count: number | null
}

/**
 * Whether the read reached the end of the deal, from scoped evidence only.
 *
 * `count` is PostgREST's exact count, computed in the same statement and under
 * the same filters as the page. A page SHORTER than the requested limit is not
 * evidence: a server-side row ceiling below the limit returns a short page
 * with a tail behind it (Codex T174). Without a usable count the tail is
 * unknown, never complete.
 */
export function readBoundary(returned: number, count: unknown): ReadBoundary {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return { start: 'first_event', tail: 'unknown', recorded_count: null }
  }
  const tail: TailEvidence = count === returned ? 'complete' : count > returned ? 'truncated' : 'unknown'
  return { start: 'first_event', tail, recorded_count: count }
}

/**
 * The single decision behind version 2's headline and its attributed result.
 * The strict overall verdict, downgraded to `incomplete` unless the boundary
 * is established; `verified` is exactly `overall === 'verified'`.
 */
export function serverDecision(
  strictOverall: 'verified' | 'failed' | 'incomplete',
  boundary: ReadBoundary,
): { overall: 'verified' | 'failed' | 'incomplete', verified: boolean } {
  const established = boundary.start === 'first_event' && boundary.tail === 'complete'
  const overall = strictOverall === 'verified' && !established ? 'incomplete' : strictOverall
  return { overall, verified: overall === 'verified' }
}

const LOCAL_NOTE = 'strict_verification.server was computed by TrustFlow over the stored rows with their full '
  + 'payloads. A reader of this response holds only the canonical blocks, the allowlisted payload projection and '
  + 'accepted_agreement, so a recomputation from it can check hashes, links and the agreement digest, but cannot '
  + 'reach a verified payload, and should be reported as incomplete at best. Where a reader\'s own check disagrees '
  + 'with the server\'s, the reader is right.'

export interface GuestResponse {
  body: Record<string, unknown>
  /** Version 1's chain summary, whichever version was served (for the endpoint's log line). */
  chain: Record<string, unknown>
  /** The strict verdicts when version 2 computed them; null on the version 1 path. */
  strict: GuestTrailVerdicts | null
  /** What the shadow log needs, so it can run after the body exists. */
  acceptedAgreement: unknown
}

/**
 * The success body for one guest read.
 *
 * `rows` are the endpoint's SELECT, ascending from the deal's first event;
 * `contract` is the token-resolved row; `count` is PostgREST's exact count for
 * that same statement. Pure apart from hashing.
 *
 * Version 1 never runs the strict reader, so nothing strict-only can turn a
 * valid version 1 read into an error (Codex T174). Version 2 cannot be served
 * without it, so there a strict exception propagates.
 */
export async function guestResponse(
  rows: readonly StoredRow[],
  contract: StoredRow & { id: string },
  { version, maxEvents, count, strictReader = guestStrictVerdicts }: {
    version: ResponseVersion, maxEvents: number, count?: unknown, strictReader?: StrictReader,
  },
): Promise<GuestResponse> {
  // Version 1, unchanged: shaped by the moved, now-tested loop.
  const events = await shapeGuestEventsV1(rows, contract)

  // The deal as it stood when it was accepted, taken from the acceptance
  // event rather than from the contract row. The row may legitimately have
  // moved on, and the historical record must not depend on it.
  const acceptance = rows.find(r => r.type === 'dod.consent_recorded')
  const acceptedAgreement = (acceptance?.payload as Record<string, unknown> | null)?._agreement ?? null
  const invitedRecipient = (acceptance?.payload as Record<string, unknown> | null)?._invited_recipient ?? null
  const claimedIdentity = (acceptance?.payload as Record<string, unknown> | null)?._claimed_identity ?? null

  // Version 1's cap rule, frozen. Version 2 does not use it.
  const truncated = rows.length >= maxEvents
  const chain = chainSummary(events, { truncated })

  // ── Version 1: the endpoint's literal, moved verbatim ──
  const v1 = {
    // What was ACCEPTED, recorded at the time. Null for agreements accepted
    // before the snapshot existed — absent, not reconstructed.
    accepted_agreement: acceptedAgreement,
    // Terms on which the current row and the accepted agreement disagree.
    // Empty when they still match; null when there is no accepted snapshot
    // to compare against.
    terms_changed_since_acceptance: termsChangedSinceAcceptance(
      acceptedAgreement as Record<string, unknown> | null, contract),
    // Kept apart: an invitation can be forwarded, and the divergence is
    // itself evidence. Neither address is verified.
    acceptance_identity: acceptance ? {
      invited_recipient: invitedRecipient,
      claimed_identity: claimedIdentity,
      claimed_identity_verified: false,
      // How the accepting party got in — which for an acceptance is always
      // a consumed invitation and never an authentication event. Both the
      // coarse legacy string and the structured record are returned; the
      // latter is absent on acceptances written before it existed, and that
      // absence is a fact rather than a gap to fill in.
      authentication: (acceptance.payload as Record<string, unknown>)?._auth_method ?? null,
      authentication_detail: (acceptance.payload as Record<string, unknown>)?._authentication ?? null,
    } : null,
    // The CURRENT row. May differ from accepted_agreement.
    contract: {
      id:                  contract.id,
      project_name:        contract.project_name,
      dod:                 contract.dod,
      amount_jpy:          contract.amount_jpy,
      amount_minor:        contract.amount_minor,
      currency:            contract.currency,
      deadline:            contract.deadline,
      state:               contract.state,
      // Which side does the work. The guest needs it to know whether the
      // next action is theirs, and it is a term of the deal rather than
      // anything internal.
      performed_by:        contract.performed_by,
      // The guest is always the counterparty; saying so plainly saves the
      // client from re-deriving it.
      viewer_role:         contract.performed_by === 'counterparty' ? 'performer' : 'receiver',
      earner_display_name: contract.earner_display_name,
      // The address that accepted — this guest's own, echoed back so the
      // trail is self-describing in an export.
      hirer_email:         contract.hirer_email,
    },
    events,
    // What the guest can establish for themselves from this response, and
    // what no amount of hashing in it will establish. Carried in the data
    // because a machine reader has no README.
    verification: guestVerificationNotes(),
    chain,
  }
  if (version === 1) return { body: v1, chain, strict: null, acceptedAgreement }

  // The strict v5 reader, server-side with full payloads, bounded by the
  // count evidence: an unproven tail is passed as not complete.
  const boundary = readBoundary(rows.length, count)
  const strict = await strictReader(rows, contract, { truncated: boundary.tail !== 'complete', acceptedAgreement })
  const decision = serverDecision(strict.server.overall, boundary)

  // ── Version 2: built from the same rows; nothing above is reused but the head ──
  const { events: _events, verification: _verification, chain: _chain, ...head } = v1
  const v2Events = rows.map((row, i) => {
    const shaped = events[i] as Record<string, unknown>
    const result = strict.server.rows[i]
    const { block } = guestCanonicalBlock(row, contract.id, { projected: true })
    return {
      id:         shaped.id,
      type:       shaped.type,
      created_at: shaped.created_at,
      actor: {
        id:                row.actor_id ?? null,
        attribution:       'as_recorded_not_verified',
        recorded_id_class: recordedIdClass(row.actor_id, contract),
      },
      // No event carries per-event evidence of who wrote it.
      provenance: { writer: 'unknown', basis: 'none_recorded' },
      dod_hash:   shaped.dod_hash,
      payload:    filterPayload(row.type, row.payload),
      canonical:  block,
      integrity:  integrityV2(shaped.integrity as Record<string, unknown>, result),
    }
  })
  const body = {
    response_version: 2,
    ...head,
    events: v2Events,
    verification: guestVerificationNotesV2(),
    chain: chainSummaryV2(v2Events, boundary.tail !== 'complete', decision.verified),
    strict_verification: {
      server: {
        overall:       decision.overall,
        dimensions:    strict.server.dimensions,
        acceptance:    strict.server.acceptance,
        read_boundary: boundary,
      },
      server_agreement: {
        status:           strict.server_agreement.status,
        hash:             strict.server_agreement.hash,
        acceptance_index: strict.server_agreement.acceptance_index,
      },
      local_note: LOCAL_NOTE,
    },
  }
  return { body, chain, strict, acceptedAgreement }
}

/**
 * The endpoint's shadow log line for one read, or null when there is nothing
 * to say. Runs the strict reader itself on the version 1 path, AFTER the body
 * is built, and never throws: a strict-only exception becomes a log line with
 * its error class only, and the version 1 response is unaffected. Counts and
 * labels only — no ids, tokens or addresses.
 */
export async function shadowStrictLog(
  rows: readonly StoredRow[],
  contract: StoredRow & { id: string },
  response: GuestResponse,
  { version, count, strictReader = guestStrictVerdicts }: {
    version: ResponseVersion, count?: unknown, strictReader?: StrictReader,
  },
): Promise<Record<string, unknown> | null> {
  try {
    const boundary = readBoundary(rows.length, count)
    const strict = response.strict ?? await strictReader(rows, contract, {
      truncated: boundary.tail !== 'complete', acceptedAgreement: response.acceptedAgreement,
    })
    const strictRows = strict.server.rows.filter(r => r.kind === 'v5' || r.kind === 'invalid').length
    const v1Verified = response.chain.verified
    if (strictRows === 0 && !(v1Verified === true && strict.server.overall === 'failed')) return null
    return {
      event: 'guest_strict_reader', strict_rows: strictRows, response_version: version,
      v1_verified: v1Verified, strict_overall: strict.server.overall, dimensions: strict.server.dimensions,
      tail: boundary.tail,
    }
  } catch (err) {
    return { event: 'guest_strict_reader_error', response_version: version,
      error_class: err instanceof Error ? err.name : typeof err }
  }
}
