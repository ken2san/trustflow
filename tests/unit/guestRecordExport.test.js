import { describe, it, expect } from 'vitest'
import { buildGuestRecordDocument } from '../../src/lib/guestRecordExport.js'

// What these tests guard is mostly what the document CLAIMS. A copy that
// overstated the server's checks, or quietly dropped the fact that it was
// truncated, would be worse than no export at all — and so, now, would one
// that kept saying nothing here is reproducible after the canonical blocks
// made half of it reproducible. Both directions of that are pinned below.

const CONTRACT = {
  id: 'd666cf92-af89-4017-aec2-a905a2d07057',
  project_name: 'Certified translation',
  dod: ['Certified PDF delivered'],
  amount_jpy: 48000,
  currency: 'JPY',
  deadline: '2026-10-31',
  state: 'TERMS_ACCEPTED',
  performed_by: 'creator',
  viewer_role: 'receiver',
  earner_display_name: 'Acme Translations',
  hirer_email: 'claimed@example.test',
}

const ok = { hash_valid: true, chain_linked: true, substance_valid: true, trust_model: 'server_attested' }

function evidence(overrides = {}) {
  return {
    accepted_agreement: { amount: 48000, currency: 'JPY', deadline: '2026-10-31' },
    terms_changed_since_acceptance: [],
    acceptance_identity: {
      invited_recipient: 'invited@example.test',
      claimed_identity: 'claimed@example.test',
      claimed_identity_verified: false,
      authentication: 'invite_capability',
    },
    contract: CONTRACT,
    events: [{
      id: '1a', type: 'dod.consent_recorded', created_at: '2026-09-28T10:00:00.000Z',
      actor: { id: 'guest:claimed@example.test', role: 'guest_hirer', label: 'claimed@example.test' },
      payload: { counterparty_name: 'Guest' }, dod_hash: 'abc', integrity: { ...ok, binds_whole_agreement: true },
    }],
    chain: {
      event_count: 1, server_attested: 1, client_asserted: 0,
      verified: true, truncated: false, payload_covered_by_hash: true,
    },
    ...overrides,
  }
}

const rec = (e) => buildGuestRecordDocument(e).trustflow_counterparty_record

describe('the counterparty record document', () => {
  it('is named so it cannot be mistaken for the owner re-verifiable export', () => {
    const doc = buildGuestRecordDocument(evidence())
    expect(doc.trustflow_audit_trail).toBeUndefined()
    expect(doc.trustflow_counterparty_record).toBeDefined()
    expect(rec(evidence()).document_type).toBe('server_verified_record')
  })

  it('splits what the reader can recompute from what they cannot', () => {
    const text = JSON.stringify(rec(evidence()).what_this_document_is)
    // The half that is now reproducible, named as such.
    expect(text).toMatch(/recompute each hash and follow the chain offline/)
    // The half that is not, named just as plainly, and attributed.
    expect(text).toMatch(/payload digest CANNOT be reproduced/)
    expect(text).toMatch(/substance_valid.*server's word/)
  })

  it('gives every act the inputs its hash is taken over', () => {
    const canonical = {
      id: '1a', type: 'dod.consent_recorded', contract_id: CONTRACT.id,
      actor_id: 'guest:claimed@example.test', dod_hash: 'abc',
      created_at: '2026-09-28T10:00:00.000Z', prev_event_hash: 'GENESIS',
      payload_hash: 'ph', agreement_hash: 'ah', hash_version: 4,
    }
    const doc = rec(evidence({
      events: [{ ...evidence().events[0], canonical }],
    }))
    expect(doc.events[0].canonical).toEqual(canonical)
  })

  it('says an act cannot be checked when the response carried no canonical', () => {
    // A response from before this change. Null rather than absent: the reader
    // should see that the material is missing, not merely fail to find it.
    expect(rec(evidence()).events[0].canonical).toBeNull()
    expect(JSON.stringify(rec(evidence()).independent_verification))
      .toMatch(/predates the canonical blocks/)
  })

  it('carries the server\'s own statement of limits rather than restating it', () => {
    // Two documents describing the same record must not disagree about what it
    // proves, so the notes travel from the server response.
    const fromServer = {
      canonical_definition: 'x.ts',
      not_verifiable_here: ['the identity of either party'],
    }
    expect(rec(evidence({ verification: fromServer })).independent_verification)
      .toEqual(fromServer)
  })

  it('carries the server verdict rather than deriving one of its own', () => {
    expect(rec(evidence()).verification.server_verdict).toBe(true)
    expect(rec(evidence({ chain: { ...evidence().chain, verified: false } }))
      .verification.server_verdict).toBe(false)
  })

  it('names the reason a chain did not verify', () => {
    const broken = (integrity) => rec(evidence({
      chain: { ...evidence().chain, verified: false },
      events: [{ ...evidence().events[0], integrity: { ...ok, ...integrity } }],
    })).verification.status

    expect(rec(evidence()).verification.status).toBe('VERIFIED')
    expect(broken({ hash_valid: false })).toBe('HASH_MISMATCH_DETECTED')
    expect(broken({ chain_linked: false })).toBe('CHAIN_LINK_BROKEN')
    expect(broken({ substance_valid: false })).toBe('PAYLOAD_MISMATCH_DETECTED')
  })

  it('does not call a record unverified when there was never an attestation', () => {
    const doc = rec(evidence({
      chain: { ...evidence().chain, server_attested: 0, verified: false },
      events: [{ ...evidence().events[0], integrity: { trust_model: 'client_asserted' } }],
    }))
    expect(doc.verification.status).toBe('NOT_SERVER_ATTESTED')
  })

  it('surfaces truncation, because a missing event would otherwise mean nothing', () => {
    expect(rec(evidence({ chain: { ...evidence().chain, truncated: true } }))
      .verification.truncated).toBe(true)
  })

  it('keeps the accepted terms apart from the current ones', () => {
    const changed = rec(evidence({
      terms_changed_since_acceptance: ['amount'],
      contract: { ...CONTRACT, amount_jpy: 99000 },
    }))
    expect(changed.accepted_agreement.amount).toBe(48000)
    expect(changed.current_terms.amount_jpy).toBe(99000)
    expect(changed.terms_changed_since_acceptance).toEqual(['amount'])
  })

  it('never upgrades the claimed identity to a verified one', () => {
    const id = rec(evidence()).acceptance_identity
    expect(id.claimed_identity_verified).toBe(false)
    expect(id.invited_recipient).not.toBe(id.claimed_identity)
  })

  it('reports each event under a key that says who checked it', () => {
    const [ev] = rec(evidence()).events
    expect(ev.server_verification).toEqual({ ...ok, binds_whole_agreement: true })
    // The reader's copy of the payload, labelled as filtered in the preamble.
    expect(ev.payload).toEqual({ counterparty_name: 'Guest' })
  })

  it('refuses to produce a document with nothing in it', () => {
    expect(() => buildGuestRecordDocument(evidence({ events: [] })))
      .toThrow(/no readable events/)
    expect(() => buildGuestRecordDocument(evidence({ contract: null })))
      .toThrow(/no agreement/)
    expect(() => buildGuestRecordDocument(null)).toThrow()
  })
})
