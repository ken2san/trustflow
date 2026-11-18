import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AgreementView from '../../src/views/AgreementView.jsx'
import GuestEvidenceView from '../../src/views/GuestEvidenceView.jsx'
import { shapeOwnerEvents, shapeGuestEvent } from '../../src/lib/agreementEvents.js'
import {
  SERVER_RECORDED_PROVENANCE, claimantOfActorId, claimantOfShapedActor,
} from '../../src/lib/contractStatus.js'

// Who the screens say wrote an event, end to end: raw rows (or the guest
// response) through the same shaping App.jsx uses, rendered by the real views.
//
// Option A (Kenji, 2026-11-16): a name needs server-recorded per-event
// provenance, and no event carries any today. So every row reads "a party" —
// the owner's own acts, recent contracts and server-versioned rows included —
// and no date or version input may bring a name back.

const OWNER = '1a2b3c4d-1111-4111-8111-aaaabbbbcccc'
const CONTRACT = {
  id: '22222222-2222-4222-8222-222222222222',
  project_name: 'Probe agreement',
  dod: ['deliver'],
  amount_jpy: 1000, amount_minor: 1000, currency: 'JPY', deadline: null,
  state: 'TERMS_ACCEPTED', performed_by: 'creator',
  earner_user_id: OWNER, earner_display_name: 'Acme Translations',
  invited_hirer_email: 'guest@example.test', hirer_email: 'guest@example.test',
  created_at: '2026-11-01T00:00:00.000Z',
}

const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (text, s) => text.split(s).length - 1
const CLAIM_BY_A_PARTY = 'Cancellation claimed by a party · not confirmed'

/** A raw events row as the owner reads it: server-versioned and recent. */
const row = (id, type, actorId, minute = 0) => ({
  id, type, actor_id: actorId, hash_version: 4, server_recorded_at: '2026-11-16T12:00:00.000Z',
  created_at: `2026-11-16T12:0${minute}:00.000Z`,
  payload: { _actor_role: 'earner', _authentication: { assurance: 'account_session' } },
})

const renderAgreement = events => textOf(renderToStaticMarkup(React.createElement(AgreementView, {
  contract: CONTRACT, events, viewerRole: 'owner', busy: false, error: null,
})))

describe('owner rows → AgreementView', () => {
  it('names nobody, not even the signed-in owner on a recent, server-versioned row', () => {
    const shaped = shapeOwnerEvents([
      row('e1', 'contract.cancelled', OWNER, 1),
      row('e2', 'contract.cancelled', 'guest:guest@example.test', 2),
      row('e3', 'dispute.opened', OWNER, 3),
      row('e4', 'dispute.opened', 'guest:guest@example.test', 4),
    ], CONTRACT, OWNER)
    expect(shaped.map(e => [e.claimant, e.actorLabel])).toEqual([
      [null, 'by a party'], [null, 'by a party'], [null, 'by a party'], [null, 'by a party'],
    ])
    const text = renderAgreement(shaped)
    expect(count(text, CLAIM_BY_A_PARTY)).toBe(2)
    expect(text).not.toMatch(/\bby you\b|claimed by you/)
    expect(text).not.toContain('by guest@example.test')
    expect(text).not.toMatch(/\bCancelled\b/)
  })

  it('does not repeat the attribution beside a cancellation', () => {
    const text = renderAgreement(shapeOwnerEvents([row('e1', 'contract.cancelled', OWNER)], CONTRACT, OWNER))
    expect(count(text, 'a party')).toBe(1)
  })
})

