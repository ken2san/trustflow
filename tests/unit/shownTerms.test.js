import { describe, it, expect } from 'vitest'
import {
  shownTermsDigest, shownTerms, SHOWN_TERMS_VERSION, SUPPORTED_SHOWN_TERMS_VERSIONS,
} from '../../supabase/functions/_shared/shownTerms.ts'

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
  amount_minor: 20000,
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
  it('matches a second read of an unchanged contract', async () => {
    expect(await shownTermsDigest({ ...SHOWN }))
      .toBe(await shownTermsDigest({ ...SHOWN }))
  })

  it('ignores fields that are not terms', async () => {
    // A re-read issues no new token and the address is not part of the deal,
    // so neither may make an unchanged agreement look edited — a false
    // refusal here blocks an acceptance that should have gone through.
    expect(await shownTermsDigest({
      ...SHOWN,
      guest_access_token: 'something-else',
      invited_hirer_email: 'someone.else@example.test',
    })).toBe(await shownTermsDigest(SHOWN))
  })

  const edits = [
    ['the amount is raised', { amount_minor: 999999 }],
    ['the amount is lowered', { amount_minor: 1 }],
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
    it(`notices that ${label}`, async () => {
      expect(await shownTermsDigest({ ...SHOWN, ...edit }))
        .not.toBe(await shownTermsDigest(SHOWN))
    })
  }

  it('never lets a missing invitation match a real one', async () => {
    // Both sides digest something rather than returning null, so a comparison
    // cannot be satisfied by having no terms at all.
    expect(await shownTermsDigest(null)).toBe(await shownTermsDigest(undefined))
    expect(await shownTermsDigest(null)).not.toBe(await shownTermsDigest(SHOWN))
  })

  it('treats an unset list of criteria and an empty one as the same contract', async () => {
    // Deliberate, and the opposite of the obvious guess: buildAgreementSnapshot
    // hashes `dod ?? []`, and the invitation renders both as nothing set. Two
    // digests for one contract would refuse an acceptance nobody edited.
    expect(await shownTermsDigest({ ...SHOWN, dod: [] }))
      .toBe(await shownTermsDigest({ ...SHOWN, dod: null }))
  })

  it('reads the same default for performed_by as the invitation renders', async () => {
    // InviteView treats an absent column as 'creator'. If the digest did not,
    // every contract predating that column would fail its own comparison.
    expect(await shownTermsDigest({ ...SHOWN, performed_by: undefined }))
      .toBe(await shownTermsDigest({ ...SHOWN, performed_by: 'creator' }))
  })

  it('ignores anything the row carries beyond the terms', async () => {
    // The browser digests the invitation response; the function digests the
    // contract row it re-read. The two objects carry different extra columns,
    // and a digest that noticed them would refuse every acceptance — the worst
    // available failure, since it would look like tampering.
    const asRowFromTheDatabase = {
      ...SHOWN,
      id: '11111111-1111-4111-8111-111111111111',
      earner_user_id: 'a-uuid',
      state: 'AWAITING_ACCEPTANCE',
      invite_token_used_at: null,
      row_version: 7,
      created_at: '2026-11-01T00:00:00.000Z',
    }
    expect(await shownTermsDigest(asRowFromTheDatabase)).toBe(await shownTermsDigest(SHOWN))
  })

  it('states its version, so a change to the format cannot pass silently', async () => {
    // Changing which fields are covered changes every digest; the version is
    // what lets a deploy accept both for a while instead of refusing everyone.
    expect(shownTerms(SHOWN).v).toBe(SHOWN_TERMS_VERSION)
    expect(await shownTermsDigest({ ...SHOWN }))
      .not.toBe(await sha256OfADifferentVersion(SHOWN))
  })
})

describe('version mismatch between a client and a server', () => {
  it('names the version explicitly rather than implying it', async () => {
    // Asking for 1 gets 1, whatever this build's own default has moved to.
    // That is what lets a server verify a client one deploy behind instead of
    // reporting every one of them as having had its terms edited.
    expect(shownTerms(SHOWN, 1).v).toBe(1)
    expect(await shownTermsDigest(SHOWN, 1))
      .not.toBe(await shownTermsDigest(SHOWN, SHOWN_TERMS_VERSION))
  })

  it('answers "cannot check" rather than "they differ" for a version it does not know', async () => {
    // The distinction is the whole point: a digest is opaque, so a build that
    // assumed its own version would report every client one deploy out of step
    // as having had its terms edited — a claim about the agreement, made on
    // the strength of a release schedule.
    expect(await shownTermsDigest(SHOWN, SHOWN_TERMS_VERSION + 1)).toBeNull()
    expect(await shownTermsDigest(SHOWN, 0)).toBeNull()
    expect(shownTerms(SHOWN, 99)).toBeNull()
  })

  // ── v2, 2026-11-08: the amount moved to amount_minor ──────────────────────
  it('v2 covers the amount on a contract that is not in yen, and v1 cannot', async () => {
    // The row a CAD contract actually produces: amount_jpy is NULL for
    // anything that is not yen (20261108161000), so v1's only view of the
    // price is a column that is null before and after an edit.
    const cad = {
      ...SHOWN, amount_jpy: null, amount_minor: 1250, currency: 'CAD',
    }
    const raised = { ...cad, amount_minor: 999999 }

    expect(await shownTermsDigest(cad, 1)).toBe(await shownTermsDigest(raised, 1))
    expect(await shownTermsDigest(cad, 2)).not.toBe(await shownTermsDigest(raised, 2))
  })

  it('v2 still reads the old column when a response predates the rename', async () => {
    // Equal by database CHECK while amount_jpy is still the mirror, so a
    // response from a function deployed before 2026-11-08 produces the same
    // v2 digest as one from after it.
    expect(await shownTermsDigest({ ...SHOWN, amount_jpy: 20000 }, 2))
      .toBe(await shownTermsDigest({ ...SHOWN, amount_jpy: null, amount_minor: 20000 }, 2))
  })

  it('lists what it can verify, so a deploy can be sequenced', () => {
    expect(SUPPORTED_SHOWN_TERMS_VERSIONS).toContain(SHOWN_TERMS_VERSION)
  })
})

