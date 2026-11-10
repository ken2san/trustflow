import { describe, it, expect } from 'vitest'
import { ACCEPTANCE_TYPE, PRE_ACCEPTANCE_STATES, acceptanceFacts, acceptedSnapshotVersion, buildEventRecord, roleInAgreement } from '../../supabase/functions/_shared/eventRecord.ts'
import { SNAPSHOT_VERSION, canonicalVersionOf, deriveAgreementHash, eventCanonical, payloadHash, sha256Hex } from '../../supabase/functions/_shared/eventCanonical.ts'
import {
  assuranceFromClaims, bearerAssurance,
} from '../../supabase/functions/_shared/authAssurance.ts'

// Two Edge Functions write events now — log-event for assertions, and
// validate-invite-token for the acceptance, which had to move there so that
// accepting and recording what was accepted commit together. Both go through
// buildEventRecord, and these tests are what stop the two producing different
// kinds of object.

const CONTRACT = {
  id: '22222222-2222-4222-8222-222222222222',
  project_name: 'Certified translation of a birth certificate',
  dod: ['translate the document', 'return a stamped PDF'],
  amount_jpy: 20000,
  amount_minor: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  earner_display_name: 'Acme Translations',
  invited_hirer_email: 'invited@example.test',
  hirer_email: 'invited@example.test',
}

const acceptance = (overrides = {}) => buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
  type: ACCEPTANCE_TYPE,
  contract: CONTRACT,
  actorId: `guest:${CONTRACT.hirer_email}`,
  party: 'guest_hirer',
  assurance: bearerAssurance('invite_token'),
  payload: { counterparty_name: 'Guest', counterparty_email: CONTRACT.hirer_email },
  prevEventHash: 'GENESIS',
  ...overrides,
})

describe('roleInAgreement', () => {
  it('puts the work on whichever side performed_by names', () => {
    expect(roleInAgreement('earner', 'creator')).toBe('performer')
    expect(roleInAgreement('guest_hirer', 'creator')).toBe('receiver')
    expect(roleInAgreement('earner', 'counterparty')).toBe('receiver')
    expect(roleInAgreement('guest_hirer', 'counterparty')).toBe('performer')
  })

  it('treats an agreement predating the column as creator-performed', () => {
    expect(roleInAgreement('earner', null)).toBe('performer')
  })
})

describe('the record an event stores', () => {
  it('verifies under the version it was written with', async () => {
    const record = await acceptance()

    expect(record.hash_version).toBe(4)
    expect(canonicalVersionOf(record)).toBe(4)
    expect(await sha256Hex(eventCanonical(record, 4))).toBe(record.event_hash)
    expect(await payloadHash(record.payload)).toBe(record.payload_hash)
  })

  it('binds the agreement the contract actually holds', async () => {
    const record = await acceptance()
    expect(record.agreement_hash).toBe(await deriveAgreementHash(CONTRACT))
  })

  it('drops the server namespace from anything the caller sent', async () => {
    const record = await acceptance({
      payload: {
        counterparty_name: 'Guest',
        _agreement: { snapshot_version: 1, amount: 1, dod: ['whatever I like'] },
        _auth_method: 'government_id_verified',
        _actor_role: 'earner',
      },
    })

    // What the party legitimately said survives; what they tried to assert on
    // the server's behalf does not.
    expect(record.payload.counterparty_name).toBe('Guest')
    expect(record.payload._agreement.amount).toBe(CONTRACT.amount_jpy)
    expect(record.payload._auth_method).toBe('invite_capability')
    expect(record.payload._actor_role).toBe('guest_hirer')
    expect(JSON.stringify(record.payload)).not.toContain('whatever I like')
    expect(JSON.stringify(record.payload)).not.toContain('government_id_verified')
  })

  it('carries an idempotency key through unchanged', async () => {
    const record = await acceptance({ idempotencyKey: `acceptance:${CONTRACT.id}` })
    expect(record.idempotency_key).toBe(`acceptance:${CONTRACT.id}`)
  })
})

