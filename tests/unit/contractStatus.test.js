import { describe, it, expect } from 'vitest'
import {
  CONTRACT_STATES, EXPIRY_WARNING_HOURS, CLOCKS, GUEST_ACCESS_WARNING_DAYS,
  statusLabel, isTerminal, nextActionFor, groupContracts, stepForState,
  formatAmount, formatDeadline, relativeAge, deadlineStatus, clocksFor, sinceText,
} from '../../src/lib/contractStatus.js'

const NOW = new Date('2026-09-24T12:00:00.000Z')
const hoursFromNow = h => new Date(NOW.getTime() + h * 3_600_000).toISOString()

function contract(overrides = {}) {
  return {
    id: 'c1',
    project_name: 'Probe',
    amount_jpy: 1000,
    deadline: null,
    state: CONTRACT_STATES.AWAITING_ACCEPTANCE,
    invite_token_expires_at: hoursFromNow(72),
    invite_token_used_at: null,
    created_at: NOW.toISOString(),
    ...overrides,
  }
}

// ── Whose move is it ────────────────────────────────────────────────────────
// Guard: this decides what the home screen puts in front of you. Getting it
// wrong means silently hiding work that needs doing, or nagging about work
// that is legitimately someone else's.

describe('nextActionFor', () => {
  it('an accepted contract is the Earner’s move', () => {
    const action = nextActionFor(contract({ state: CONTRACT_STATES.TERMS_ACCEPTED }), NOW)
    expect(action.owner).toBe('you')
    expect(action.label).toBe('Ready for you to deliver')
  })

  it('a healthy unaccepted invite is the client’s move, not a nag', () => {
    const action = nextActionFor(contract({ invite_token_expires_at: hoursFromNow(48) }), NOW)
    expect(action.owner).toBe('client')
  })

  it('an invite close to expiry becomes the Earner’s move', () => {
    const action = nextActionFor(
      contract({ invite_token_expires_at: hoursFromNow(EXPIRY_WARNING_HOURS - 1) }), NOW)
    expect(action.owner).toBe('you')
    expect(action.label).toBe('Invite expires soon')
  })

  it('an expired invite is the Earner’s move — only they can reissue it', () => {
    const action = nextActionFor(contract({ invite_token_expires_at: hoursFromNow(-1) }), NOW)
    expect(action.owner).toBe('you')
    expect(action.label).toBe('Send a new invite')
  })

  it('a delivered contract waits on the client', () => {
    expect(nextActionFor(contract({ state: CONTRACT_STATES.DELIVERED }), NOW).owner).toBe('client')
  })

  it('terminal states belong to nobody', () => {
    expect(nextActionFor(contract({ state: CONTRACT_STATES.SETTLED }), NOW).owner).toBe('none')
    expect(nextActionFor(contract({ state: CONTRACT_STATES.CANCELLED }), NOW).owner).toBe('none')
  })

  it('an unrecognised state surfaces rather than disappearing', () => {
    const action = nextActionFor(contract({ state: 'SOMETHING_NEW' }), NOW)
    expect(action.owner).toBe('you')
    expect(action.detail).toContain('SOMETHING_NEW')
  })
})

// ── Grouping ────────────────────────────────────────────────────────────────

