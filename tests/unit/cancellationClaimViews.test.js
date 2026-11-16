import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AgreementView from '../../src/views/AgreementView.jsx'
import GuestEvidenceView from '../../src/views/GuestEvidenceView.jsx'
import { shapeOwnerEvents, shapeGuestEvent } from '../../src/lib/agreementEvents.js'
import { claimantOfActorId, claimantOfShapedActor } from '../../src/lib/contractStatus.js'

// Who the screens say wrote an event, end to end: raw rows (or the guest
// response) through the same shaping App.jsx uses, rendered by the real views.
// A name appears only when the server derived the actor (hash_version >= 2 /
// trust_model 'server_attested'); everything else reads "a party" (Codex
// Tasks 93, 94).

const OWNER = '1a2b3c4d-1111-4111-8111-aaaabbbbcccc'
const CONTRACT = {
  id: '22222222-2222-4222-8222-222222222222',
  project_name: 'Probe agreement',
  dod: ['deliver'],
  amount_jpy: 1000, amount_minor: 1000, currency: 'JPY', deadline: null,
  state: 'TERMS_ACCEPTED', performed_by: 'creator',
  earner_user_id: OWNER, earner_display_name: 'Acme Translations',
  invited_hirer_email: 'guest@example.test', hirer_email: 'guest@example.test',
  created_at: '2026-11-01T00:00:00.000Z',   // after events stopped being client-writable
}
// A contract from before 2026-09-25: its events could have been written by any
// client with the anon key, whatever hash_version they carry.
const OLD_CONTRACT = { ...CONTRACT, created_at: '2026-09-20T00:00:00.000Z' }

const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (text, s) => text.split(s).length - 1

/** A raw events row as the owner reads it. */
const row = (id, type, actorId, hashVersion = 2, minute = 0) => ({
  id, type, actor_id: actorId, hash_version: hashVersion,
  created_at: `2026-11-16T12:0${minute}:00.000Z`, payload: {},
})

const renderAgreement = events => textOf(renderToStaticMarkup(React.createElement(AgreementView, {
  contract: CONTRACT, events, viewerRole: 'owner', busy: false, error: null,
})))

describe('owner rows → AgreementView', () => {
  it('names the owner and the guest only on server-attested rows', () => {
    const text = renderAgreement(shapeOwnerEvents([
      row('e1', 'contract.cancelled', OWNER, 2, 1),
      row('e2', 'contract.cancelled', 'guest:guest@example.test', 2, 2),
      row('e3', 'contract.cancelled', OWNER, null, 3),                        // legacy: browser-chosen
      row('e4', 'contract.cancelled', 'guest:guest@example.test', null, 4),   // legacy guest: prefix
      row('e5', 'contract.cancelled', 'user', 2, 5),                         // unknown id
    ], CONTRACT, OWNER))
    expect(text).toContain('Cancellation claimed by you · not confirmed')
    expect(text).toContain('Cancellation claimed by guest@example.test · not confirmed')
    expect(count(text, 'Cancellation claimed by a party · not confirmed')).toBe(3)
    expect(text).not.toMatch(/\bCancelled\b/)
  })

  it('names nobody on a contract from before events stopped being client-writable', () => {
    const shaped = shapeOwnerEvents([
      row('e1', 'contract.cancelled', OWNER, 4, 1),
      row('e2', 'dispute.opened', 'guest:guest@example.test', 4, 2),
    ], OLD_CONTRACT, OWNER)
    expect(shaped.map(e => [e.claimant, e.actorLabel])).toEqual([[null, 'by a party'], [null, 'by a party']])
    expect(renderAgreement(shaped)).toContain('Cancellation claimed by a party · not confirmed')
  })

  it('says "by you" on other rows only when the owner provably wrote them', () => {
    const shaped = shapeOwnerEvents([
      row('e1', 'dispute.opened', OWNER, 2, 1),
      row('e2', 'dispute.opened', OWNER, null, 2),
      row('e3', 'dispute.opened', 'someone@example.test', null, 3),
      row('e4', 'dispute.opened', 'guest:guest@example.test', 2, 4),
    ], CONTRACT, OWNER)
    expect(shaped.map(e => e.actorLabel)).toEqual(['by you', 'by a party', 'by a party', 'by guest@example.test'])
    const text = renderAgreement(shaped)
    expect(count(text, 'by you')).toBe(1)
    expect(count(text, 'by a party')).toBe(2)
  })

  it('says "you" for the signed-in viewer, even when the contract row lacks earner_user_id', () => {
    const listed = { ...CONTRACT, earner_user_id: undefined }   // listContracts does not select it
    const shaped = shapeOwnerEvents([row('e1', 'contract.cancelled', OWNER)], listed, OWNER)
    expect(shaped[0].claimant).toBe('you')
    // ...and not for the earner when someone else is signed in.
    const other = shapeOwnerEvents([row('e1', 'contract.cancelled', OWNER)], CONTRACT, 'someone-else')
    expect(other[0].claimant).toBeNull()
  })

  it('does not repeat the name beside a cancellation', () => {
    const text = renderAgreement(shapeOwnerEvents([row('e1', 'contract.cancelled', OWNER)], CONTRACT, OWNER))
    expect(count(text, 'you')).toBe(1)
  })
})