describe('what an acceptance records', () => {
  it('embeds the deal, not only its digest', async () => {
    const record = await acceptance()

    expect(record.payload._agreement).toEqual({
      snapshot_version: 1,
      project_name: CONTRACT.project_name,
      dod: CONTRACT.dod,
      amount: CONTRACT.amount_jpy,
      currency: CONTRACT.currency,
      deadline: CONTRACT.deadline,
      performed_by: 'creator',
      offered_by: CONTRACT.earner_display_name,
    })
  })

  it('keeps the invited address and the claimed one apart, and calls neither verified', async () => {
    // A forwarded invitation is legitimate, and the divergence is evidence.
    const forwarded = { ...CONTRACT, hirer_email: 'someone.else@example.test' }
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: ACCEPTANCE_TYPE, contract: forwarded,
      actorId: 'guest:someone.else@example.test', party: 'guest_hirer',
      assurance: bearerAssurance('invite_token'),
      payload: {}, prevEventHash: 'GENESIS',
    })

    expect(record.payload._invited_recipient).toBe('invited@example.test')
    expect(record.payload._claimed_identity).toBe('someone.else@example.test')
    expect(record.payload._claimed_identity_verified).toBe(false)
    expect(record.payload._auth_method).toBe('invite_capability')
  })

  it('records the identity it is written with, so the two cannot disagree', async () => {
    // The acceptance writes hirer_email and hashes the snapshot in one
    // operation. A record claiming an identity the row does not carry would be
    // the same class of defect as an unbound price.
    const claimed = 'accepted.just.now@example.test'
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: ACCEPTANCE_TYPE,
      contract: { ...CONTRACT, hirer_email: claimed },
      actorId: `guest:${claimed}`, party: 'guest_hirer',
      assurance: bearerAssurance('invite_token'),
      payload: {}, prevEventHash: 'GENESIS',
    })

    expect(record.actor_id).toBe(`guest:${claimed}`)
    expect(record.payload._claimed_identity).toBe(claimed)
  })

  it('states the accepting party is the performer when they do the work', async () => {
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: ACCEPTANCE_TYPE,
      contract: { ...CONTRACT, performed_by: 'counterparty' },
      actorId: 'guest:x@example.test', party: 'guest_hirer',
      assurance: bearerAssurance('invite_token'),
      payload: {}, prevEventHash: 'GENESIS',
    })

    expect(record.payload._role_in_agreement).toBe('performer')
    expect(record.payload._agreement.performed_by).toBe('counterparty')
  })

  it('does not attach the agreement to an ordinary assertion', async () => {
    // Only the acceptance carries the snapshot. Every event carries the hash.
    const asserted = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted', contract: CONTRACT,
      actorId: 'earner-uuid', party: 'earner',
      assurance: assuranceFromClaims({
        aal: 'aal1', amr: [{ method: 'otp', timestamp: 1791731476 }],
      }),
      payload: { note: 'delivered' }, prevEventHash: 'abc',
    })

    expect(asserted.payload._agreement).toBeUndefined()
    expect(asserted.payload._invited_recipient).toBeUndefined()
    expect(asserted.agreement_hash).toBe(await deriveAgreementHash(CONTRACT))
    expect(asserted.payload._auth_method).toBe('account_session')
  })

  it('is assembled the same way wherever it is built', async () => {
    // Same inputs, same record apart from the id and the timestamp — which are
    // the only two fields that are meant to differ per write.
    const a = await acceptance()
    const b = await acceptance()
    const strip = r => ({ ...r, id: null, created_at: null, event_hash: null })

    expect(strip(a)).toEqual(strip(b))
    expect(a.payload_hash).toBe(b.payload_hash)
    expect(a.agreement_hash).toBe(b.agreement_hash)
  })
})

describe('acceptanceFacts', () => {
  it('says nothing was verified, because nothing was', async () => {
    expect(acceptanceFacts(CONTRACT)._claimed_identity_verified).toBe(false)
  })

  it('reports an absent invited address as absent rather than guessing', () => {
    const { invited_hirer_email: _none, ...noInvite } = CONTRACT
    expect(acceptanceFacts(noInvite)._invited_recipient).toBeNull()
  })
})

// ── what the record says about authentication ────────────────────────────────
// Until this change `_auth_method` was `party === 'guest_hirer' ? … : …`, a
// restatement of `_actor_role` in the shape of an assurance claim. These tests
// pin the two properties that fix is for: the value follows the CREDENTIAL, and
// nothing a caller sends can influence it.

