import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AgreementView from '../../src/views/AgreementView.jsx'
import GuestEvidenceView from '../../src/views/GuestEvidenceView.jsx'
import { claimantOfActorId, claimantOfShapedActor } from '../../src/lib/contractStatus.js'

// Render-level checks for the cancellation claim (Codex Task 93): the helper
// tests prove the wording, these prove what each view actually puts on screen
// for an owner's, a guest's and an unknown actor's contract.cancelled.

const OWNER = '1a2b3c4d-1111-4111-8111-aaaabbbbcccc'
const CONTRACT = {
  id: '22222222-2222-4222-8222-222222222222',
  project_name: 'Probe agreement',
  dod: ['deliver'],
  amount_jpy: 1000, amount_minor: 1000, currency: 'JPY', deadline: null,
  state: 'TERMS_ACCEPTED', performed_by: 'creator',
  earner_user_id: OWNER, earner_display_name: 'Acme Translations',
  invited_hirer_email: 'guest@example.test', hirer_email: 'guest@example.test',
}

/** An event as App.jsx's owner shaping produces it, from a raw row. */
const ownerShaped = (id, actorId) => ({
  id, type: 'contract.cancelled', created_at: '2026-11-16T12:00:00.000Z',
  actorLabel: 'by (legacy label)', claimant: claimantOfActorId(actorId, OWNER), reason: null,
})

const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('AgreementView — a cancellation row', () => {
  const render = events => textOf(renderToStaticMarkup(React.createElement(AgreementView, {
    contract: CONTRACT, events, viewerRole: 'owner', busy: false, error: null,
  })))

  it('names the owner, a guest, and falls back to "a party" for an unknown actor', () => {
    const text = render([
      ownerShaped('e1', OWNER),
      ownerShaped('e2', 'guest:guest@example.test'),
      ownerShaped('e3', 'user'),        // a legacy actor id: identifies nobody
      ownerShaped('e4', null),
    ])
    expect(text).toContain('Cancellation claimed by you · not confirmed')
    expect(text).toContain('Cancellation claimed by guest@example.test · not confirmed')
    expect(text.match(/Cancellation claimed by a party · not confirmed/g)).toHaveLength(2)
  })

  it('never shows a bare "Cancelled", and does not repeat the name beside the label', () => {
    const text = render([ownerShaped('e1', OWNER)])
    expect(text).not.toMatch(/\bCancelled\b/)
    expect(text).not.toContain('by (legacy label)')
  })

  it('takes a non-string claimant as unknown rather than stringifying it', () => {
    const text = render([{ ...ownerShaped('e1', OWNER), claimant: { label: 'x' } }])
    expect(text).toContain('Cancellation claimed by a party · not confirmed')
    expect(text).not.toContain('[object Object]')
  })
})

describe('GuestEvidenceView — a cancellation row', () => {
  const event = (id, actor) => ({
    id, type: 'contract.cancelled', created_at: '2026-11-16T12:00:00.000Z',
    actor, payload: {}, integrity: { hash_valid: true, chain_linked: true },
  })
  const render = events => textOf(renderToStaticMarkup(React.createElement(GuestEvidenceView, {
    evidence: {
      contract: { ...CONTRACT, viewer_role: 'receiver' },
      accepted_agreement: null,
      chain: { event_count: events.length, client_asserted: 0, server_attested: events.length, verified: true, truncated: false },
      events,
    },
  })))

  it('names the earner and the guest, and never names an unknown or legacy actor', () => {
    const text = render([
      event('e1', { id: OWNER, role: 'earner', label: 'Acme Translations' }),
      event('e2', { id: 'guest:guest@example.test', role: 'guest_hirer', label: 'guest@example.test' }),
      event('e3', { id: null, role: 'unknown', label: 'Unknown' }),
      event('e4', { id: 'user', role: 'earner_legacy', label: 'Unverified actor' }),
    ])
    expect(text).toContain('Cancellation claimed by Acme Translations · not confirmed')
    expect(text).toContain('Cancellation claimed by you · not confirmed')
    expect(text.match(/Cancellation claimed by a party · not confirmed/g)).toHaveLength(2)
    expect(text).not.toContain('claimed by Unknown')
    expect(text).not.toContain('claimed by Unverified actor')
    expect(text).not.toMatch(/Agreement cancelled/)
  })

  it('renders a row whose actor is missing, as "a party"', () => {
    const text = render([event('e1', undefined)])
    expect(text).toContain('Cancellation claimed by a party · not confirmed')
  })
})

describe('claimantOfShapedActor / claimantOfActorId', () => {
  it('name only what the actor actually is', () => {
    expect(claimantOfActorId(OWNER, OWNER)).toBe('you')
    expect(claimantOfActorId('guest:a@b.test', OWNER)).toBe('a@b.test')
    expect(claimantOfActorId('guest:', OWNER)).toBeNull()
    expect(claimantOfActorId('a@b.test', OWNER)).toBeNull()
    expect(claimantOfActorId(42, OWNER)).toBeNull()
    expect(claimantOfShapedActor({ role: 'earner', label: '  ' })).toBeNull()
    expect(claimantOfShapedActor({ role: 'unknown', label: 'Unknown' })).toBeNull()
    expect(claimantOfShapedActor(null)).toBeNull()
  })
})
