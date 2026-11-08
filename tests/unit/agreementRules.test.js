import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  violationsOf, isWellFormed, deadlineFloor,
  SUPPORTED_CURRENCIES, UNRATIFIED_LIMITS, DEADLINE_TIMEZONE_SLACK_DAYS, AMOUNT_CEILING,
} from '../../supabase/functions/_shared/agreementRules.ts'

// A proposal that is well-formed, so each test can break exactly one thing.
// Every value here is within the range actually observed in production.
const WELL_FORMED = {
  project_name: 'Logo animation',
  dod: ['Deliver the animation', 'Matches the brief'],
  amount_jpy: 50000,
  amount_minor: 50000,
  currency: 'JPY',
  deadline: '2099-12-31',
  invited_hirer_email: 'client@example.com',
  earner_display_name: 'Kenji',
  performed_by: 'creator',
}

const AT = { now: new Date('2026-10-11T12:00:00Z') }

// The same case table scripts/check-sql-draft.mjs runs against a real
// PostgreSQL. Shared deliberately: two implementations of one rule drifting
// apart is the only production bug this project's hash chain has ever had, and
// a validation rule written twice drifts the same way. If a case is added here
// it is also checked against the database, and vice versa.
const shared = JSON.parse(
  readFileSync(new URL('../fixtures/agreementCases.json', import.meta.url), 'utf8'))

describe('the shared case table — same cases the database is checked against', () => {
  for (const { label, patch, wellFormed } of shared.cases) {
    it(`${wellFormed ? 'accepts' : 'rejects'} ${label}`, () => {
      const violations = violationsOf({ ...shared.baseline, ...patch }, AT)
      expect(violations.length === 0).toBe(wellFormed)
    })
  }

  it('documents what the database cannot express, rather than pretending it can', () => {
    // These two rules live only here and in the creation path. The reasons are
    // specific and were each confirmed against PostgreSQL 17.11, so this
    // assertion exists to stop the list being quietly emptied.
    expect(shared.sqlCannotExpress.map(r => r.label)).toEqual([
      'a single dod item over 1000 chars',
      'a deadline in the past',
    ])
    for (const { why } of shared.sqlCannotExpress) expect(why.length).toBeGreaterThan(40)
  })

  it('still enforces, here, the per-element length the database cannot', () => {
    expect(violationsOf({ ...shared.baseline, dod: ['x'.repeat(1001)] }, AT))
      .toContain('dod_item_too_long')
  })
})

describe('the baseline proposal is accepted', () => {
  it('reports no violations', () => {
    expect(violationsOf(WELL_FORMED, AT)).toEqual([])
    expect(isWellFormed(WELL_FORMED, AT)).toBe(true)
  })
})

// ── The ten probes ───────────────────────────────────────────────────────────
// On 2026-10-11 each of these went into `contracts` as a plain PostgREST insert
// and came back HTTP 201. Every one would then have been frozen into the
// agreement snapshot at acceptance and hashed into every event of the chain.
// This is the list these rules exist for, so it is tested as a list.

describe('the ten inserts that a direct POST accepted', () => {
  const probes = [
    ['deadline in the past',       { deadline: '2020-01-01' },          'deadline_in_the_past'],
    ['amount zero',               { amount_minor: 0 },                   'amount_not_positive'],
    ['amount negative',           { amount_minor: -50000 },              'amount_not_positive'],
    ['empty dod array',           { dod: [] },                         'dod_empty'],
    ['dod is a string',           { dod: 'just do it' },               'dod_not_array'],
    ['empty project_name',        { project_name: '' },                'project_name_required'],
    ['currency not JPY',          { currency: 'ZZZ' },                 'currency_unsupported'],
    ['malformed invite email',    { invited_hirer_email: 'nope' },     'invited_email_malformed'],
    ['display name 10k chars',    { earner_display_name: 'A'.repeat(10000) }, 'display_name_too_long'],
  ]

  for (const [label, patch, expected] of probes) {
    it(`now rejects ${label} with ${expected}`, () => {
      expect(violationsOf({ ...WELL_FORMED, ...patch }, AT)).toContain(expected)
    })
  }

  // The tenth probe, ¥2,000,000,000, is not asserted either way here.
  //
  // An earlier version of this test pinned it as permanently ACCEPTED, citing
  // TRUST_LADDER's `contractLimit: null` as if that settled it. Roadmap.md says
  // the trust ladder is not enforced on the DB-backed flow and lives on the
  // legacy mock surface, so that test would have frozen a mock into a
  // guarantee. A ceiling is business policy and is UNDECIDED; this module only
  // decides shape, so there is nothing here to assert about the number.
  it('treats any ceiling as an undecided policy question, not a shape rule', () => {
    expect(AMOUNT_CEILING).toBe('UNDECIDED')
    // Shape is all this layer claims: a large amount is well-FORMED. Whether
    // it is PERMITTED is a different question, asked somewhere else, and this
    // assertion deliberately does not answer it.
    expect(violationsOf({ ...WELL_FORMED, amount_minor: 2_000_000_000 }, AT))
      .not.toContain('amount_not_an_integer')
  })
})

