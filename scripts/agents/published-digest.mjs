// The v2 shown-terms digest, implemented from the PUBLISHED SPECIFICATION.
//
//   public/agent-protocol.md §1  (served at /agent-protocol.md)
//
// WHY THIS FILE IS NOT AN IMPORT OF _shared/shownTerms.ts
// Task 14 asks whether an outside client can compute this digest from the
// document alone. A client that imports this repository's implementation
// answers an easier question and would pass even if the document were wrong.
// So everything here was written from §1 and from nothing else: no import of
// the project's canonical, its stableStringify, or its hashing. Only
// `node:crypto`, which any client has.
//
// It lives in its own file rather than inside counterparty-agent.mjs so that
// tests/unit/shownTerms.test.js can check it against BOTH published vectors —
// including the non-ASCII one, which is the case that actually breaks outside
// clients and which a single live run in CAD never touches.
//
// If this disagrees with the server, something is wrong between the document,
// this file and the server, and finding out which is the point — that is the
// only reason to keep a second implementation alive. It is not automatically
// the document's fault: a mismatch can equally be a bug here, which is why the
// unit tests hold this file against the published vectors AND against the
// server's own helper.
//
// It is also not a second runtime: rule 5 names ECMAScript JSON.stringify, so
// this shares that one dependency with the server by design. Agreement on
// these vectors is agreement on these vectors, not proof that a Python or Go
// client will match.

import { createHash } from 'node:crypto'

/**
 * Rules 1–5 of §1: keys sorted ascending, no insignificant whitespace,
 * `undefined` dropped rather than nulled, arrays in order, primitives exactly
 * as ECMAScript JSON.stringify writes them.
 *
 * JSON.stringify on a primitive is what rule 5 names, so calling it here is
 * implementing the rule, not borrowing an implementation: it is the escaping
 * behaviour the specification points at — non-ASCII literal, `"` and `\` and
 * the C0 controls escaped, nothing else.
 */
export function canonical(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map(v => canonical(v === undefined ? null : v)).join(',')}]`
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/**
 * The eight keys §1 names, from an invitation read. Defaults apply to absent
 * and null only — `??`, never a falsy test, so a zero amount stays zero.
 */
export function shownTermsV2(invitation = {}) {
  return {
    v: 2,
    project_name: invitation.project_name ?? null,
    dod: invitation.dod ?? [],
    amount_minor: invitation.amount_minor ?? invitation.amount_jpy ?? null,
    currency: invitation.currency ?? null,
    deadline: invitation.deadline ?? null,
    performed_by: invitation.performed_by ?? 'creator',
    earner_display_name: invitation.earner_display_name ?? null,
  }
}

/** The preimage string, exposed so a mismatch says which byte. */
export function preimageV2(invitation) {
  return canonical(shownTermsV2(invitation))
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of that string. */
export function digestV2(invitation) {
  return createHash('sha256').update(preimageV2(invitation), 'utf8').digest('hex')
}