describe('groupContracts', () => {
  it('splits by whose move it is, not by state name', () => {
    const rows = [
      contract({ id: 'accepted', state: CONTRACT_STATES.TERMS_ACCEPTED }),
      contract({ id: 'waiting', invite_token_expires_at: hoursFromNow(48) }),
      contract({ id: 'expired', invite_token_expires_at: hoursFromNow(-2) }),
      contract({ id: 'done', state: CONTRACT_STATES.SETTLED }),
      contract({ id: 'dead', state: CONTRACT_STATES.CANCELLED }),
    ]
    const { needsYou, inProgress, completed } = groupContracts(rows, NOW)

    expect(needsYou.map(c => c.id).sort()).toEqual(['accepted', 'expired'])
    expect(inProgress.map(c => c.id)).toEqual(['waiting'])
    expect(completed.map(c => c.id).sort()).toEqual(['dead', 'done'])
  })

  it('two contracts in the same state can land in different groups', () => {
    // Both AWAITING_ACCEPTANCE — the expiry is what moves one of them.
    const rows = [
      contract({ id: 'fresh', invite_token_expires_at: hoursFromNow(70) }),
      contract({ id: 'stale', invite_token_expires_at: hoursFromNow(2) }),
    ]
    const { needsYou, inProgress } = groupContracts(rows, NOW)
    expect(needsYou.map(c => c.id)).toEqual(['stale'])
    expect(inProgress.map(c => c.id)).toEqual(['fresh'])
  })

  it('orders by soonest deadline, with undated contracts last', () => {
    const rows = [
      contract({ id: 'none', state: CONTRACT_STATES.TERMS_ACCEPTED, deadline: null }),
      contract({ id: 'late', state: CONTRACT_STATES.TERMS_ACCEPTED, deadline: '2026-12-01' }),
      contract({ id: 'soon', state: CONTRACT_STATES.TERMS_ACCEPTED, deadline: '2026-10-01' }),
    ]
    expect(groupContracts(rows, NOW).needsYou.map(c => c.id)).toEqual(['soon', 'late', 'none'])
  })

  it('handles no contracts and a missing list without throwing', () => {
    expect(groupContracts([], NOW)).toEqual({ needsYou: [], inProgress: [], completed: [] })
    expect(groupContracts(undefined, NOW)).toEqual({ needsYou: [], inProgress: [], completed: [] })
  })
})

// ── Display ─────────────────────────────────────────────────────────────────

describe('presentation helpers', () => {
  it('labels every state the system writes', () => {
    for (const state of Object.values(CONTRACT_STATES)) {
      expect(statusLabel(state)).not.toBe(state) // a real label, not the raw enum
    }
  })

  it('shows an unknown state as itself rather than blank', () => {
    expect(statusLabel('WEIRD')).toBe('WEIRD')
    expect(statusLabel(undefined)).toBe('Unknown')
  })

  it('knows which states are terminal', () => {
    expect(isTerminal(CONTRACT_STATES.SETTLED)).toBe(true)
    expect(isTerminal(CONTRACT_STATES.CANCELLED)).toBe(true)
    expect(isTerminal(CONTRACT_STATES.TERMS_ACCEPTED)).toBe(false)
  })

  it('formats amounts and deadlines, tolerating missing values', () => {
    // A JPY contract reads exactly as it always did, from either column name.
    expect(formatAmount({ amount_minor: 63500, currency: 'JPY' })).toBe('¥63,500')
    expect(formatAmount({ amount_jpy: 63500, currency: 'JPY' })).toBe('¥63,500')
    // Minor units, with the currency's own decimals. The old helper hard-coded
    // a yen sign, so this row used to read ¥1,250 for CA$12.50 — wrong symbol,
    // wrong magnitude.
    expect(formatAmount({ amount_minor: 1250, currency: 'CAD' })).toBe('CA$12.50')
    // No currency at all is an older row, and those are all JPY.
    expect(formatAmount({ amount_minor: 63500 })).toBe('¥63,500')
    // No amount is not an amount of zero: a contract for ¥0 is a different
    // claim from a contract whose amount this screen could not read.
    expect(formatAmount({})).toBe('—')
    expect(formatDeadline({ deadline: null })).toBeNull()
    expect(formatDeadline({ deadline: 'not-a-date' })).toBeNull()
    expect(formatDeadline({ deadline: '2026-11-30' })).toBeTruthy()
  })
})

// ── Opening the existing flow screen ────────────────────────────────────────

describe('stepForState', () => {
  it('opens an accepted contract past the commitment step', () => {
    expect(stepForState(CONTRACT_STATES.TERMS_ACCEPTED)).toBe(2)
    expect(stepForState(CONTRACT_STATES.IN_PROGRESS)).toBe(2)
  })

  it('opens a delivered contract at review and a settled one at the end', () => {
    expect(stepForState(CONTRACT_STATES.DELIVERED)).toBe(3)
    expect(stepForState(CONTRACT_STATES.SETTLED)).toBe(5)
  })

  it('falls back to the first step for states with no position in the flow', () => {
    expect(stepForState(CONTRACT_STATES.AWAITING_ACCEPTANCE)).toBe(1)
    expect(stepForState(CONTRACT_STATES.CANCELLED)).toBe(1)
    expect(stepForState('SOMETHING_NEW')).toBe(1)
  })
})