// ── Compatibility with data that already exists ─────────────────────────────
// 1321 production contracts and 145 on E2E were audited on 2026-10-11 against
// every rule here, and all 1466 pass. These are the shapes that made that true,
// so a future change that would have required a backfill fails here first.

describe('existing data stays valid', () => {
  it('accepts a contract with no deadline — 957 of 1321 production rows have none', () => {
    expect(violationsOf({ ...WELL_FORMED, deadline: null }, AT)).toEqual([])
    expect(violationsOf({ ...WELL_FORMED, deadline: '' }, AT)).toEqual([])
    const { deadline, ...absent } = WELL_FORMED
    expect(violationsOf(absent, AT)).toEqual([])
  })

  it('accepts no display name — the column is nullable', () => {
    expect(violationsOf({ ...WELL_FORMED, earner_display_name: null }, AT)).toEqual([])
  })

  it('accepts no invited address', () => {
    expect(violationsOf({ ...WELL_FORMED, invited_hirer_email: null }, AT)).toEqual([])
  })

  it('accepts the observed maxima with room to spare', () => {
    // project_name 44, dod 3 items, dod item 23 chars, display name 28.
    expect(violationsOf({
      ...WELL_FORMED,
      project_name: 'x'.repeat(44),
      dod: ['y'.repeat(23), 'a', 'b'],
      earner_display_name: 'z'.repeat(28),
    }, AT)).toEqual([])
  })

  it('accepts the smallest amount in either project', () => {
    expect(violationsOf({ ...WELL_FORMED, amount_minor: 1, amount_jpy: 1 }, AT)).toEqual([])
  })

  it('accepts both performed_by values, and nothing else', () => {
    expect(violationsOf({ ...WELL_FORMED, performed_by: 'creator' }, AT)).toEqual([])
    expect(violationsOf({ ...WELL_FORMED, performed_by: 'counterparty' }, AT)).toEqual([])
    expect(violationsOf({ ...WELL_FORMED, performed_by: 'both' }, AT))
      .toContain('performed_by_invalid')
  })
})

// ── The deadline boundary, which is where a server rule would go wrong ──────

