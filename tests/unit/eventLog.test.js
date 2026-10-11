import { describe, it, expect, vi } from 'vitest'
import { createEvent, logEvent, GENESIS_HASH, EVENT_TYPES } from '../../src/lib/eventLog.js'

// A stand-in for supabase.functions.invoke, so the request logEvent builds can
// be inspected without a live client. The default mock reports success.
const invoke = vi.fn()

vi.mock('../../src/lib/supabase.js', async (importOriginal) => ({
  // The real invokeErrorReason, not a stand-in: it is what turns the
  // function's own refusal into the reason logEvent reports, so a mock of it
  // would test the mock. Only the client itself is replaced.
  ...(await importOriginal()),
  supabase: { functions: { invoke: (...args) => invoke(...args) } },
}))
vi.mock('../../src/lib/guestSession.js', () => ({
  getGuestAccessToken: vi.fn(() => null),
}))

// ── EVENT_TYPES ───────────────────────────────────────────────────────────────
// Guard: constant names must never be renamed without updating all callers.

describe('EVENT_TYPES', () => {
  it('contains all required contract lifecycle events', () => {
    const required = [
      'CONTRACT_INITIATED', 'CONTRACT_ACCEPTED',
      'PERFORMANCE_ASSERTED', 'PERFORMANCE_ACCEPTED', 'PERFORMANCE_REJECTED',
      'PAYMENT_RELEASED', 'CONTRACT_COMPLETED', 'CONTRACT_CANCELLED',
    ]
    for (const key of required) {
      expect(EVENT_TYPES).toHaveProperty(key)
    }
  })

  it('contains dispute events', () => {
    expect(EVENT_TYPES).toHaveProperty('DISPUTE_OPENED')
    expect(EVENT_TYPES).toHaveProperty('DISPUTE_RESOLVED')
    expect(EVENT_TYPES).toHaveProperty('DISPUTE_WON')
    expect(EVENT_TYPES).toHaveProperty('DISPUTE_LOST')
  })

  it('values are dot-separated strings (protocol format)', () => {
    for (const [, value] of Object.entries(EVENT_TYPES)) {
      expect(value).toMatch(/^[a-z]+\.[a-z_]+$/)
    }
  })
})

// ── createEvent ───────────────────────────────────────────────────────────────
// Guard: event object shape is part of the DB schema contract.
// If the shape changes, existing Supabase rows become unreadable by new code.