// ── Direction and correction ────────────────────────────────────────────────
// The same state means opposite things to the two sides, and TERMS_ACCEPTED
// means two different things depending on whether a correction was asked for.

describe('status follows the functional role', () => {
  const accepted = extra => contract({ state: CONTRACT_STATES.TERMS_ACCEPTED, ...extra })
  const asserted = extra => contract({ state: CONTRACT_STATES.AWAITING_CONFIRMATION, ...extra })

  it('tells the performer to deliver and the receiver to wait', () => {
    expect(nextActionFor(accepted({ performed_by: 'creator' }), NOW))
      .toMatchObject({ owner: 'you', label: 'Ready for you to deliver' })
    expect(nextActionFor(accepted({ performed_by: 'counterparty' }), NOW))
      .toMatchObject({ owner: 'client', label: 'Waiting on them to deliver' })
  })

  it('tells the receiver to review and the performer to wait', () => {
    expect(nextActionFor(asserted({ performed_by: 'counterparty' }), NOW))
      .toMatchObject({ owner: 'you', label: 'Review the delivery' })
    expect(nextActionFor(asserted({ performed_by: 'creator' }), NOW))
      .toMatchObject({ owner: 'client', label: 'Waiting on them to review' })
  })

  it('defaults to the creator performing, for rows written before performed_by', () => {
    expect(nextActionFor(accepted({}), NOW)).toMatchObject({ owner: 'you' })
  })
})

describe('a requested correction is visible', () => {
  // A rejection returns the agreement to TERMS_ACCEPTED, so the state alone
  // cannot distinguish "they asked me to fix something" from "I have not
  // started". Only the last performance statement knows.
  const afterCorrection = performed_by => contract({
    state: CONTRACT_STATES.TERMS_ACCEPTED,
    performed_by,
    last_performance_type: 'performance.rejected',
  })

  it('reads as a correction for the performer, and as waiting for the receiver', () => {
    expect(nextActionFor(afterCorrection('creator'), NOW))
      .toMatchObject({ owner: 'you', label: 'Correction requested' })
    expect(nextActionFor(afterCorrection('counterparty'), NOW))
      .toMatchObject({ owner: 'client', label: 'Correction requested' })
  })

  it('labels the state from the contract, not from the bare enum', () => {
    expect(statusLabel(afterCorrection('creator'))).toBe('Correction requested')
    // Without that context the same state is just "Accepted" — which is why
    // the call sites pass the contract.
    expect(statusLabel(CONTRACT_STATES.TERMS_ACCEPTED)).toBe('Accepted')
  })

  it('goes back to ready once the performer has asserted again', () => {
    const reasserted = contract({
      state: CONTRACT_STATES.AWAITING_CONFIRMATION,
      performed_by: 'creator',
      last_performance_type: 'performance.asserted',
    })
    expect(nextActionFor(reasserted, NOW).label).toBe('Waiting on them to review')
  })
})

describe('completed agreements', () => {
  it('are finished for both sides and belong in the completed group', () => {
    const done = contract({ state: CONTRACT_STATES.PERFORMANCE_ACCEPTED })
    expect(nextActionFor(done, NOW).owner).toBe('none')
    expect(isTerminal(CONTRACT_STATES.PERFORMANCE_ACCEPTED)).toBe(true)
    expect(groupContracts([done], NOW).completed).toHaveLength(1)
  })

  it('read as completed rather than as a protocol state name', () => {
    expect(statusLabel(CONTRACT_STATES.PERFORMANCE_ACCEPTED)).toBe('Completed')
  })
})

// ── Since when, and which clock ─────────────────────────────────────────────
// Guard: every value here is a server timestamp the list query already loads.
// The failure to protect against is not an ugly string — it is a screen that
// states a time it does not have, or that shows three unrelated dates as
// though they were one.

const daysFromNow = d => new Date(NOW.getTime() + d * 86_400_000).toISOString()