describe('the deadline floor allows a day of timezone slack', () => {
  // Both projects run TimeZone = UTC. A naive `deadline >= current_date` would
  // refuse "today" for a user in UTC-7, which is the same off-by-one as the
  // toISOString() bug fixed in the UI on 2026-10-11 — mirrored, and worse,
  // because the server refuses the write rather than warning about it.
  const noon = new Date('2026-10-11T12:00:00Z')

  it('slack is one day, which covers UTC-12 through UTC+14', () => {
    expect(DEADLINE_TIMEZONE_SLACK_DAYS).toBe(1)
    expect(deadlineFloor(noon)).toBe('2026-10-10')
  })

  it("accepts today in UTC", () => {
    expect(violationsOf({ ...WELL_FORMED, deadline: '2026-10-11' }, { now: noon })).toEqual([])
  })

  it('accepts yesterday in UTC, because somewhere it is still today', () => {
    expect(violationsOf({ ...WELL_FORMED, deadline: '2026-10-10' }, { now: noon })).toEqual([])
  })

  it('rejects the day before that', () => {
    expect(violationsOf({ ...WELL_FORMED, deadline: '2026-10-09' }, { now: noon }))
      .toContain('deadline_in_the_past')
  })

  it("accepts a Vancouver user's today just after UTC midnight", () => {
    // 00:30 UTC on the 11th is 17:30 on the 10th in Vancouver. Their "today"
    // is the 10th, and the write must not be refused.
    const justAfterUtcMidnight = new Date('2026-10-11T00:30:00Z')
    expect(violationsOf({ ...WELL_FORMED, deadline: '2026-10-10' },
      { now: justAfterUtcMidnight })).toEqual([])
  })

  it('rejects a malformed date rather than guessing at it', () => {
    for (const d of ['11/10/2026', '2026-13-01', 'tomorrow', '2026-10-1']) {
      expect(violationsOf({ ...WELL_FORMED, deadline: d }, AT))
        .toContain(d === '2026-13-01' ? 'deadline_malformed' : 'deadline_malformed')
    }
  })
})

// ── Per-rule failures, each proved to fire on its own ───────────────────────

describe('each rule fires independently', () => {
  it('a blank dod item is caught even among valid ones', () => {
    expect(violationsOf({ ...WELL_FORMED, dod: ['real', '   '] }, AT))
      .toContain('dod_item_blank')
  })

  it('a non-string dod item is caught', () => {
    expect(violationsOf({ ...WELL_FORMED, dod: ['real', { nested: true }] }, AT))
      .toContain('dod_item_not_string')
  })

  it('a non-integer amount is not a rounding problem to be silently fixed', () => {
    expect(violationsOf({ ...WELL_FORMED, amount_minor: 5000.5 }, AT))
      .toContain('amount_not_an_integer')
    expect(violationsOf({ ...WELL_FORMED, amount_minor: '50000' }, AT))
      .toContain('amount_not_an_integer')
  })

  it('reports every violation at once, not just the first', () => {
    const all = violationsOf({
      project_name: '', dod: [], amount_minor: -1, currency: 'ZZZ',
      deadline: '2020-01-01', invited_hirer_email: 'x', performed_by: 'nobody',
    }, AT)
    // A caller fixing one field per round trip is an agent in a retry loop.
    expect(all).toEqual([
      'project_name_required', 'dod_empty', 'amount_not_positive',
      'currency_unsupported', 'deadline_in_the_past',
      'invited_email_malformed', 'performed_by_invalid',
    ])
  })
})