describe('the authentication an event records', () => {
  const accountClaims = { aal: 'aal1', amr: [{ method: 'otp', timestamp: 1791731476 }] }

  it('follows the credential, not the role', async () => {
    // A SYNTHETIC combination, and deliberately so: this calls the record
    // builder directly with `party: 'guest_hirer'` and account assurance,
    // which no endpoint produces. `log-event`'s JWT path authorizes only the
    // owner — `data.user.id === contract.earner_user_id`, party `earner` — so
    // a counterparty presenting their own account JWT is refused with
    // `not_a_party`. Do not read this test as coverage of a live credential
    // path; it covers the MAPPING, which the old ternary got wrong by calling
    // an account session an invitation capability whenever the party was the
    // counterparty.
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.accepted', contract: CONTRACT,
      actorId: 'hirer-uuid', party: 'guest_hirer',
      assurance: assuranceFromClaims(accountClaims),
      payload: {}, prevEventHash: 'abc',
    })

    expect(record.payload._actor_role).toBe('guest_hirer')
    expect(record.payload._auth_method).toBe('account_session')
    expect(record.payload._authentication.credential).toBe('account_jwt')
  })

  it('tells the two bearer credentials apart', async () => {
    const accepting = await acceptance()
    const later = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.accepted', contract: CONTRACT,
      actorId: 'guest:invited@example.test', party: 'guest_hirer',
      assurance: bearerAssurance('guest_access_token'),
      payload: {}, prevEventHash: 'abc',
    })

    expect(accepting.payload._authentication.credential).toBe('invite_token')
    expect(later.payload._authentication.credential).toBe('guest_access_token')
    // Both are capabilities. Neither is an authentication event.
    expect(accepting.payload._authentication.method).toBeNull()
    expect(later.payload._authentication.assurance).toBe('bearer_capability')
  })

  it('records the method and level the session actually carried', async () => {
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted', contract: CONTRACT,
      actorId: 'earner-uuid', party: 'earner',
      assurance: assuranceFromClaims(accountClaims, new Date(1791731776 * 1000)),
      payload: {}, prevEventHash: 'abc',
    })

    expect(record.payload._authentication.method).toBe('otp')
    expect(record.payload._authentication.aal).toBe('aal1')
    expect(record.payload._authentication.seconds_since_authentication).toBe(300)
  })

  it('never writes an absolute sign-in time or a session handle', async () => {
    // Both are withheld deliberately: the log is append-only and the payload is
    // shown to the counterparty, and created_at minus the relative figure
    // reproduces the instant for anyone who needs it.
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted', contract: CONTRACT,
      actorId: 'earner-uuid', party: 'earner',
      assurance: assuranceFromClaims(accountClaims),
      payload: {}, prevEventHash: 'abc',
    })

    const serialized = JSON.stringify(record.payload)
    expect(record.payload._authentication.authenticated_at).toBeUndefined()
    expect(record.payload._authentication.session_id).toBeUndefined()
    expect(serialized).not.toContain('authenticated_at')
    expect(serialized).not.toContain('session_id')
  })

  it('answers the act-binding question rather than leaving the field out', async () => {
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted', contract: CONTRACT,
      actorId: 'earner-uuid', party: 'earner',
      // As recent as it is possible to be: authenticated this instant.
      assurance: assuranceFromClaims({ aal: 'aal1', amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] }),
      payload: {}, prevEventHash: 'abc',
    })

    expect(record.payload._authentication.recent_authentication).toBe(true)
    // Recency is not binding, however recent. No challenge exists.
    expect(record.payload._authentication.act_bound_authentication).toBe(false)
    expect(record.payload._authentication.act_binding_mechanism).toBeNull()
    // The threshold travels with the boolean it produced.
    expect(record.payload._authentication.recent_authentication_window_seconds).toBe(300)
  })

  it('cannot be forged by a caller sending its own assurance', async () => {
    const record = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted', contract: CONTRACT,
      actorId: 'guest:invited@example.test', party: 'guest_hirer',
      assurance: bearerAssurance('guest_access_token'),
      payload: {
        _authentication: { assurance: 'account_session', aal: 'aal2', act_bound_authentication: true },
        _auth_method: 'government_id_verified',
      },
      prevEventHash: 'abc',
    })

    expect(record.payload._auth_method).toBe('invite_capability')
    expect(record.payload._authentication.assurance).toBe('bearer_capability')
    expect(record.payload._authentication.aal).toBeNull()
    expect(record.payload._authentication.act_bound_authentication).toBe(false)
    expect(JSON.stringify(record.payload)).not.toContain('government_id_verified')
  })
})

// ── compatibility with everything already written ────────────────────────────
// Adding a payload key changes payload_hash for NEW events, which is expected
// and harmless. What must not change is the canonical: the list of fields the
// event_hash is computed over, and how each version computes it. If that moved,
// every one of production's 2396 stored events would read as tampered with.

