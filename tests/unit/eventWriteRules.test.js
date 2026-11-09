import { describe, it, expect } from 'vitest'
import {
  GUEST_ACCESS_TOKEN_TTL_DAYS, createdAtFollows, eventWriteFault, guestCredentialStillValid, idempotencyOutcome, isolationFaultLine,
} from '../../supabase/functions/_shared/eventWriteRules.ts'

// These rules are the ones log-event used to state inline, more than once
// each, with the copies disagreeing. A unit test is the only check they can
// have: every path below is a race, and an end-to-end harness walks races by
// luck or not at all.

const OWNER = '1a2b3c4d-1111-4111-8111-aaaabbbbcccc'
const GUEST = 'guest:hirer@example.invalid'

/** What the lookup actually returns: the whole row, internals included. */
const ownerEvent = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'performance.asserted',
  actor_id: OWNER,
  idempotency_key: 'k',
  payload: {
    note: 'internal — what the owner actually thinks of the counterparty',
    _actor_role: 'earner',
  },
}

describe('idempotencyOutcome — a key belongs to an operation, not a contract', () => {
  it('is a replay only when the type AND the actor are the same', () => {
    expect(idempotencyOutcome(ownerEvent, {
      type: 'performance.asserted', actorId: OWNER,
    })).toBe('replay')
  })

  it('is nothing at all when no row was found', () => {
    expect(idempotencyOutcome(null, { type: 'performance.asserted', actorId: OWNER })).toBe('none')
    expect(idempotencyOutcome(undefined, { type: 'performance.asserted', actorId: OWNER }))
      .toBe('none')
  })

  // The disclosure itself. A guest supplying a key the owner used asked for
  // their own write and received the owner's event in full.
  it("refuses the other party's event rather than handing it over", () => {
    expect(idempotencyOutcome(ownerEvent, {
      type: 'performance.accepted', actorId: GUEST,
    })).toBe('conflict')
  })

  it('refuses it even when the two parties write the same type', () => {
    expect(idempotencyOutcome(ownerEvent, {
      type: 'performance.asserted', actorId: GUEST,
    })).toBe('conflict')
  })

  it('refuses one actor reusing their own key for a different operation', () => {
    expect(idempotencyOutcome(ownerEvent, {
      type: 'performance.rejected', actorId: OWNER,
    })).toBe('conflict')
  })

  // A guest actor id is `guest:<email>`, built from a string the guest typed
  // at acceptance. Matching must be exact, or a near-miss identity reads as
  // the same actor.
  it('does not treat a near-miss actor id as the same actor', () => {
    for (const actorId of [OWNER.toUpperCase(), `${OWNER} `, OWNER.slice(0, -1), '']) {
      expect(idempotencyOutcome(ownerEvent, { type: 'performance.asserted', actorId }))
        .toBe('conflict')
    }
  })

  it('does not treat a missing actor or type on the stored row as a match', () => {
    expect(idempotencyOutcome({ type: 'performance.asserted' }, {
      type: 'performance.asserted', actorId: OWNER,
    })).toBe('conflict')
    expect(idempotencyOutcome({ actor_id: OWNER }, {
      type: 'performance.asserted', actorId: OWNER,
    })).toBe('conflict')
  })
})

