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

  it('still says that a mutual statement is stronger, without calling it proof', () => {
    // The fix must not overcorrect into implying the acknowledgement is worth
    // nothing. Both sides stating it IS the best record available here.
    const source = SOURCES['src/views/AgreementView.jsx']
    expect(source).toMatch(/Both sides have now stated it/)
    expect(source).toMatch(/cannot see the rail/)
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
    expect(source).toMatch(/Accepting closes the delivery step/)
    expect(source).toMatch(/cannot be taken back/)
  })

  it('offers the receiver a note, so a narrow acceptance can say it is narrow', () => {
    // The gap this closes: a receiver accepting two of five delivered pages had
    // no way to record that, and afterwards cannot — the remaining three can
    // never be asserted again. This adds no partial-acceptance state; it adds
    // the receiver's own words to the record that already exists.
    expect(source).toMatch(/id="accept-note"/)
    expect(source).toMatch(/Anything to note about what you are accepting/)
    // Optional, not required: a receiver with nothing to add must not be forced
    // to write something, and must not be blocked from accepting.
    expect(source).toMatch(/\(optional\)/)
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