describe('constants are what the rules claim', () => {
  // Was 'JPY is the only currency, matching 1466 of 1466 rows' until
  // 2026-11-08, when Kenji's real use in Canada, Hong Kong and Japan made
  // JPY-only wrong. Order matters only in that JPY is first: it is the default
  // a form starts on and what every pre-existing contract is.
  it('is the six ISO 4217 codes the product records, JPY first', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['JPY', 'CAD', 'HKD', 'USD', 'EUR', 'GBP'])
  })

  it('accepts an amount in minor units under either field name', () => {
    const cad = {
      project_name: 'p', dod: ['d'], currency: 'CAD', performed_by: 'creator',
    }
    const jpy = { ...cad, currency: 'JPY' }
    expect(violationsOf({ ...cad, amount_minor: 1250 }, AT)).toEqual([])
    // The pre-rename name, still read so a JPY caller that has not been
    // updated is not broken by the rename alone. Only JPY: amount_jpy on any
    // other currency is refused — see the normalization table below.
    expect(violationsOf({ ...jpy, amount_jpy: 1250 }, AT)).toEqual([])
    expect(violationsOf({ ...jpy, amount_minor: 1250, amount_jpy: 1250 }, AT)).toEqual([])
  })

  // THE NORMALIZATION CONTRACT, and the reason this block is a table.
  //
  // This module is the machine-readable pre-check for the database, so every
  // row below is a claim about what `contracts_fill_amount_minor` and
  // `contracts_amount_jpy_mirror_check` do. Codex checked the two against each
  // other twice on 2026-11-08 and found a mismatch each time — first that the
  // mirror was not checked at all, then that an explicit `null` was treated
  // differently here from in the trigger. Both directions of mismatch are
  // defects: refusing what the database accepts is as wrong as accepting what
  // it refuses, because a caller told "well-formed" then gets a bare
  // check_violation, and a caller told "malformed" never tries.
  // SCOPE, because "exactly" has a limit worth naming: this is about typed
  // values — an integer, an explicit null, or an absent field. It is NOT a
  // claim about arbitrary JSON. PostgREST coerces `"100"` to the integer 100
  // and accepts it; this module calls it amount_not_an_integer. The validator
  // is the stricter of the two there, which predates the currency work and is
  // the safe direction for a field that gets hashed into evidence — but it
  // means a string amount is refused here and would have been stored. Codex
  // probed both directions, 2026-11-08.
  it('accepts and refuses exactly what the database does, for typed values', () => {
    const base = { project_name: 'p', dod: ['d'], performed_by: 'creator' }
    const jpy = { ...base, currency: 'JPY' }
    const cad = { ...base, currency: 'CAD' }

    // Accepted — the server fills whichever side was left out.
    expect(violationsOf({ ...jpy, amount_minor: 100 }, AT)).toEqual([])
    expect(violationsOf({ ...jpy, amount_minor: 100, amount_jpy: null }, AT)).toEqual([])
    expect(violationsOf({ ...jpy, amount_jpy: 100 }, AT)).toEqual([])
    expect(violationsOf({ ...jpy, amount_minor: null, amount_jpy: 100 }, AT)).toEqual([])
    expect(violationsOf({ ...jpy, amount_minor: 100, amount_jpy: 100 }, AT)).toEqual([])
    expect(violationsOf({ ...cad, amount_minor: 1250 }, AT)).toEqual([])
    expect(violationsOf({ ...cad, amount_minor: 1250, amount_jpy: null }, AT)).toEqual([])

    // Refused — two amounts that disagree, resolved in neither direction.
    expect(violationsOf({ ...jpy, amount_minor: 100, amount_jpy: 200 }, AT))
      .toEqual(['amount_jpy_mirror_invalid'])
    // Refused — a cent amount in a column named after yen.
    expect(violationsOf({ ...cad, amount_minor: 1250, amount_jpy: 1250 }, AT))
      .toEqual(['amount_jpy_mirror_invalid'])
    // The number itself is well formed — it is being stated in the wrong
    // column, which is the one thing wrong with it.
    expect(violationsOf({ ...cad, amount_jpy: 1250 }, AT))
      .toEqual(['amount_jpy_mirror_invalid'])
    // Refused — no amount at all, under either name.
    expect(violationsOf({ ...jpy }, AT)).toEqual(['amount_not_an_integer'])
    // An unsupported currency says so once; the mirror is not piled on top,
    // because without a known currency there is no mirror rule to apply.
    expect(violationsOf({ ...base, currency: 'CHF', amount_jpy: 1250 }, AT))
      .toEqual(['currency_unsupported'])
  })

  it('refuses an amount past what the integer column can hold', () => {
    const base = {
      project_name: 'p', dod: ['d'], currency: 'CAD', performed_by: 'creator',
    }
    expect(violationsOf({ ...base, amount_minor: 2_147_483_647 }, AT)).toEqual([])
    // A reachable bound now that a 2-decimal currency multiplies by 100: this
    // is CA$21,474,836.48, not CA$21 billion.
    expect(violationsOf({ ...base, amount_minor: 2_147_483_648 }, AT))
      .toEqual(['amount_too_large'])
  })

  it('the unratified limits sit well clear of every observed value', () => {
    expect(UNRATIFIED_LIMITS.projectNameMaxChars).toBeGreaterThan(44)
    expect(UNRATIFIED_LIMITS.dodMaxItems).toBeGreaterThan(3)
    expect(UNRATIFIED_LIMITS.dodItemMaxChars).toBeGreaterThan(23)
    expect(UNRATIFIED_LIMITS.displayNameMaxChars).toBeGreaterThan(28)
  })
})
