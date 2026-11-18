import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GuestEvidenceView from '../../src/views/GuestEvidenceView.jsx'

// What the guest screen says a hash covers (Codex 114, blocking 2). It used to
// say every hash covered the agreement digest and a previous link, true only
// in format v4 and from v2 respectively, and that a true
// `payload_covered_by_hash` covered the details SHOWN, which are a projection
// this page cannot check. The statements now follow the formats present.

const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ')

const row = (id, version, supported = true, over = {}) => ({
  id, type: 'performance.asserted', created_at: '2026-11-16T12:00:00.000Z',
  actor: { id: null }, payload: { note: 'done' },
  integrity: {
    canonical_version: version, canonical_version_supported: supported,
    hash_valid: supported ? true : null,
    chain_linked: version >= 2 && supported ? true : null,
    substance_valid: supported && version >= 3 ? true : null,
    ...over,
  },
})

const render = (events, chain = {}) => textOf(renderToStaticMarkup(React.createElement(GuestEvidenceView, {
  evidence: {
    contract: { id: 'c1', project_name: 'Probe', earner_display_name: 'Acme' },
    accepted_agreement: null,
    events,
    chain: { event_count: events.length, verified: true, truncated: false, ...chain },
  },
})))

describe('GuestEvidenceView hash coverage wording', () => {
  it('v1 only: no previous link, no agreement digest, payload not included', () => {
    const text = render([row('a', 1)])
    expect(text).toMatch(/Format v1 hashes cover the recorded event id, type, agreement id, actor, time and completion-criteria digest, and record no link to a previous event\./)
    expect(text).not.toMatch(/agreement digest/)
    expect(text).toMatch(/Payload digest: 0 included in the hash format, 1 not included\./)
    expect(text).toMatch(/Hash format v1/)
  })

  it('v2: adds the link, still no payload or agreement digest', () => {
    const text = render([row('a', 2)])
    expect(text).toMatch(/Format v2 hashes cover the same recorded fields plus a link to the previous event\./)
    expect(text).not.toMatch(/Format v1 hashes|Format v4 hashes/)
    expect(text).toMatch(/Payload digest: 0 included in the hash format, 1 not included\./)
  })

  it('unsupported format: coverage unknown, never called covered or uncovered', () => {
    const text = render([row('a', 9, false)], { verified: false })
    expect(text).toMatch(/For 1 event in a format this build does not recognise, what the hash covers is unknown\./)
    expect(text).toMatch(/Payload digest: 0 included in the hash format, 0 not included, 1 unknown\./)
    expect(text).toMatch(/Hash format v9 · not recognised by this build/)
  })

  it('missing coverage flag: wording comes from the rows, not from the chain boolean', () => {
    // payload_covered_by_hash absent, and a v4 row: the old branch said some
    // details were uncovered whenever the flag was not true.
    const text = render([row('a', 4)])
    expect(text).toMatch(/Payload digest: 1 included in the hash format, 0 not included\./)
    expect(text).not.toMatch(/recorded but not covered/)
    expect(text).toMatch(/Format v4 hashes also cover the recorded agreement digest, which may be empty\./)
  })

  it('never says the shown details are covered, whatever the formats', () => {
    for (const events of [[row('a', 4)], [row('a', 1)], [row('a', 9, false)]]) {
      const text = render(events, { payload_covered_by_hash: true })
      expect(text).toMatch(/this page cannot check them against the committed payload digest/)
      expect(text).not.toMatch(/also covers the detail fields shown/)
      expect(text).not.toMatch(/covers its type, timing, actor and the agreement/)
    }
  })

  it('does not crash on an event without a payload', () => {
    const noPayload = { ...row('a', 4), payload: null }
    expect(() => render([noPayload])).not.toThrow()
  })
})