describe('relativeAge', () => {
  it('is coarse on purpose, and grammatical at both ends', () => {
    expect(relativeAge(NOW.toISOString(), NOW)).toBe('today')
    expect(relativeAge(daysFromNow(-1), NOW)).toBe('yesterday')
    expect(relativeAge(daysFromNow(-4), NOW)).toBe('4 days')
    expect(relativeAge(daysFromNow(-8), NOW)).toBe('1 week')
    expect(relativeAge(daysFromNow(-20), NOW)).toBe('3 weeks')
    expect(relativeAge(daysFromNow(-70), NOW)).toBe('2 months')
  })

  it('answers null rather than a guess for what it does not know', () => {
    // last_performance_at is null both when no such event exists and when the
    // read failed. Neither of those is "since now", so nothing may be shown.
    expect(relativeAge(null, NOW)).toBeNull()
    expect(relativeAge(undefined, NOW)).toBeNull()
    expect(relativeAge('not a date', NOW)).toBeNull()
  })

  it('does not render a future stamp as a negative age', () => {
    expect(relativeAge(daysFromNow(3), NOW)).toBe('just now')
  })
})

describe('sinceText', () => {
  it('takes the "ago" suffix only where it is grammatical', () => {
    expect(sinceText({ what: 'Created', ago: '4 days' })).toBe('Created 4 days ago')
    expect(sinceText({ what: 'Created', ago: 'today' })).toBe('Created today')
    expect(sinceText({ what: 'Accepted', ago: 'yesterday' })).toBe('Accepted yesterday')
  })

  it('is null when there is no stamp to describe', () => {
    expect(sinceText(null)).toBeNull()
    expect(sinceText({ what: 'Created', ago: null })).toBeNull()
  })
})

describe('the contractual deadline', () => {
  it('reports lateness as a fact about the agreed date', () => {
    expect(deadlineStatus(contract({ deadline: '2026-09-20' }), NOW))
      .toMatchObject({ status: 'passed', days: 4, text: '4 days late' })
  })

  it('counts down only once it is close', () => {
    expect(deadlineStatus(contract({ deadline: '2026-09-27' }), NOW))
      .toMatchObject({ status: 'soon', text: '3 days left' })
    expect(deadlineStatus(contract({ deadline: '2026-12-01' }), NOW))
      .toMatchObject({ status: 'ok', text: null })
  })

  it('is absent rather than invented when no deadline was agreed', () => {
    expect(deadlineStatus(contract({ deadline: null }), NOW)).toBeNull()
  })
})

describe('clocksFor keeps the three clocks apart', () => {
  // The whole point: only `deadline` is part of what was agreed. A reader who
  // cannot tell them apart concludes the agreement lapses when a link does.
  it('labels an unaccepted invite\u2019s link separately from the deadline', () => {
    const clocks = clocksFor(contract({ deadline: '2026-10-01' }), NOW)
    expect(clocks.map(c => c.kind)).toEqual([CLOCKS.DEADLINE, CLOCKS.INVITE_LINK])
    expect(clocks.map(c => c.label)).toEqual(['Due', 'Invite link'])
  })

  it('drops the invite link once it has been used, and shows their access instead', () => {
    const accepted = contract({
      state: CONTRACT_STATES.TERMS_ACCEPTED,
      invite_token_used_at: NOW.toISOString(),
      guest_access_token_expires_at: daysFromNow(90),
    })
    expect(clocksFor(accepted, NOW).map(c => c.kind)).toEqual([CLOCKS.GUEST_ACCESS])
    expect(clocksFor(accepted, NOW)[0].label).toBe('Their access')
  })

  it('warns on the counterparty\u2019s access before they are locked out', () => {
    const nearly = contract({
      state: CONTRACT_STATES.TERMS_ACCEPTED,
      invite_token_used_at: NOW.toISOString(),
      guest_access_token_expires_at: daysFromNow(GUEST_ACCESS_WARNING_DAYS - 1),
    })
    expect(clocksFor(nearly, NOW)[0]).toMatchObject({ status: 'soon' })
  })

  it('says nothing about either credential once the agreement is over', () => {
    const done = contract({
      state: CONTRACT_STATES.PERFORMANCE_ACCEPTED,
      deadline: '2026-09-20',
      invite_token_used_at: NOW.toISOString(),
      guest_access_token_expires_at: daysFromNow(10),
    })
    const clocks = clocksFor(done, NOW)
    expect(clocks.map(c => c.kind)).toEqual([CLOCKS.DEADLINE])
    // And a finished agreement is not late. Nothing is waiting on that date.
    expect(clocks[0].text).toBeNull()
  })

  it('is empty for a contract with no dates at all', () => {
    expect(clocksFor(contract({ invite_token_expires_at: null }), NOW)).toEqual([])
    expect(clocksFor(null, NOW)).toEqual([])
  })
})