describe('guestCredentialStillValid — revocation has to survive a slow request', () => {
  const TOKEN = 'fe482c1a-0000-4000-8000-0123456789ab'
  const NOW = new Date('2026-11-07T04:00:00.000Z')
  const live = {
    guest_access_token: TOKEN,
    guest_access_token_expires_at: '2026-12-01T00:00:00.000Z',
  }

  it('accepts the token the contract currently carries', () => {
    expect(guestCredentialStillValid(live, TOKEN, NOW)).toBe(true)
  })

  // The defect: reissue-guest-access overwrites the token, and a request that
  // checked the old one before the overwrite used to write after it.
  it('refuses a token the contract has since replaced', () => {
    const reissued = { ...live, guest_access_token: '6697b900-0000-4000-8000-0123456789ab' }
    expect(guestCredentialStillValid(reissued, TOKEN, NOW)).toBe(false)
  })

  it('refuses once the window has closed', () => {
    const expired = { ...live, guest_access_token_expires_at: '2026-11-07T03:59:59.999Z' }
    expect(guestCredentialStillValid(expired, TOKEN, NOW)).toBe(false)
  })

  it('accepts the instant the expiry names, and nothing past it', () => {
    const atExpiry = { ...live, guest_access_token_expires_at: NOW.toISOString() }
    expect(guestCredentialStillValid(atExpiry, TOKEN, NOW)).toBe(true)
    expect(guestCredentialStillValid(atExpiry, TOKEN, new Date(NOW.getTime() + 1))).toBe(false)
  })

  // Absent is refused, never waved through: a contract with no guest
  // credential has no counterparty who may write on it.
  it('refuses when there is nothing to compare', () => {
    expect(guestCredentialStillValid(null, TOKEN, NOW)).toBe(false)
    expect(guestCredentialStillValid(undefined, TOKEN, NOW)).toBe(false)
    expect(guestCredentialStillValid({}, TOKEN, NOW)).toBe(false)
    expect(guestCredentialStillValid(live, null, NOW)).toBe(false)
    expect(guestCredentialStillValid(live, '', NOW)).toBe(false)
    expect(guestCredentialStillValid(
      { guest_access_token: TOKEN, guest_access_token_expires_at: null }, TOKEN, NOW)).toBe(false)
  })

  it('refuses an expiry it cannot read rather than reading it as forever', () => {
    const unparseable = { ...live, guest_access_token_expires_at: 'next Tuesday' }
    expect(guestCredentialStillValid(unparseable, TOKEN, NOW)).toBe(false)
  })

  // A null token in the row must not match a null token in the header.
  it('does not let two absent credentials match each other', () => {
    expect(guestCredentialStillValid(
      { guest_access_token: null, guest_access_token_expires_at: '2026-12-01T00:00:00.000Z' },
      null, NOW)).toBe(false)
  })

  it('matches the credential exactly, not loosely', () => {
    for (const presented of [TOKEN.toUpperCase(), ` ${TOKEN}`, TOKEN.slice(0, -1), `${TOKEN}x`]) {
      expect(guestCredentialStillValid(live, presented, NOW)).toBe(false)
    }
  })
})

describe('createdAtFollows — the chain and the clock must not disagree', () => {
  const PREV = '2026-11-07T04:00:00.000Z'

  it('accepts a stamp later than its predecessor', () => {
    expect(createdAtFollows(PREV, '2026-11-07T04:00:00.001Z')).toBe(true)
    expect(createdAtFollows(PREV, '2026-11-07T04:00:01.000Z')).toBe(true)
  })

  it('accepts anything when there is no predecessor', () => {
    expect(createdAtFollows(null, '2020-01-01T00:00:00.000Z')).toBe(true)
    expect(createdAtFollows(undefined, PREV)).toBe(true)
    expect(createdAtFollows('', PREV)).toBe(true)
  })

  // The inversion. A chained successor stamped earlier than its predecessor
  // makes the tip read return the wrong row and derive_contract_state project
  // the state the inverted event names.
  it('refuses a stamp earlier than its predecessor', () => {
    expect(createdAtFollows(PREV, '2026-11-07T03:59:59.999Z')).toBe(false)
    expect(createdAtFollows(PREV, '2026-11-06T04:00:00.000Z')).toBe(false)
  })

  // Needs no skewed clock: toISOString() has millisecond resolution, and the
  // readers break a tie on a random UUID, so two equal stamps are ordered
  // arbitrarily. That is not better than an inversion, so it is refused too.
  it('refuses a stamp equal to its predecessor', () => {
    expect(createdAtFollows(PREV, PREV)).toBe(false)
  })

  it('compares instants, not strings', () => {
    // Same instant, written two legal ways. A string comparison would call
    // the second one later.
    expect(createdAtFollows('2026-11-07T04:00:00.000Z', '2026-11-07T04:00:00Z')).toBe(false)
    // An hour earlier, expressed in an offset that sorts above 'Z'.
    expect(createdAtFollows(PREV, '2026-11-07T04:00:00.000+01:00')).toBe(false)
    expect(createdAtFollows('2026-11-07T04:00:00.000+01:00', PREV)).toBe(true)
  })

  it('refuses a stamp it cannot read, on either side', () => {
    expect(createdAtFollows(PREV, 'tomorrow')).toBe(false)
    expect(createdAtFollows('tomorrow', '2026-11-07T04:00:01.000Z')).toBe(false)
    expect(createdAtFollows(PREV, '')).toBe(false)
  })
})