/** The same terms under a bumped version, to prove the version is covered. */
async function sha256OfADifferentVersion(source) {
  const { stableStringify, sha256Hex } =
    await import('../../supabase/functions/_shared/eventCanonical.ts')
  return sha256Hex(stableStringify({ ...shownTerms(source), v: SHOWN_TERMS_VERSION + 1 }))
}

// ── The published specification ─────────────────────────────────────────────
//
// docs/api/agent-protocol.md states the v2 algorithm, its exact preimage and
// its digest, so a client can be written without this repository. A
// specification nothing checks is a specification that drifts: the first
// change to BUILDERS would leave the document confidently wrong, and the
// clients it was written for would be the ones to find out, as a blanket
// `terms_changed` on every acceptance.
//
// So the vector is asserted in both directions — the implementation must
// reproduce the published strings, and the document must still contain them.
// Reading the file is the point. Pinning the constants here and trusting the
// prose to follow is exactly the drift being prevented.

describe('the digest specification published for outside clients', () => {
  const SPEC_PATH = 'docs/api/agent-protocol.md'

  /** The invitation read as the specification's reference vector gives it. */
  const VECTOR = {
    project_name: 'Translate a birth certificate',
    dod: ['Translate the document', 'Return a stamped PDF'],
    amount_minor: 125050,
    currency: 'CAD',
    deadline: '2026-12-01',
    performed_by: 'creator',
    earner_display_name: 'Acme Translations',
  }

  const PUBLISHED_PREIMAGE = '{"amount_minor":125050,"currency":"CAD",'
    + '"deadline":"2026-12-01","dod":["Translate the document","Return a stamped PDF"],'
    + '"earner_display_name":"Acme Translations","performed_by":"creator",'
    + '"project_name":"Translate a birth certificate","v":2}'

  const PUBLISHED_DIGEST =
    '438a61235d399d7dbf60fcc98882eb89065dbc55ad53d5e7b39aef96ab1f9aeb'

  async function spec() {
    const { readFile } = await import('node:fs/promises')
    return readFile(new URL(`../../${SPEC_PATH}`, import.meta.url), 'utf8')
  }

  it('serializes the reference vector to the preimage it publishes', async () => {
    const { stableStringify } =
      await import('../../supabase/functions/_shared/eventCanonical.ts')
    expect(stableStringify(shownTerms(VECTOR, 2))).toBe(PUBLISHED_PREIMAGE)
  })

  it('hashes the reference vector to the digest it publishes', async () => {
    expect(await shownTermsDigest(VECTOR, 2)).toBe(PUBLISHED_DIGEST)
  })

  it('still states that preimage and that digest', async () => {
    const text = await spec()
    expect(text).toContain(PUBLISHED_PREIMAGE)
    expect(text).toContain(PUBLISHED_DIGEST)
  })

  it('names every field the digest covers, and no field it does not', async () => {
    const text = await spec()
    // The table of sources in §1. A key the implementation covers but the
    // document omits is an outside client that cannot reproduce the digest.
    for (const key of Object.keys(shownTerms(VECTOR, 2))) {
      if (key === 'v') continue
      expect(text, `${SPEC_PATH} does not mention ${key}`).toContain(key)
    }
    // And the converse, for the two the guard deliberately excludes: they may
    // appear as exclusions, but must not be part of the hashed object.
    expect(Object.keys(shownTerms({
      ...VECTOR,
      invited_hirer_email: 'invited@example.test',
      guest_access_token: 'issued-at-acceptance',
    }, 2))).not.toContain('invited_hirer_email')
  })

  it('publishes the version floor the server actually enforces', async () => {
    const text = await spec()
    // validate-invite-token refuses a non-JPY acceptance below v2 with
    // terms_check_unsupported. A document that named a lower floor would send
    // clients into a 409 they cannot diagnose.
    expect(text).toContain('terms_check_unsupported')
    expect(text).toContain('shown_terms_version')
    expect(SUPPORTED_SHOWN_TERMS_VERSIONS).toContain(2)
  })
})
