import { describe, it, expect } from 'vitest'
import { idempotencyOutcome } from '../../supabase/functions/_shared/eventWriteRules.ts'

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