describe('nextActionFor says since when', () => {
  it('dates an unaccepted invite from when it was created, and says "Created"', () => {
    // NOT "Sent". Whether the link was ever delivered is not knowable
    // server-side, so an agreement shared with nobody must not read as sent.
    const action = nextActionFor(contract({ created_at: daysFromNow(-5) }), NOW)
    expect(sinceText(action.since)).toBe('Created 5 days ago')
    expect(JSON.stringify(action.since)).not.toContain('Sent')
  })

  it('dates a delivery from the assertion, not from the row', () => {
    const action = nextActionFor(contract({
      state: CONTRACT_STATES.AWAITING_CONFIRMATION,
      performed_by: 'creator',
      created_at: daysFromNow(-30),
      last_performance_at: daysFromNow(-2),
    }), NOW)
    expect(sinceText(action.since)).toBe('Marked delivered 2 days ago')
  })

  it('dates an accepted agreement from the acceptance event', () => {
    const action = nextActionFor(contract({
      state: CONTRACT_STATES.TERMS_ACCEPTED,
      performed_by: 'creator',
      accepted_at: daysFromNow(-3),
    }), NOW)
    expect(sinceText(action.since)).toBe('Accepted 3 days ago')
  })

  it('dates a correction from when it was asked for', () => {
    const action = nextActionFor(contract({
      state: CONTRACT_STATES.TERMS_ACCEPTED,
      performed_by: 'creator',
      last_performance_type: 'performance.rejected',
      last_performance_at: daysFromNow(-1),
    }), NOW)
    expect(action.label).toBe('Correction requested')
    expect(sinceText(action.since)).toBe('Asked yesterday')
  })

  it('shows nothing where the stamp is missing, and never falls back to now', () => {
    const action = nextActionFor(contract({
      state: CONTRACT_STATES.AWAITING_CONFIRMATION,
      performed_by: 'creator',
      last_performance_at: null,
    }), NOW)
    expect(action.since).toBeNull()
    expect(sinceText(action.since)).toBeNull()
  })

  it('never says the invitation was sent or opened, in any invite branch', () => {
    // Delivery is manual and client-side, so the server cannot observe it.
    // ADA found "Invite sent." surviving the first pass at this, which is why
    // the guard is now over every branch rather than over the one word.
    const branches = [
      contract({ state: CONTRACT_STATES.DRAFTING }),
      contract({ invite_token_used_at: NOW.toISOString() }),
      contract({ invite_token_expires_at: null }),
      contract({ invite_token_expires_at: hoursFromNow(-1) }),
      contract({ invite_token_expires_at: hoursFromNow(6) }),
      contract({ invite_token_expires_at: hoursFromNow(48) }),
    ]
    for (const c of branches) {
      const action = nextActionFor(c, NOW)
      const words = `${action.detail ?? ''} ${action.since?.what ?? ''}`
      expect(words).not.toMatch(/\bsent\b/i)
      // And not "opened" either: `invite_token_used_at` is stamped when the
      // invitation is consumed at acceptance, so it never meant opened. Codex
      // pointed out the first version of this guard would have let that one
      // back in.
      expect(words).not.toMatch(/\bopened\b/i)
    }
  })

  it('has no since for an agreement that is over', () => {
    expect(nextActionFor(contract({ state: CONTRACT_STATES.PERFORMANCE_ACCEPTED }), NOW).since).toBeNull()
    expect(nextActionFor(contract({ state: CONTRACT_STATES.CANCELLED }), NOW).since).toBeNull()
  })
})

// ── Calendar days, not elapsed hours ───────────────────────────────────────
// Guard: a day is 23 or 25 hours on a DST change, and "today"/"yesterday" are
// calendar words. Dividing elapsed milliseconds by 86,400,000 got both wrong
// and said "today" about a day that had ended.