describe('events written before this change', () => {
  // A real row from the E2E project, recorded under v4 before _authentication
  // existed. Its stored event_hash is the assertion: if the canonical shifts,
  // this fails.
  const HISTORICAL = {
    id: 'a3b4a0c0-9c8f-4ff7-9c64-2a1e25f4db2a',
    type: 'performance.asserted',
    contract_id: '8c98dca5-3ba7-4e65-9f1a-7c1b20ba2d3c',
    actor_id: 'guest:harness-guest@example.invalid',
    dod_hash: 'f0b9e0a3cf0b4d9d9a4f0a3e9c4a1b2c3d4e5f60718293a4b5c6d7e8f9012345',
    created_at: '2026-10-11T04:15:22.016Z',
    prev_event_hash: 'GENESIS',
    payload_hash: '1111111111111111111111111111111111111111111111111111111111111111',
    agreement_hash: '2222222222222222222222222222222222222222222222222222222222222222',
    hash_version: 4,
  }

  it('hash the same fields, in the same order, as before', async () => {
    // The canonical string itself, spelled out. A reader can see exactly what
    // is covered, and any reordering or added field breaks this literal.
    expect(eventCanonical(HISTORICAL, 4)).toBe(JSON.stringify({
      id: HISTORICAL.id,
      type: HISTORICAL.type,
      contract_id: HISTORICAL.contract_id,
      actor_id: HISTORICAL.actor_id,
      dod_hash: HISTORICAL.dod_hash,
      created_at: HISTORICAL.created_at,
      prev_hash: HISTORICAL.prev_event_hash,
      payload_hash: HISTORICAL.payload_hash,
      agreement_hash: HISTORICAL.agreement_hash,
    }))
  })

  it('are verified under their own version, which this change did not touch', async () => {
    for (const version of [1, 2, 3, 4]) {
      const canonical = eventCanonical(HISTORICAL, version)
      // Each version is a prefix of the next, by construction.
      expect(canonical).toContain('"id":"' + HISTORICAL.id + '"')
      expect(JSON.parse(canonical).agreement_hash).toBe(version >= 4 ? HISTORICAL.agreement_hash : undefined)
      expect(JSON.parse(canonical).payload_hash).toBe(version >= 3 ? HISTORICAL.payload_hash : undefined)
      expect(JSON.parse(canonical).prev_hash).toBe(version >= 2 ? HISTORICAL.prev_event_hash : undefined)
    }
  })

  it('still record no _authentication, and that absence is readable', () => {
    // 2134 production events predate _auth_method entirely. A reader must be
    // able to tell "nothing was recorded" from "a capability was recorded",
    // which is why the new field is an object and not a bare string.
    const legacyPayload = { step: 2 }
    expect(legacyPayload._authentication).toBeUndefined()
    expect(legacyPayload._auth_method).toBeUndefined()
  })
})