describe('guest response → AgreementView (App\'s guest path)', () => {
  const guestEvent = (id, type, actor) => ({
    id, type, created_at: '2026-11-16T12:00:00.000Z', actor, payload: {},
    integrity: {
      canonical_version: 4, canonical_version_supported: true,
      hash_valid: true, chain_linked: true, substance_valid: true,
    },
  })

  it('names nobody, and maps a missing actor without throwing', () => {
    const shaped = [
      guestEvent('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }),
      guestEvent('e2', 'contract.cancelled', { role: 'guest_hirer', label: 'guest@example.test' }),
      guestEvent('e3', 'dispute.opened', undefined),
      guestEvent('e4', 'dispute.opened', null),
    ].map(ev => shapeGuestEvent(ev))
    expect(shaped.every(e => e.claimant === null && e.actorLabel === 'by a party')).toBe(true)
    expect(count(renderAgreement(shaped), CLAIM_BY_A_PARTY)).toBe(2)
  })
})

describe('GuestEvidenceView', () => {
  const event = (id, type, actor) => ({
    id, type, created_at: '2026-11-16T12:00:00.000Z',
    actor, payload: {}, integrity: {
      canonical_version: 4, canonical_version_supported: true,
      hash_valid: true, chain_linked: true, substance_valid: true,
    },
  })
  const render = events => textOf(renderToStaticMarkup(React.createElement(GuestEvidenceView, {
    evidence: {
      contract: { ...CONTRACT, viewer_role: 'receiver' },
      accepted_agreement: null,
      chain: { event_count: events.length, verified: true, truncated: false, payload_covered_by_hash: true },
      events,
    },
  })))

  it('names nobody on cancellation or other rows, whatever the role or label', () => {
    const text = render([
      event('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }),
      event('e2', 'contract.cancelled', { role: 'guest_hirer', label: 'guest@example.test' }),
      event('e3', 'dispute.opened', { role: 'earner', label: 'Acme Translations' }),
      event('e4', 'dispute.opened', { role: 'guest_hirer', label: 'guest@example.test' }),
      event('e5', 'dispute.opened', { role: 'unknown', label: 'Alice' }),
    ])
    expect(count(text, CLAIM_BY_A_PARTY)).toBe(2)
    expect(text).not.toContain('by Acme Translations')
    expect(text).not.toContain('by guest@example.test')
    expect(text).not.toContain('Alice')
    expect(text).not.toContain('(you)')
    expect(text).not.toMatch(/Agreement cancelled/)
  })

  it('renders missing and non-string actor labels as "a party"', () => {
    const text = render([
      event('e1', 'contract.cancelled', undefined),
      event('e2', 'dispute.opened', { role: 'earner', label: { name: 'x' } }),
      event('e3', 'dispute.opened', { role: 'guest_hirer', label: 42 }),
    ])
    expect(count(text, CLAIM_BY_A_PARTY)).toBe(1)
    // Three "by" lines plus the claim label that also says "by a party".
    expect(count(text, 'by a party')).toBe(4)
    expect(text).not.toContain('[object Object]')
    expect(text).not.toContain('42')
  })
})

describe('claimant rules', () => {
  it('name nobody without the server-recorded provenance marker, whatever else the row says', () => {
    for (const notProvenance of [undefined, null, '', 2, 4, 'server_attested', '2026-11-16T12:00:00Z', true]) {
      expect(claimantOfActorId(OWNER, OWNER, notProvenance)).toBeNull()
      expect(claimantOfShapedActor({ role: 'earner', label: 'A' }, notProvenance)).toBeNull()
    }
  })

  // The recognised-role logic, kept for when a real signal exists. The marker
  // is synthetic here: nothing in production supplies it.
  it('with the marker, name only recognised actors', () => {
    const P = SERVER_RECORDED_PROVENANCE
    expect(claimantOfActorId(OWNER, OWNER, P)).toBe('you')
    expect(claimantOfActorId('guest:a@b.test', OWNER, P)).toBe('a@b.test')
    expect(claimantOfActorId('guest:', OWNER, P)).toBeNull()
    expect(claimantOfActorId('a@b.test', OWNER, P)).toBeNull()
    expect(claimantOfActorId(42, OWNER, P)).toBeNull()
    expect(claimantOfShapedActor({ role: 'earner', label: 'A' }, P)).toBe('A')
    expect(claimantOfShapedActor({ role: 'guest_hirer', label: 'g' }, P)).toBe('you')
    expect(claimantOfShapedActor({ role: 'earner', label: '  ' }, P)).toBeNull()
    expect(claimantOfShapedActor({ role: 'unknown', label: 'Alice' }, P)).toBeNull()
    expect(claimantOfShapedActor(null, P)).toBeNull()
  })
})
