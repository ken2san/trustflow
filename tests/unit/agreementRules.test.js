import { describe, it, expect } from 'vitest'
import {
  violationsOf, isWellFormed, deadlineFloor,
  SUPPORTED_CURRENCIES, UNRATIFIED_LIMITS, DEADLINE_TIMEZONE_SLACK_DAYS,
} from '../../supabase/functions/_shared/agreementRules.ts'

// A proposal that is well-formed, so each test can break exactly one thing.
// Every value here is within the range actually observed in production.
const WELL_FORMED = {
  project_name: 'Logo animation',
  dod: ['Deliver the animation', 'Matches the brief'],
  amount_jpy: 50000,
  currency: 'JPY',
  deadline: '2099-12-31',
  invited_hirer_email: 'client@example.com',
  earner_display_name: 'Kenji',
  performed_by: 'creator',
}

const AT = { now: new Date('2026-10-11T12:00:00Z') }

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
    ['amount zero',               { amount_jpy: 0 },                   'amount_not_positive'],
    ['amount negative',           { amount_jpy: -50000 },              'amount_not_positive'],
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

  // The tenth probe, ¥2,000,000,000, is deliberately still accepted. The
  // Progressive Trust Ladder specifies `contractLimit: null` — explicitly
  // unlimited — at level 10, so a hard ceiling here would make that tier
  // undeliverable. An amount cap is a per-account policy check against the
  // actor's level, not a question of well-formedness.
  it('still accepts an absurd amount, because no spec sets a ceiling', () => {
    expect(violationsOf({ ...WELL_FORMED, amount_jpy: 2_000_000_000 }, AT)).toEqual([])
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
    expect(violationsOf({ ...WELL_FORMED, amount_jpy: 1 }, AT)).toEqual([])
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
    expect(violationsOf({ ...WELL_FORMED, amount_jpy: 5000.5 }, AT))
      .toContain('amount_not_an_integer')
    expect(violationsOf({ ...WELL_FORMED, amount_jpy: '50000' }, AT))
      .toContain('amount_not_an_integer')
  })

  it('reports every violation at once, not just the first', () => {
    const all = violationsOf({
      project_name: '', dod: [], amount_jpy: -1, currency: 'USD',
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
  it('JPY is the only currency, matching 1466 of 1466 rows', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['JPY'])
  })

  it('the unratified limits sit well clear of every observed value', () => {
    expect(UNRATIFIED_LIMITS.projectNameMaxChars).toBeGreaterThan(44)
    expect(UNRATIFIED_LIMITS.dodMaxItems).toBeGreaterThan(3)
    expect(UNRATIFIED_LIMITS.dodItemMaxChars).toBeGreaterThan(23)
    expect(UNRATIFIED_LIMITS.displayNameMaxChars).toBeGreaterThan(28)
  })
})