describe('guest response → AgreementView (App\'s guest path)', () => {
  const guestEvent = (id, type, actor, trust = 'server_attested') => ({
    id, type, created_at: '2026-11-16T12:00:00.000Z', actor, payload: {},
    integrity: { trust_model: trust },
  })

  it('maps a missing actor without throwing, as "a party"', () => {
    const shaped = [
      guestEvent('e1', 'contract.cancelled', undefined),
      guestEvent('e2', 'dispute.opened', null),
    ].map(ev => shapeGuestEvent(ev, CONTRACT))
    expect(shaped.map(e => [e.claimant, e.actorLabel])).toEqual([[null, 'by a party'], [null, 'by a party']])
    const text = renderAgreement(shaped)
    expect(text).toContain('Cancellation claimed by a party · not confirmed')
  })

  it('names the earner and the guest only on server-attested rows', () => {
    const shaped = [
      guestEvent('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }),
      guestEvent('e2', 'contract.cancelled', { role: 'guest_hirer', label: 'guest@example.test' }),
      guestEvent('e3', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }, 'client_asserted'),
      guestEvent('e4', 'contract.cancelled', { role: 'unknown', label: 'Unknown' }),
    ].map(ev => shapeGuestEvent(ev, CONTRACT))
    expect(shaped.map(e => e.claimant)).toEqual(['Acme Translations', 'you', null, null])
    // The same rows on a pre-cutoff contract, or with no contract time, name nobody.
    expect([guestEvent('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' })]
      .map(ev => shapeGuestEvent(ev, OLD_CONTRACT))[0].claimant).toBeNull()
    expect(shapeGuestEvent(guestEvent('e1', 'contract.cancelled', { role: 'guest_hirer', label: 'g@x.test' }), {}).claimant).toBeNull()
  })
})