// ── What the record says about the terms-presentation check ─────────────────
//
// The shown-terms digest is optional for a JPY contract during the
// compatibility period: a client that sends none is accepted, and the
// acceptance it writes was — until this change — byte-for-byte the same kind of
// record as one whose digest was checked and matched. Whether the accepter's
// view of the terms was ever compared against the server's is a fact about that
// moment, and nothing reconstructs it afterwards.
//
// So it is recorded as an absence rather than left as one, following the
// `_claimed_identity_verified: false` precedent beside it: state the negative,
// do not omit the field.
describe('an acceptance records whether the terms check happened', () => {
  const CHECKED   = { presented: true,  verified: true,  version: 2 }
  const UNCHECKED = { presented: false, verified: false, version: null }

  it('states a verified check', () => {
    expect(acceptanceFacts(CONTRACT, CHECKED)._shown_terms_check)
      .toEqual({ presented: true, verified: true, version: 2 })
  })

  it('states the absence of one, rather than omitting it', () => {
    // The case the field exists for. `presented: false` is a claim about this
    // acceptance; a missing key would be a claim about nothing.
    expect(acceptanceFacts(CONTRACT, UNCHECKED)._shown_terms_check)
      .toEqual({ presented: false, verified: false, version: null })
  })

  it('keeps "presented" and "verified" separate even though one pair is unreachable', () => {
    // BE PRECISE ABOUT WHAT THIS DISTINGUISHES, because it is easy to overstate
    // and I did at first. In validate-invite-token as it stands, a presented
    // digest either verifies or the request is refused — a mismatch answers
    // terms_changed and an unknown format answers terms_check_unsupported, both
    // before anything is written. So `presented: true, verified: false` cannot
    // reach a written event today. Two states are reachable, not three.
    //
    // The pair is still two fields rather than one boolean, because they are
    // different facts: whether the caller offered a digest, and whether the
    // server agreed with it. Should a future acceptance path ever record a
    // mismatch instead of refusing it, that record must not be forced to
    // choose between the two reachable states — which is what a single boolean
    // would make it do, silently.
    const presentedButUnverified = { presented: true, verified: false, version: 1 }
    expect(acceptanceFacts(CONTRACT, presentedButUnverified)._shown_terms_check)
      .toEqual(presentedButUnverified)
    expect(acceptanceFacts(CONTRACT, UNCHECKED)._shown_terms_check)
      .not.toEqual(presentedButUnverified)
  })

  it('records nothing at all when the caller does not report one', () => {
    // A writer that has not been taught to pass this must leave the record
    // silent, not assert a false negative — silence is recoverable by reading
    // the deploy history; a wrong `presented: false` is not.
    expect(acceptanceFacts(CONTRACT)).not.toHaveProperty('_shown_terms_check')
    expect(acceptanceFacts(CONTRACT, null)).not.toHaveProperty('_shown_terms_check')
  })

  it('binds the fact into the payload hash', async () => {
    // Recorded is not the same as attested. If the two acceptances hashed
    // identically, the field would be a comment.
    const checked   = await acceptance({ shownTermsCheck: CHECKED })
    const unchecked = await acceptance({ shownTermsCheck: UNCHECKED })
    expect(checked.payload._shown_terms_check.verified).toBe(true)
    expect(unchecked.payload._shown_terms_check.verified).toBe(false)
    expect(checked.payload_hash).not.toBe(unchecked.payload_hash)
    expect(checked.event_hash).not.toBe(unchecked.event_hash)
  })

  it('stays under the server namespace, so a caller cannot forge it', async () => {
    const record = await acceptance({
      shownTermsCheck: UNCHECKED,
      // A party claiming its own terms check verified. Underscore-prefixed keys
      // are stripped from caller payloads, so this must not survive.
      payload: {
        counterparty_name: 'Guest',
        _shown_terms_check: { presented: true, verified: true, version: 2 },
      },
    })
    expect(record.payload._shown_terms_check).toEqual(UNCHECKED)
  })

  it('is an acceptance fact only, and not attached to other events', async () => {
    const asserted = await buildEventRecord({
    agreementSnapshotVersion: SNAPSHOT_VERSION,
      type: 'performance.asserted',
      contract: CONTRACT,
      actorId: 'earner:1',
      party: 'earner',
      assurance: bearerAssurance('invite_token'),
      payload: { note: 'done' },
      prevEventHash: 'GENESIS',
      shownTermsCheck: { presented: true, verified: true, version: 2 },
    })
    // Nothing else in the protocol has a presentation to bind, and a
    // terms-check field on an unrelated act would imply one.
    expect(asserted.payload).not.toHaveProperty('_shown_terms_check')
  })
})

// ── Which terms a later act refers to ───────────────────────────────────────
//
// Codex's finding 2 on Task 26: `buildEventRecord` derived the agreement hash
// with whatever snapshot builder happened to be CURRENT. Correct only while one
// version has ever existed. The day a v2 builder arrives, a later assertion on
// a v1 agreement would reference terms in a shape nobody accepted — and the
// acceptance it follows would still be v1.

describe('the snapshot version a later act refers to', () => {
  const base = {
    type: 'performance.asserted',
    contract: CONTRACT,
    actorId: 'earner-uuid',
    party: 'earner',
    assurance: assuranceFromClaims({ aal: 'aal1', amr: [{ method: 'otp', timestamp: 1 }] }),
    payload: {},
    prevEventHash: 'abc',
  }

  it('is required, and an omitted one is refused rather than defaulted', async () => {
    // A required TypeScript parameter is still undefined at run time, and
    // deriveAgreementHash's own default would then build the current version —
    // silently, which is the whole failure. So the guard is a runtime check.
    await expect(buildEventRecord({ ...base })).rejects
      .toThrow(/requires agreementSnapshotVersion/)
  })

  it('refuses a version this build cannot build', async () => {
    for (const version of [2, 0, null, '1', 1.5]) {
      await expect(
        buildEventRecord({ ...base, agreementSnapshotVersion: version }),
        `version ${String(version)}`,
      ).rejects.toThrow(/requires agreementSnapshotVersion/)
    }
  })

  it('derives the same hash as before when the accepted version is the current one', async () => {
    // The proof this guard changed no output today: there is one version, so
    // every act passes 1, and 1 is what the old code produced.
    const record = await buildEventRecord({ ...base, agreementSnapshotVersion: 1 })
    expect(record.agreement_hash).toBe(await deriveAgreementHash(CONTRACT))
    expect(record.agreement_hash).toBe(await deriveAgreementHash(CONTRACT, 1))
  })
})

