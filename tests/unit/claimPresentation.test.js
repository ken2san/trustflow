import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// What the screens are allowed to say happened.
//
// Every rule in this file is about presentation, not storage. The write path is
// already scrupulous: log-event's ALLOWED_TYPES comment separates "what a party
// SAYS about payment" from a processor fact, guestEventView's verification notes
// state outright that the response cannot establish "that the work was performed
// or that any payment moved", and the label tables in both views carry comments
// saying these are claims.
//
// And then one string said otherwise. `payment.acknowledged` rendered as
// "Payment confirmed received" — in emerald, with a tick, with no actor in the
// sentence — which is TrustFlow reporting that money arrived. What happened is
// that the payee said it arrived. A reader cannot be expected to recover the
// difference from a source comment they will never see.
//
// These are text assertions over the view sources because the label tables are
// module-private and the risk is the literal wording. The same approach already
// guards the currency list against drifting from the migration that enforces it.

const read = path => readFileSync(path, 'utf8')

/**
 * The source with its comments removed.
 *
 * The forbidden-wording checks below have to run against what renders, not
 * against what the file says about itself: these very files explain the old
 * wording in comments, on purpose, so that nobody reintroduces it. Scanning the
 * raw text would make documenting the defect indistinguishable from committing
 * it — which is exactly what the first version of this test did.
 */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const SOURCES = {
  'src/views/AgreementView.jsx':     read('src/views/AgreementView.jsx'),
  'src/views/GuestEvidenceView.jsx': read('src/views/GuestEvidenceView.jsx'),
  'src/App.jsx':                     read('src/App.jsx'),
}

const RENDERED = Object.fromEntries(
  Object.entries(SOURCES).map(([file, source]) => [file, withoutComments(source)]))

/**
 * The rendered text with runs of whitespace collapsed.
 *
 * Prose in JSX is wrapped to the column limit, so a sentence a reader sees as
 * one line is several in the source and a plain substring match on it silently
 * fails. Two assertions in the first version of this file passed for that
 * reason rather than because the copy was right. Match prose against this.
 */
const PROSE = Object.fromEntries(
  Object.entries(RENDERED).map(([file, text]) => [file, text.replace(/\s+/g, ' ')]))