describe('GuestEvidenceView', () => {
  const event = (id, type, actor, trust = 'server_attested') => ({
    id, type, created_at: '2026-11-16T12:00:00.000Z',
    actor, payload: {}, integrity: { hash_valid: true, chain_linked: true, trust_model: trust },
  })
  const render = (events, contract = CONTRACT) => textOf(renderToStaticMarkup(React.createElement(GuestEvidenceView, {
    evidence: {
      contract: { ...contract, viewer_role: 'receiver' },
      accepted_agreement: null,
      chain: { event_count: events.length, client_asserted: 0, server_attested: events.length, verified: true, truncated: false },
      events,
    },
  })))

  it('names the earner and the guest, and never an unknown or legacy actor', () => {
    const text = render([
      event('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }),
      event('e2', 'contract.cancelled', { role: 'guest_hirer', label: 'guest@example.test' }),
      event('e3', 'contract.cancelled', { role: 'unknown', label: 'Unknown' }),
      event('e4', 'contract.cancelled', { role: 'guest_hirer', label: 'guest@example.test' }, 'client_asserted'),
    ])
    expect(text).toContain('Cancellation claimed by Acme Translations · not confirmed')
    expect(text).toContain('Cancellation claimed by you · not confirmed')
    expect(count(text, 'Cancellation claimed by a party · not confirmed')).toBe(2)
    expect(text).not.toContain('claimed by Unknown')
    expect(text).not.toMatch(/Agreement cancelled/)
  })

  it('renders a missing or non-string actor label as "a party", on cancellation and other rows', () => {
    const text = render([
      event('e1', 'contract.cancelled', undefined),
      event('e2', 'contract.cancelled', { role: 'earner', label: { name: 'x' } }),
      event('e3', 'dispute.opened', { role: 'earner', label: { name: 'x' } }),
      event('e4', 'dispute.opened', { role: 'guest_hirer', label: 42 }),
    ])
    expect(count(text, 'Cancellation claimed by a party · not confirmed')).toBe(2)
    // Three unnamed "by" lines plus the two claim labels. The guest_hirer row is
    // named by its ROLE ("you"); its non-string label is never rendered.
    expect(count(text, 'by a party')).toBe(5)
    expect(count(text, 'by you')).toBe(1)
    expect(text).not.toContain('42')
    expect(text).not.toContain('[object Object]')
    expect(text).not.toContain('(you)')
  })

  it('never names an unknown or legacy role from its label, on cancellation and other rows', () => {
    const misleading = [
      event('e1', 'contract.cancelled', { role: 'unknown', label: 'Alice' }),
      event('e2', 'dispute.opened', { role: 'unknown', label: 'Alice' }),
      event('e3', 'contract.cancelled', { role: 'earner_legacy', label: 'Bob' }),
      event('e4', 'dispute.opened', { role: 'earner_legacy', label: 'Bob' }),
    ]
    const text = render(misleading)
    expect(text).not.toContain('Alice')
    expect(text).not.toContain('Bob')
    expect(count(text, 'Cancellation claimed by a party · not confirmed')).toBe(2)
    // Four "by" lines, plus the two claim labels that also say "by a party".
    expect(count(text, 'by a party')).toBe(6)
  })

  it('names nobody on a contract from before 2026-09-25, even server_attested rows', () => {
    const text = render([
      event('e1', 'contract.cancelled', { role: 'earner', label: 'Acme Translations' }),
      event('e2', 'dispute.opened', { role: 'guest_hirer', label: 'guest@example.test' }),
    ], OLD_CONTRACT)
    expect(text).not.toContain('by Acme Translations')
    expect(text).not.toContain('by guest@example.test')
    expect(text).toContain('Cancellation claimed by a party · not confirmed')
  })

  it('shows a legacy row\'s actor as "a party" even when it carries a guest: label', () => {
    const text = render([event('e1', 'dispute.opened', { role: 'guest_hirer', label: 'guest@example.test' }, 'client_asserted')])
    expect(text).toContain('by a party')
    // The address still appears in the header, as the one given at acceptance;
    // what must not appear is the row attributed to it.
    expect(text).not.toContain('by guest@example.test')
  })
})

describe('claimant rules', () => {
  it('name only actors on server-written rows of a post-cutoff contract', () => {
    const NEW = CONTRACT.created_at
    const OLD = OLD_CONTRACT.created_at
    expect(claimantOfActorId(OWNER, OWNER, 2, NEW)).toBe('you')
    expect(claimantOfActorId(OWNER, OWNER, 2, OLD)).toBeNull()
    expect(claimantOfActorId(OWNER, OWNER, 2, undefined)).toBeNull()
    expect(claimantOfActorId(OWNER, OWNER, 2, 'not a date')).toBeNull()
    expect(claimantOfActorId(OWNER, OWNER, null, NEW)).toBeNull()
    expect(claimantOfActorId('guest:a@b.test', OWNER, 2, NEW)).toBe('a@b.test')
    expect(claimantOfActorId('guest:a@b.test', OWNER, 1, NEW)).toBeNull()
    expect(claimantOfActorId('guest:', OWNER, 2, NEW)).toBeNull()
    expect(claimantOfActorId('a@b.test', OWNER, 2, NEW)).toBeNull()
    expect(claimantOfActorId(42, OWNER, 2, NEW)).toBeNull()
    expect(claimantOfShapedActor({ role: 'earner', label: 'A' }, 'server_attested', NEW)).toBe('A')
    expect(claimantOfShapedActor({ role: 'earner', label: 'A' }, 'server_attested', OLD)).toBeNull()
    expect(claimantOfShapedActor({ role: 'earner', label: 'A' }, 'client_asserted', NEW)).toBeNull()
    expect(claimantOfShapedActor({ role: 'earner', label: '  ' }, 'server_attested', NEW)).toBeNull()
    expect(claimantOfShapedActor({ role: 'unknown', label: 'Alice' }, 'server_attested', NEW)).toBeNull()
    expect(claimantOfShapedActor(null, 'server_attested', NEW)).toBeNull()
  })
})