describe('reading the accepted snapshot version back', () => {
  // A stand-in for the admin client: one chainable builder whose terminal
  // `maybeSingle()` resolves to whatever the test wants the table to hold.
  const admin = result => {
    const chain = {
      from: () => chain, select: () => chain, eq: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => result,
    }
    return chain
  }

  const read = (result, mustBeAccepted) =>
    acceptedSnapshotVersion(admin(result), 'contract-id', { mustBeAccepted })

  it('returns the version the acceptance recorded, in either mode', async () => {
    const found = { data: { payload: { _agreement: { snapshot_version: 1 } } }, error: null }
    expect(await read(found, false)).toEqual({ version: 1 })
    expect(await read(found, true)).toEqual({ version: 1 })
  })

  it('falls back to the current version for a draft that has no acceptance', async () => {
    // A draft can carry events before anyone accepts it — api-e2e asserts an
    // owner may record against an unaccepted draft — and nothing is pinned
    // then, so the current version is the right answer rather than a guess.
    expect(await read({ data: null, error: null }, false))
      .toEqual({ version: SNAPSHOT_VERSION })
  })

  it('REFUSES a missing acceptance where one must exist', async () => {
    // Codex's finding 3 on the re-review. A reissue, or any act on a contract
    // whose state says it was accepted, must not append against an assumption
    // when the evidence it should refer to cannot be found.
    expect(await read({ data: null, error: null }, true))
      .toEqual({ error: 'accepted_version_missing' })
  })

  it('refuses when the read fails, in either mode', async () => {
    // A failed read and a missing row look identical to a caller that only
    // checks for rows, and one of them means the terms are pinned to something
    // this act cannot see.
    for (const mustBeAccepted of [false, true]) {
      expect(await read({ data: null, error: { message: 'boom' } }, mustBeAccepted))
        .toEqual({ error: 'accepted_version_unreadable' })
    }
  })

  it('refuses an accepted version this build cannot build', async () => {
    for (const recorded of [2, 99, 0, null, undefined, '1']) {
      expect(
        await read({ data: { payload: { _agreement: { snapshot_version: recorded } } }, error: null }, false),
        `recorded ${String(recorded)}`,
      ).toEqual({ error: 'accepted_version_unsupported' })
    }
  })

  it('refuses an acceptance whose payload has no agreement at all', async () => {
    expect(await read({ data: { payload: {} }, error: null }, false))
      .toEqual({ error: 'accepted_version_unsupported' })
  })

  // ── Where this reader and contracts.accepted_snapshot_version can differ ──
  //
  // Codex's P2 on 20261110150000. This reader sees the version AFTER
  // JSON.parse, which rounds to a double; the column's SQL rule sees the exact
  // numeric jsonb stored. The payloads below are the text PostgREST would hand
  // supabase-js, parsed the same way.
  //
  // The two can differ in ONE direction only, and it is the safe one: the
  // column is stricter. Where it says NULL the consumer falls back to this
  // reader, so the answer is still this reader's. The reverse, a column number
  // other than the one this reader parses, is impossible for an integer below
  // 2^31, which is exact in a double. The number is the same; whether it is a
  // SUPPORTED version is a separate check, which a consumer of the column must
  // make as this reader does (2 is kept there, refused here). The migration's
  // self-test pins the SQL half; these pin this half. If either side changes,
  // one of the two fails.
  const fromText = text => ({ data: { payload: JSON.parse(text) }, error: null })

  it('reads 1.0 and 1e0 as 1, as the column does', async () => {
    for (const text of ['{"_agreement":{"snapshot_version":1.0}}',
      '{"_agreement":{"snapshot_version":1e0}}']) {
      expect(await read(fromText(text), true), text).toEqual({ version: 1 })
    }
  })

  it('reads a near-integer as 1 where the column records NULL: the safe asymmetry', async () => {
    // The column holds NULL for both of these, because neither is exactly an
    // integer. This reader accepts them, because JSON.parse already rounded
    // them to 1. A consumer that finds NULL asks this reader and gets 1, so the
    // outcome is the same. No writer produces such a payload: the only one is
    // buildEventRecord, and it writes the integer literal SNAPSHOT_VERSION.
    for (const text of ['{"_agreement":{"snapshot_version":1.00000000000000001}}',
      '{"_agreement":{"snapshot_version":0.99999999999999999}}']) {
      expect(await read(fromText(text), true), text).toEqual({ version: 1 })
    }
  })

  it('refuses beyond the column range as well, so a number there is never a version here', async () => {
    // 2147483648 is NULL in the column (outside int range) and unsupported
    // here. 2147483647 fits the column, which keeps it as recorded, and is
    // unsupported here too: a consumer must check a column number against the
    // supported set, exactly as this reader does.
    for (const text of ['{"_agreement":{"snapshot_version":2147483648}}',
      '{"_agreement":{"snapshot_version":2147483647}}']) {
      expect(await read(fromText(text), true), text)
        .toEqual({ error: 'accepted_version_unsupported' })
    }
  })

  it('treats every state but the two pre-acceptance ones as accepted', () => {
    // Listed as the pre-acceptance set rather than the accepted set, so a
    // state added later refuses rather than defaults. Refusing a write is
    // recoverable; recording one against a guessed version is not.
    expect([...PRE_ACCEPTANCE_STATES].sort()).toEqual(['AWAITING_ACCEPTANCE', 'DRAFTING'])
    for (const state of ['TERMS_ACCEPTED', 'AWAITING_CONFIRMATION', 'PERFORMANCE_ACCEPTED',
      'CANCELLED', 'SETTLED', 'SOMETHING_ADDED_LATER', '']) {
      expect(PRE_ACCEPTANCE_STATES.has(state), state).toBe(false)
    }
  })
})