describe('a screen never states that money arrived', () => {
  // Exactly the strings that shipped, plus the near misses. Each asserts the
  // platform's own voice: no actor, and an arrival in the indicative.
  const FORBIDDEN = [
    'Payment confirmed received',
    'Confirmed payment received',
    'Payment received',
    'Payment verified',
  ]

  for (const [file, rendered] of Object.entries(RENDERED)) {
    for (const phrase of FORBIDDEN) {
      it(`${file} does not say "${phrase}"`, () => {
        const offending = rendered.split('\n').filter(line => line.includes(phrase))
        expect(offending, offending.join('\n')).toEqual([])
      })
    }
  }

  it('attributes a payment acknowledgement to the party that made it', () => {
    const source = SOURCES['src/views/AgreementView.jsx']
    // Whoever is reading, the sentence has a subject. "They reported" or "You
    // reported" — not a passive arrival.
    expect(source).toMatch(/reported receiving payment/i)
    expect(source).toMatch(/'You reported receiving payment'/)
    expect(source).toMatch(/'They reported receiving payment'/)
  })

  it('describes only the claim in hand, and invents no statement from the payer', () => {
    // MY SECOND ATTEMPT WAS WORSE THAN THE FIRST, which is why this test is
    // here. Having fixed the unattributed headline, I added "Both sides have
    // now stated it: one that it was sent, one that it arrived" — which is not
    // established. `paymentConfirmed` only means the LATEST payment event is
    // payment.acknowledged, and log-event imposes no ordering among the payment
    // types: a performer may append an acknowledgement with no payer report
    // anywhere in the record, which an API writer certainly can. So the fix for
    // one piece of false evidence presentation introduced another. Codex caught
    // it before it shipped.
    const prose = PROSE['src/views/AgreementView.jsx']
    expect(prose).not.toMatch(/Both sides have now stated/)
    expect(prose).not.toMatch(/one that it was sent/)
    // What it may say: whose statement this is, and what TrustFlow cannot see.
    expect(prose).toMatch(/the payee's statement that it arrived/)
    expect(prose).toMatch(/cannot see the rail/)
  })
})

describe('accepting a delivery says what it closes, and may say what it covers', () => {
  const source = SOURCES['src/views/AgreementView.jsx']
  const app = SOURCES['src/App.jsx']

  it('warns that acceptance ends the delivery step and cannot be undone', () => {
    // Every other action on this screen already carried a paragraph saying what
    // it does and does not establish. The single irreversible one carried none:
    // PERFORMANCE_ACCEPTED is terminal for performance — enforce_performance_order
    // refuses every later performance event — and the log is append-only.
    const prose = PROSE['src/views/AgreementView.jsx']
    expect(prose).toMatch(/Accepting closes the delivery step for this agreement completely/)
    expect(prose).toMatch(/cannot be taken back/)
  })

  it('offers the receiver an optional note on the acceptance', () => {
    // `note` was already allowlisted for this type and already rendered; only
    // the input was missing. It is a remark on the acceptance — see the test
    // below for what it must NOT be offered as.
    expect(source).toMatch(/id="accept-note"/)
    expect(source).toMatch(/Add a note to this acceptance/)
    // Optional, not required: a receiver with nothing to add must not be forced
    // to write something, and must not be blocked from accepting.
    expect(source).toMatch(/\(optional\)/)
  })

  it('never offers the note as a way to accept only part of the work', () => {
    // THE DEFECT THIS EXISTS FOR, caught by Codex in review and not by the
    // first version of this file, which asserted the note's presence and
    // called that a fix.
    //
    // My first copy's placeholder read "accepting the two pages delivered; the
    // remaining three are still outstanding", and the paragraph below it
    // offered the note and a correction request as ALTERNATIVES. Only a
    // correction request keeps the performance flow open —
    // enforce_performance_order refuses every performance event once the state
    // is PERFORMANCE_ACCEPTED. So a receiver following the example exactly
    // would forfeit the remaining three pages while believing the note had
    // reserved them: worse than the bare Accept button it replaced, because it
    // invited the mistake.
    const prose = PROSE['src/views/AgreementView.jsx']
    for (const phrase of ['still outstanding, say so', 'remaining three', 'accepting the two pages']) {
      expect(prose, phrase).not.toContain(phrase)
    }
    // No alternative framing against requesting a correction.
    expect(prose).not.toMatch(/note above,? or request a correction/)
    // And it must say outright that the note does not narrow the acceptance.
    expect(prose).toMatch(/whatever the note says/)
    expect(prose).toMatch(/does not accept part of the work/)
    expect(prose).toMatch(/request a correction instead/)
  })

  it('sends that note into the recorded event', () => {
    expect(app).toMatch(/PERFORMANCE_ACCEPTED, note \? \{ note \} : \{\}/)
  })

  it('omits an empty note rather than recording a blank statement', () => {
    // The payload is hashed. `note: ""` would put this party on record as
    // having said nothing, which is a different fact from not having spoken.
    expect(app).toMatch(/PERFORMANCE_ACCEPTED, note \? /)
    expect(app).toMatch(/PAYMENT_ACKNOWLEDGED, note \? /)
  })

  it('lets a payment acknowledgement say which money arrived', () => {
    // One transfer can cover a deposit and a balance run as two contracts —
    // the composition pattern this product is being asked to support without a
    // split-payment feature. Only the payee knows which it was.
    expect(source).toMatch(/id="ack-note"/)
    expect(source).toMatch(/What did this cover\?/)
  })
})

describe('the allowlist already carries the keys these notes land in', () => {
  // The whole reason both fixes are frontend-only: `note` was allowlisted for
  // performance.accepted and payment.acknowledged, and rendered in the trail.
  // Nothing collected it. If that allowlist ever drops the key, the note stops
  // reaching the counterparty and these screens start lying by omission.
  const guestView = readFileSync('supabase/functions/_shared/guestEventView.ts', 'utf8')

  it("keeps 'note' readable for an acceptance and a payment acknowledgement", () => {
    expect(guestView).toMatch(/'performance\.accepted':\s*\['step', 'note'\]/)
    expect(guestView).toMatch(/'payment\.acknowledged':\s*\['note'\]/)
  })
})