describe('createEvent', () => {
  const baseParams = {
    type: EVENT_TYPES.CONTRACT_INITIATED,
    contractId: 'contract-uuid-001',
    actorId: 'actor-uuid-999',
  }

  it('returns an object with all required fields', () => {
    const event = createEvent(baseParams)
    expect(event).toHaveProperty('id')
    expect(event).toHaveProperty('type')
    expect(event).toHaveProperty('contract_id')
    expect(event).toHaveProperty('actor_id')
    expect(event).toHaveProperty('payload')
    expect(event).toHaveProperty('dod_hash')
    expect(event).toHaveProperty('created_at')
  })

  it('id is a valid UUID v4', () => {
    const event = createEvent(baseParams)
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('maps contractId → contract_id (snake_case for DB)', () => {
    const event = createEvent(baseParams)
    expect(event.contract_id).toBe('contract-uuid-001')
    expect(event).not.toHaveProperty('contractId') // camelCase must not leak to DB
  })

  it('maps actorId → actor_id', () => {
    const event = createEvent(baseParams)
    expect(event.actor_id).toBe('actor-uuid-999')
  })

  it('created_at is an ISO 8601 timestamp', () => {
    const event = createEvent(baseParams)
    expect(() => new Date(event.created_at).toISOString()).not.toThrow()
  })

  it('payload defaults to empty object when not provided', () => {
    const event = createEvent(baseParams)
    expect(event.payload).toEqual({})
  })

  it('payload is preserved when provided', () => {
    const event = createEvent({ ...baseParams, payload: { step: 2, reason: 'test' } })
    expect(event.payload).toEqual({ step: 2, reason: 'test' })
  })

  it('dod_hash defaults to null when not provided', () => {
    const event = createEvent(baseParams)
    expect(event.dod_hash).toBeNull()
  })

  it('dod_hash is set when provided', () => {
    const event = createEvent({ ...baseParams, dodHash: 'sha256-abc' })
    expect(event.dod_hash).toBe('sha256-abc')
  })

  it('two events have different ids (no UUID collision)', () => {
    const a = createEvent(baseParams)
    const b = createEvent(baseParams)
    expect(a.id).not.toBe(b.id)
  })
})

// ── logEvent: what the client is allowed to say ─────────────────────────────
// Guard: the whole point of routing writes through the log-event function is
// that the browser cannot choose who an event says it came from, when it
// happened, or where it sits in the hash chain. If any of these fields ever
// reappear in the outbound request, a caller could forge evidence again.

describe('logEvent request contract', () => {
  const baseParams = {
    type: EVENT_TYPES.CONTRACT_INITIATED,
    contractId: 'contract-uuid-001',
    actorId: 'actor-uuid-999',
  }

  const okResponse = { data: { event: { id: 'server-id', type: 'contract.initiated' } }, error: null }

  it('calls the log-event Edge Function rather than inserting directly', async () => {
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent(baseParams)
    expect(invoke).toHaveBeenCalledWith('log-event', expect.anything())
  })

  it('never sends actor_id — the server derives it from credentials', async () => {
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent(baseParams)
    const { body } = invoke.mock.calls.at(-1)[1]
    expect(body).not.toHaveProperty('actor_id')
    expect(body).not.toHaveProperty('actorId')
  })

  it('never sends hash-chain fields or a timestamp', async () => {
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent(baseParams)
    const { body } = invoke.mock.calls.at(-1)[1]
    expect(body).not.toHaveProperty('event_hash')
    expect(body).not.toHaveProperty('prev_event_hash')
    expect(body).not.toHaveProperty('created_at')
  })

  it('sends only the fields the server accepts', async () => {
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent({ ...baseParams, payload: { step: 2 }, idempotencyKey: 'k1' })
    const { body } = invoke.mock.calls.at(-1)[1]
    expect(Object.keys(body).sort()).toEqual(
      ['contract_id', 'idempotency_key', 'payload', 'type']
    )
  })

  it('never sends dod_hash — the server decides which terms an assertion cites', async () => {
    // A party that could choose this could pin their assertion to a version of
    // the agreement the other side never accepted.
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent({ ...baseParams, dodHash: 'attacker-chosen-terms' })
    const { body } = invoke.mock.calls.at(-1)[1]
    expect(body).not.toHaveProperty('dod_hash')
    expect(JSON.stringify(body)).not.toContain('attacker-chosen-terms')
  })

  it('uses assertion-shaped names, not names that claim a world fact', async () => {
    // "work.submitted" could be read as "the work arrived". TrustFlow cannot
    // observe that; it can only attest that a party said so.
    expect(EVENT_TYPES.PERFORMANCE_ASSERTED).toBe('performance.asserted')
    expect(Object.values(EVENT_TYPES)).not.toContain('work.submitted')
    expect(Object.values(EVENT_TYPES)).not.toContain('work.approved')
  })

  it('returns the server-written event, not the locally built one', async () => {
    invoke.mockResolvedValueOnce(okResponse)
    const result = await logEvent(baseParams)
    expect(result.id).toBe('server-id')
  })

  it('a rejection is non-fatal but is reported, not swallowed', async () => {
    invoke.mockResolvedValueOnce({ data: { error: 'contract_not_found' }, error: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await logEvent(baseParams)
    expect(result.persisted).toBe(false)
    expect(result.persist_error).toBe('contract_not_found')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // The shape above — a 2xx carrying {error} — is not what these functions
  // actually do. They answer with a status, and supabase-js turns any non-2xx
  // into an error with data null, which is why the generic path below went
  // unnoticed: a stale deployment refused every payment.reported with
  // type_not_allowed for two weeks and the screen said only "That could not be
  // recorded", and the caller's own check for wrong_party_for_event_type could
  // never have matched anything.
  it("reports the server's reason from a non-2xx, not the library's generic message", async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'),
        { name: 'FunctionsHttpError' }),
      response: new Response(JSON.stringify({ error: 'type_not_allowed' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await logEvent(baseParams)
    expect(result.persisted).toBe(false)
    expect(result.persist_error).toBe('type_not_allowed')
    warn.mockRestore()
  })

  it('falls back to a generic reason when the failure carries no readable one', async () => {
    // A dropped connection: there is no Response to read a reason out of, and
    // inventing a specific one would be worse than admitting ignorance.
    invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('Failed to send a request to the Edge Function'),
        { name: 'FunctionsFetchError' }),
      response: undefined,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await logEvent(baseParams)
    expect(result.persisted).toBe(false)
    expect(result.persist_error).toBe('error')
    warn.mockRestore()
  })

  it('attaches the guest credential as a header when one exists for the contract', async () => {
    const { getGuestAccessToken } = await import('../../src/lib/guestSession.js')
    getGuestAccessToken.mockReturnValueOnce('guest-token-xyz')
    invoke.mockResolvedValueOnce(okResponse)
    await logEvent(baseParams)
    expect(invoke.mock.calls.at(-1)[1].headers).toEqual({ 'x-guest-access-token': 'guest-token-xyz' })
  })

  it('GENESIS_HASH is a stable, non-empty sentinel distinguishable from a real hash', () => {
    expect(GENESIS_HASH).toBe('GENESIS')
  })
})