describe('eventWriteFault — the database\'s refusal, named once', () => {
  it('names each guard that refuses an insert', () => {
    expect(eventWriteFault('TF001')).toBe('wrong_state')
    expect(eventWriteFault('TF002')).toBe('contract_gone')
    expect(eventWriteFault('TF003')).toBe('clock_behind_chain')
    expect(eventWriteFault('23505')).toBe('tip_taken')
  })

  it('calls anything else unknown, which is a 500 and not a refusal', () => {
    // The failure mode this guards against is the opposite one: a code the
    // handler does not know being answered as a refusal the caller should
    // act on. 23503 is a foreign-key violation — a real fault, not a race.
    expect(eventWriteFault('23503')).toBe('unknown')
    // TF005 is a guard refusing to promise anything at this isolation level.
    // A server fault, deliberately not a refusal the caller is told to act on.
    expect(eventWriteFault('TF005')).toBe('unknown')
    expect(eventWriteFault('TF00')).toBe('unknown')
    expect(eventWriteFault('tf001')).toBe('unknown')
    expect(eventWriteFault(null)).toBe('unknown')
    expect(eventWriteFault(undefined)).toBe('unknown')
    expect(eventWriteFault('')).toBe('unknown')
  })
})

describe('isolationFaultLine — the refusal an operator has to see', () => {
  it('names the SQLSTATE, the place, and that it must not be retried', () => {
    const line = isolationFaultLine('log-event', {
      code: 'TF005',
      message: 'appending evidence is only guaranteed under READ COMMITTED; '
        + 'this transaction is repeatable read',
    })
    expect(line).toContain('[log-event]')
    expect(line).toContain('TF005')
    expect(line).toContain('must not be retried')
    // The level comes from the database's own message rather than being
    // re-derived here, so it has to survive into the line.
    expect(line).toContain('repeatable read')
  })

  it('is silent for every other error, including a missing one', () => {
    // The point of returning null rather than a line is that a caller can log
    // unconditionally without inventing an isolation fault out of a 23505.
    expect(isolationFaultLine('log-event', { code: 'TF002', message: 'gone' })).toBeNull()
    expect(isolationFaultLine('log-event', { code: '23505', message: 'dup' })).toBeNull()
    expect(isolationFaultLine('log-event', { message: 'no code' })).toBeNull()
    expect(isolationFaultLine('log-event', null)).toBeNull()
    expect(isolationFaultLine('log-event', undefined)).toBeNull()
  })

  it('still produces a line when the database sent no message', () => {
    expect(isolationFaultLine('reissue-guest-access', { code: 'TF005' }))
      .toContain('(no message)')
  })
})


// ── The guest credential: lifetime and comparison ───────────────────────────

describe('the guest access token lifetime', () => {
  it('is 30 days, in one place', () => {
    // Reduced from 90 (reviewer finding M3). Pinned so the number cannot drift
    // back silently, and so the two functions that mint a token keep reading it
    // from here rather than carrying their own copies, which is what they did.
    expect(GUEST_ACCESS_TOKEN_TTL_DAYS).toBe(30)
  })

  it('still outlasts a deal and a period of reading it afterwards', () => {
    // The guarantee the number has to keep: this token is the counterparty's
    // only route back to their own record, so a value small enough to be tidy
    // would lock them out of the thing the product exists to give them.
    expect(GUEST_ACCESS_TOKEN_TTL_DAYS).toBeGreaterThanOrEqual(14)
  })
})

describe('comparing a presented guest token', () => {
  const token = '8a1c3f6e-0000-4000-8000-0123456789ab'
  const row = at => ({
    guest_access_token: token,
    guest_access_token_expires_at: at,
  })
  const future = new Date(Date.now() + 86_400_000).toISOString()

  it('accepts the token it stored', () => {
    expect(guestCredentialStillValid(row(future), token)).toBe(true)
  })

  it('refuses a token that differs only in the last character', () => {
    // The case a short-circuiting compare would answer fastest, and the one a
    // constant-time compare must answer in the same time as any other.
    expect(guestCredentialStillValid(row(future), token.slice(0, -1) + 'c')).toBe(false)
  })

  it('refuses a token that differs only in the first character', () => {
    expect(guestCredentialStillValid(row(future), '9' + token.slice(1))).toBe(false)
  })

  it('refuses a truncated token, which must not match by running out', () => {
    // charCodeAt past the end is NaN; the comparison folds that to a value no
    // character shares, so a prefix cannot pass.
    expect(guestCredentialStillValid(row(future), token.slice(0, 20))).toBe(false)
    expect(guestCredentialStillValid(row(future), '')).toBe(false)
  })

  it('refuses a token with the right prefix and extra characters', () => {
    expect(guestCredentialStillValid(row(future), token + 'x')).toBe(false)
  })

  it('refuses a case-folded token', () => {
    expect(guestCredentialStillValid(row(future), token.toUpperCase())).toBe(false)
  })
})
