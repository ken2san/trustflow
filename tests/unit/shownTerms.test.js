import { describe, it, expect } from 'vitest'
import { shownTermsFingerprint } from '../../src/lib/contracts.js'

// WHY THIS GUARD EXISTS
// The acceptance request carries only the invite token. The server re-reads
// the contract and hashes that row, so what gets recorded is the deal as it
// stands at the click — not the deal on the guest's screen, which may have
// loaded minutes earlier. The client re-reads the invitation immediately
// before accepting and refuses when these fields differ.
//
// A guard whose failure path has never been observed is not a guard, which is
// why every field the invitation displays gets its own red case below.

const SHOWN = {
  project_name: 'Certified translation of a birth certificate',
  dod: ['translate the document', 'return a stamped PDF'],
  amount_jpy: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  earner_display_name: 'Acme Translations',
  // Not displayed as a term, and deliberately not compared: the guest may
  // type a different address, and the invited one is theirs to see, not a
  // term of the deal.
  invited_hirer_email: 'invited@example.test',
  guest_access_token: 'issued-at-acceptance',
}

describe('the terms a guest was shown', () => {
  it('matches a second read of an unchanged contract', () => {
    expect(shownTermsFingerprint({ ...SHOWN }))
      .toBe(shownTermsFingerprint({ ...SHOWN }))
  })

  it('ignores fields that are not terms', () => {
    // A re-read issues no new token and the address is not part of the deal,
    // so neither may make an unchanged agreement look edited — a false
    // refusal here blocks an acceptance that should have gone through.
    expect(shownTermsFingerprint({
      ...SHOWN,
      guest_access_token: 'something-else',
      invited_hirer_email: 'someone.else@example.test',
    })).toBe(shownTermsFingerprint(SHOWN))
  })

  const edits = [
    ['the amount is raised', { amount_jpy: 999999 }],
    ['the amount is lowered', { amount_jpy: 1 }],
    ['the currency is swapped', { currency: 'USD' }],
    ['the deadline is pulled in', { deadline: '2026-11-01' }],
    ['the deadline is removed', { deadline: null }],
    ['the project is renamed', { project_name: 'Something else entirely' }],
    ['a completion criterion is added', { dod: [...SHOWN.dod, 'and notarise it'] }],
    ['a completion criterion is dropped', { dod: ['translate the document'] }],
    ['the criteria are reordered', { dod: [...SHOWN.dod].reverse() }],
    ['which side performs is flipped', { performed_by: 'counterparty' }],
    ['the other party is renamed', { earner_display_name: 'Someone Else Ltd' }],
  ]

  for (const [label, edit] of edits) {
    it(`notices that ${label}`, () => {
      expect(shownTermsFingerprint({ ...SHOWN, ...edit }))
        .not.toBe(shownTermsFingerprint(SHOWN))
    })
  }

  it('treats a missing invitation as nothing to compare', () => {
    expect(shownTermsFingerprint(null)).toBeNull()
    expect(shownTermsFingerprint(undefined)).toBeNull()
  })

  it('does not equate an absent field with an empty one', () => {
    // `{}` and `{ dod: [] }` describe different contracts, and a comparison
    // that collapsed them would pass an edit through.
    expect(shownTermsFingerprint({ ...SHOWN, dod: [] }))
      .not.toBe(shownTermsFingerprint({ ...SHOWN, dod: null }))
  })
})