describe('days are counted as calendar days', () => {
  // These instants are built with the LOCAL-time constructor on purpose, so
  // the test means the same thing in every zone the suite runs in. An earlier
  // version hard-coded Toronto's UTC offsets and would have passed vacuously
  // on a UTC runner — Codex caught that, and a test whose premise depends on
  // an unset environment variable is not a test.

  it('an event an hour before midnight is yesterday, not today', () => {
    // One hour apart, either side of local midnight. This is the case that
    // elapsed-millisecond arithmetic gets wrong in every zone.
    const justBeforeMidnight = new Date(2026, 8, 23, 23, 30, 0)
    const shortlyAfter = new Date(2026, 8, 24, 0, 30, 0)
    expect(relativeAge(justBeforeMidnight.toISOString(), shortlyAfter)).toBe('yesterday')
  })

  it('still reads the same calendar day as today, however many hours apart', () => {
    expect(relativeAge(new Date(2026, 8, 24, 0, 5, 0).toISOString(),
      new Date(2026, 8, 24, 23, 55, 0))).toBe('today')
  })

  it('a deadline whose day has ended is late by one', () => {
    // In a zone that springs forward on 2026-03-08 this gap is 23.5 hours, and
    // elapsed-millisecond arithmetic floored it to zero — the original defect.
    // In a zone with no DST it is 24.5 hours, where the old arithmetic also
    // answered 1, so it is the test above that catches the bug everywhere and
    // this one that pins the DST instance of it.
    const late = deadlineStatus(contract({ deadline: '2026-03-08' }),
      new Date(2026, 2, 9, 0, 30, 0))
    expect(late.status).toBe('passed')
    expect(late.days).toBe(1)
  })
})

describe('the counterparty access clock is an instant, not a calendar day', () => {
  // The regression the DST fix introduced, and the reason the two clocks must
  // not share arithmetic: `deadline` is a date, `guest_access_token_expires_at`
  // is a moment the server enforces.
  const accepted = overrides => contract({
    state: CONTRACT_STATES.TERMS_ACCEPTED,
    invite_token_used_at: NOW.toISOString(),
    ...overrides,
  })
  const access = (contractRow, now) =>
    clocksFor(contractRow, now).find(c => c.kind === CLOCKS.GUEST_ACCESS)

  it('is not expired when it still has hours left on the same day', () => {
    const now = new Date(2026, 8, 24, 10, 0, 0)
    const clock = access(accepted({
      guest_access_token_expires_at: new Date(2026, 8, 24, 23, 0, 0).toISOString(),
    }), now)
    expect(clock.status).toBe('soon')
    expect(clock.text).not.toBe('expired')
  })

  it('is expired once the moment has passed, not once the day has', () => {
    const now = new Date(2026, 8, 24, 10, 0, 0)
    const clock = access(accepted({
      guest_access_token_expires_at: new Date(2026, 8, 24, 9, 59, 0).toISOString(),
    }), now)
    expect(clock).toMatchObject({ status: 'passed', text: 'expired' })
  })

  it('counts a day as a day, and says so in the singular', () => {
    const now = new Date(2026, 8, 24, 10, 0, 0)
    const clock = access(accepted({
      guest_access_token_expires_at: new Date(2026, 8, 25, 9, 0, 0).toISOString(),
    }), now)
    expect(clock.text).toBe('1 day left')
  })

  it('stays quiet while the credential is nowhere near running out', () => {
    const now = new Date(2026, 8, 24, 10, 0, 0)
    const clock = access(accepted({
      guest_access_token_expires_at: new Date(2026, 11, 24, 10, 0, 0).toISOString(),
    }), now)
    expect(clock).toMatchObject({ status: 'ok', text: null })
  })
})

// ── The guest's contract is a narrower object ──────────────────────────────
// It arrives shaped from guest-contract-events and carries no token stamps and
// no created_at. The screens must render less, not break.

describe('a guest-shaped contract', () => {
  const shaped = {
    id: 'c1', project_name: 'Probe', dod: [], amount_jpy: 1000, amount_minor: 1000, currency: 'JPY',
    deadline: '2026-10-01', state: CONTRACT_STATES.TERMS_ACCEPTED,
    performed_by: 'creator', earner_display_name: 'E', hirer_email: 'h@example.test',
  }

  it('yields the deadline clock alone, and no invented credential clocks', () => {
    expect(clocksFor(shaped, NOW).map(c => c.kind)).toEqual([CLOCKS.DEADLINE])
  })

  it('has no since to show, rather than a wrong one', () => {
    expect(nextActionFor(shaped, NOW).since).toBeNull()
  })
})
