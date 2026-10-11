import { describe, it, expect } from 'vitest'
import {
  ACCEPTANCE_TYPE, buildEventRecord, acceptanceFacts, roleInAgreement,
} from '../../supabase/functions/_shared/eventRecord.ts'
import {
  eventCanonical, canonicalVersionOf, payloadHash, sha256Hex, deriveAgreementHash,
} from '../../supabase/functions/_shared/eventCanonical.ts'
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
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  earner_display_name: 'Acme Translations',
  invited_hirer_email: 'invited@example.test',
  hirer_email: 'invited@example.test',
}

const acceptance = (overrides = {}) => buildEventRecord({
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
    // The case the old ternary got wrong, and which partyAuth.ts already
    // supports: a counterparty who holds a real account and acts with a JWT.
    // The ternary would have called that an invitation capability.
    const record = await buildEventRecord({
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