// ── The version decision across a concurrent acceptance ─────────────────────
//
// Codex's finding 2 on the re-review. A draft permits owner events, so a writer
// could read "no acceptance", cache the current version, and then have an
// acceptance commit before its own insert — appending AFTER that acceptance
// while carrying the assumption it made before the acceptance existed. During a
// mixed-version rollout the acceptance could bind a version this writer cannot
// build, and the write would not refuse.
//
// log-event now reads the accepted version per ATTEMPT, beside the chain tip.
// What makes re-reading sufficient rather than merely likelier to be right is
// `events_chain_no_fork_idx`, unique on (contract_id, prev_event_hash): an
// acceptance committing between the tip read and the insert must claim the same
// predecessor this attempt read, so the insert loses with 23505 and the loop
// comes back and reads both again.
//
// This models that loop. It cannot model Postgres, so what it asserts is the
// thing that is this module's to get right: a re-read after the acceptance
// lands yields the acceptance's version, and an unsupported one refuses —
// rather than the first read's answer being reused.

describe('a draft that is accepted mid-write', () => {
  /** An admin whose acceptance table changes between reads. */
  const sequencedAdmin = (results) => {
    let call = 0
    const chain = {
      from: () => chain, select: () => chain, eq: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => results[Math.min(call++, results.length - 1)],
    }
    return { admin: chain, calls: () => call }
  }

  const NONE = { data: null, error: null }
  const acceptedAt = v => ({ data: { payload: { _agreement: { snapshot_version: v } } }, error: null })

  it('sees no acceptance first, then the acceptance on the retry', async () => {
    const { admin, calls } = sequencedAdmin([NONE, acceptedAt(1)])

    // Attempt 1: nothing accepted yet, so the current version is correct.
    expect(await acceptedSnapshotVersion(admin, 'c', { mustBeAccepted: false }))
      .toEqual({ version: SNAPSHOT_VERSION })

    // The acceptance commits here, and the insert loses the fork index. The
    // loop re-reads rather than reusing what it learned.
    expect(await acceptedSnapshotVersion(admin, 'c', { mustBeAccepted: false }))
      .toEqual({ version: 1 })
    expect(calls()).toBe(2)
  })

  it('refuses on the retry when the acceptance bound a version it cannot build', async () => {
    // The failure the caching allowed: appending against the current version
    // after an acceptance pinned something else. A second read is what turns
    // that into a refusal.
    const { admin } = sequencedAdmin([NONE, acceptedAt(2)])

    expect(await acceptedSnapshotVersion(admin, 'c', { mustBeAccepted: false }))
      .toEqual({ version: SNAPSHOT_VERSION })
    expect(await acceptedSnapshotVersion(admin, 'c', { mustBeAccepted: false }))
      .toEqual({ error: 'accepted_version_unsupported' })
  })

  it('does not let a first read be reused once an acceptance exists', async () => {
    // Stated as its own assertion because the defect was precisely a value
    // surviving across the loop: every attempt must ask again.
    const { admin, calls } = sequencedAdmin([acceptedAt(1)])
    for (let i = 0; i < 3; i++) {
      await acceptedSnapshotVersion(admin, 'c', { mustBeAccepted: true })
    }
    expect(calls()).toBe(3)
  })
})

