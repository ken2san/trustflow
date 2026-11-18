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

const render = (events, chain = {}, props = {}) => textOf(renderToStaticMarkup(React.createElement(GuestEvidenceView, {
  evidence: {
    contract: { id: 'c1', project_name: 'Probe', earner_display_name: 'Acme' },
    accepted_agreement: null,
    events,
    chain: { event_count: events.length, verified: true, truncated: false, ...chain },
  },
  ...props,
})))

const BASE = 'the recorded event id, type, agreement id, actor, time and completion-criteria digest field (which may be empty)'
const PREDECESSOR = 'the recorded predecessor-hash input (the GENESIS sentinel when none is recorded)'

describe('GuestEvidenceView hash coverage wording', () => {
  it('v1 only: the hash does not bind a predecessor hash, the payload or an agreement digest', () => {
    const text = render([row('a', 1)])
    expect(text).toContain(`Format v1 hashes bind ${BASE}. They do not bind a predecessor hash, even where the row records one, nor the payload, nor an agreement digest.`)
    expect(text).toMatch(/Payload digest: 0 included in the hash format, 1 not included\./)
    expect(text).toMatch(/Hash format v1/)
  })

  // Codex 115: a record holding only one newer format must still show the
  // fields that format's sentence relies on.
  for (const [version, extra] of [
    [2, `and ${PREDECESSOR}`],
    [3, `${PREDECESSOR}, and the recorded payload-digest field (which may be empty)`],
    [4, 'the recorded payload-digest field and the recorded agreement-digest field (either may be empty)'],
  ]) {
    it(`v${version} only: the shown line is self-contained and binds recorded inputs only`, () => {
      const text = render([row('a', version)])
      expect(text).toContain(`Format v${version} hashes bind ${BASE}`)
      expect(text).toContain(extra)
      expect(text).not.toMatch(/same recorded fields|hashes also cover|link to the previous event\./)
      expect(text.match(/Format v\d hashes bind/g)).toHaveLength(1)
      // Validity is the separate checks' job (Codex 116).
      expect(text).toMatch(/The counts above report event-hash and predecessor-link checks and the server's payload check/)
      expect(text).toMatch(/Comparing recorded criteria and agreement digests to their content requires separate verification and is not included in those counts/)
    })
  }

  it('mixed v1 and v4: both lines, each complete', () => {
    const text = render([row('a', 1), row('b', 4)])
    expect(text.match(/Format v\d hashes bind the recorded event id/g)).toHaveLength(2)
    expect(text).toMatch(/Payload digest: 1 included in the hash format, 1 not included\./)
  })

  it('unsupported format: coverage unknown, never called covered or uncovered', () => {
    const text = render([row('a', 9, false)], { verified: false })
    expect(text).toMatch(/For 1 event in a format this build does not recognise, what the hash covers is unknown\./)
    expect(text).toMatch(/Payload digest: 0 included in the hash format, 0 not included, 1 unknown\./)
    expect(text).toMatch(/whether the payload is bound is unknown/)
    expect(text).toMatch(/Hash format v9 · not recognised by this build/)
  })

  it('missing coverage flag: wording comes from the rows, not from the chain boolean', () => {
    const text = render([row('a', 4)])
    expect(text).toMatch(/Payload digest: 1 included in the hash format, 0 not included\./)
    expect(text).not.toMatch(/recorded but not covered/)
  })

  it('never says the shown details are covered, whatever the formats', () => {
    for (const events of [[row('a', 4)], [row('a', 1)], [row('a', 9, false)]]) {
      const text = render(events, { payload_covered_by_hash: true })
      expect(text).toMatch(/projection of the recorded payload the server returned for this party/)
      expect(text).not.toMatch(/also covers the detail fields shown/)
      expect(text).not.toMatch(/covers its type, timing, actor and the agreement/)
    }
  })

  it('does not crash on an event without a payload', () => {
    const noPayload = { ...row('a', 4), payload: null }
    expect(() => render([noPayload])).not.toThrow()
  })
})

describe('GuestEvidenceView download explanation (Codex 115, finding 2)', () => {
  const withDownload = events => render(events, {}, { onExport: () => {} })
  const download = text => text.slice(text.indexOf('A copy of what is shown here'))

  for (const [name, events, expected, absent] of [
    ['v1', [row('a', 1)], /Format v1 and v2 hashes do not bind the payload/, /cannot\s+generally be checked/],
    ['v2', [row('a', 2)], /Format v1 and v2 hashes do not bind the payload/, /cannot\s+generally be checked/],
    ['v4', [row('a', 4)], /cannot generally be checked or recomputed from the projection/, /do not bind the payload/],
    ['unsupported', [row('a', 9, false)], /whether the payload is bound is unknown/, /do not bind the payload/],
  ]) {
    it(`${name}: says the details are a projection and what that means for this format`, () => {
      const text = download(withDownload(events))
      expect(text).toMatch(/A copy of what is shown here/)
      expect(text).toMatch(/projection of the recorded payload the server returned for this party/)
      expect(text).toMatch(expected)
      expect(text).not.toMatch(absent)
      expect(text).not.toMatch(/covers the whole payload/)
    })
  }
})