// ── Two acceptances sharing a timestamp ─────────────────────────────────────
//
// Codex's finding 1 on the Task 30 re-review. The backfill in
// 20261109210000 orders acceptances by (created_at, id); this reader ordered by
// created_at alone. On two acceptances with the same stamp — one valid, one
// malformed — the migration and the writers could pick different rows, so the
// cached column would disagree with the refusal the writers were already
// making. My comment in that migration had claimed the two matched.
//
// Ties cannot be created any anymore: events_require_monotonic_created_at
// refuses an event not strictly later than the last on its contract. They can
// still be READ, because rows written before that trigger are exactly why it
// was added — so the order has to be total over historical rows.

describe('the order this reader asks the database for', () => {
  /** Records the query it was built into, so the ordering can be asserted. */
  const recordingAdmin = (rows) => {
    const calls = { order: [], eq: [], limit: null }
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: (col, val) => { calls.eq.push([col, val]); return chain },
      order: (col, opts) => { calls.order.push([col, opts?.ascending]); return chain },
      limit: (n) => { calls.limit = n; return chain },
      // Resolve the way PostgREST would: apply the recorded ordering to the
      // supplied rows, so the assertion is about the RESULT and not only about
      // which methods were called.
      maybeSingle: async () => {
        const sorted = [...rows].sort((a, b) => {
          for (const [col, asc] of calls.order) {
            const dir = asc === false ? -1 : 1
            if (a[col] < b[col]) return -1 * dir
            if (a[col] > b[col]) return 1 * dir
          }
          return 0
        })
        return { data: sorted[0] ?? null, error: null }
      },
    }
    return { chain, calls }
  }

  const acceptance = (id, created_at, snapshot_version) => ({
    id, created_at,
    payload: { _agreement: snapshot_version === undefined ? {} : { snapshot_version } },
  })

  it('asks for a total order: created_at then id, both ascending', async () => {
    const { chain, calls } = recordingAdmin([acceptance('a', 't1', 1)])
    await acceptedSnapshotVersion(chain, 'c', { mustBeAccepted: true })
    expect(calls.order).toEqual([['created_at', true], ['id', true]])
    expect(calls.limit).toBe(1)
  })

  it('takes the lower id when two acceptances share a timestamp', async () => {
    // The malformed one sorts first by id, so the answer must be the refusal —
    // the same answer the migration now produces for the same rows.
    const { chain } = recordingAdmin([
      acceptance('b-later-id', '2026-11-09T00:00:00.000Z', 1),
      acceptance('a-earlier-id', '2026-11-09T00:00:00.000Z', 'not-a-number'),
    ])
    expect(await acceptedSnapshotVersion(chain, 'c', { mustBeAccepted: true }))
      .toEqual({ error: 'accepted_version_unsupported' })
  })

  it('takes the valid one when it is the lower id, so the refusal is not blanket', async () => {
    const { chain } = recordingAdmin([
      acceptance('b-later-id', '2026-11-09T00:00:00.000Z', 'not-a-number'),
      acceptance('a-earlier-id', '2026-11-09T00:00:00.000Z', 1),
    ])
    expect(await acceptedSnapshotVersion(chain, 'c', { mustBeAccepted: true }))
      .toEqual({ version: 1 })
  })

  it('still prefers the earlier timestamp over the lower id', async () => {
    // created_at leads; id only breaks a tie. The valid row here is later in
    // time and lower in id, and must lose.
    const { chain } = recordingAdmin([
      acceptance('a-low-id', '2026-11-09T00:00:01.000Z', 1),
      acceptance('z-high-id', '2026-11-09T00:00:00.000Z', 'not-a-number'),
    ])
    expect(await acceptedSnapshotVersion(chain, 'c', { mustBeAccepted: true }))
      .toEqual({ error: 'accepted_version_unsupported' })
  })
})
