import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// The real log-event handler, driven in-process. `Deno.serve` is stubbed to
// capture the handler, and supabase-js is replaced by a fake whose answers each
// test sets. Nothing here reaches a network or a database.
//
// Why at this level: the owner key lookup's error used to be dropped, so a
// failed lookup read as "no earlier write" (Codex Task 86). A helper test
// shows the rule; only the handler shows the response a client gets
// (Codex Task 87).

const state = vi.hoisted(() => {
  // `eventReads` answers the handler's `events` reads in the order it makes
  // them: key pre-check, chain tip, acceptance version, then any lookup after
  // a refused insert. Unqueued reads find nothing.
  const s = { handler: null, contract: null, user: null, eventReads: [], insertResult: null, inserts: 0 }
  globalThis.Deno = {
    serve: (handler) => { s.handler = handler },
    env: { get: () => 'http://fake.invalid' },
  }
  return s
})

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.1', () => {
  // A query builder that answers per table, whatever filters it is given.
  const query = (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'contracts') return { data: state.contract, error: null }
        if (table === 'events') return state.eventReads.length ? state.eventReads.shift() : { data: null, error: null }
        return { data: null, error: null }
      },
      insert: () => { state.inserts += 1; return q },
      single: async () => state.insertResult
        ?? { data: null, error: { code: 'XX000', message: 'unexpected insert in test' } },
    }
    return q
  }
  return {
    createClient: () => ({
      from: query,
      auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
      rpc: async () => ({ data: null, error: { code: 'XX000', message: 'unexpected rpc in test' } }),
    }),
  }
})

const OWNER_ID = '1a2b3c4d-1111-4111-8111-aaaabbbbcccc'
const CONTRACT_ID = '22222222-2222-4222-8222-222222222222'
const KEY = 'cancel-k'

const post = (body) => state.handler(new Request('http://fake.invalid/functions/v1/log-event', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-session' },
  body: JSON.stringify(body),
}))

const reply = async (res) => ({ status: res.status, body: await res.json() })

beforeAll(async () => {
  await import('../../supabase/functions/log-event/index.ts')
  expect(state.handler).toBeTypeOf('function')
})

beforeEach(() => {
  state.contract = {
    id: CONTRACT_ID, state: 'TERMS_ACCEPTED', earner_user_id: OWNER_ID,
    performed_by: 'creator', hirer_email: 'guest@example.invalid',
    guest_access_token: null, guest_access_token_expires_at: null,
  }
  state.user = { id: OWNER_ID, is_anonymous: false }
  state.eventReads = []
  state.insertResult = null
  state.inserts = 0
})

describe('log-event owner key lookup, at the handler', () => {
  it('answers a failed lookup with 500 lookup_failed, not a refusal of the type', async () => {
    state.eventReads = [{ data: null, error: { code: '57014', message: 'canceling statement' } }]
    const r = await reply(await post({ type: 'contract.cancelled', contract_id: CONTRACT_ID, idempotency_key: KEY }))
    expect(r).toEqual({ status: 500, body: { error: 'lookup_failed' } })
    expect(state.inserts).toBe(0)
  })

  it('fails closed for an ordinary keyed write too, rather than inserting blind', async () => {
    state.eventReads = [{ data: null, error: { code: '57014', message: 'canceling statement' } }]
    const r = await reply(await post({ type: 'dispute.opened', contract_id: CONTRACT_ID, idempotency_key: KEY }))
    expect(r).toEqual({ status: 500, body: { error: 'lookup_failed' } })
    expect(state.inserts).toBe(0)
  })

  it('replays a recorded cancellation of the same actor', async () => {
    const existing = { id: '44444444-4444-4444-8444-444444444444', type: 'contract.cancelled', actor_id: OWNER_ID }
    state.eventReads = [{ data: existing, error: null }]
    const r = await reply(await post({ type: 'contract.cancelled', contract_id: CONTRACT_ID, idempotency_key: KEY }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ event: existing, deduplicated: true })
  })

  it('answers a collision with 409 and without the other event', async () => {
    state.eventReads = [{
      data: { id: '44444444-4444-4444-8444-444444444444', type: 'contract.cancelled', actor_id: 'guest:guest@example.invalid' },
      error: null,
    }]
    const r = await reply(await post({ type: 'contract.cancelled', contract_id: CONTRACT_ID, idempotency_key: KEY }))
    expect(r).toEqual({ status: 409, body: { error: 'idempotency_key_in_use' } })
  })

  it('refuses a cancellation the lookup found nothing for, and inserts nothing', async () => {
    const r = await reply(await post({ type: 'contract.cancelled', contract_id: CONTRACT_ID, idempotency_key: KEY }))
    expect(r).toEqual({ status: 400, body: { error: 'type_not_allowed' } })
    expect(state.inserts).toBe(0)
  })

  it('refuses an unkeyed cancellation before any lookup', async () => {
    state.contract = null // would be contract_not_found if it got that far
    const r = await reply(await post({ type: 'contract.cancelled', contract_id: CONTRACT_ID }))
    expect(r).toEqual({ status: 400, body: { error: 'type_not_allowed' } })
  })
})

// The three reads after the pre-check that used to drop their error (Task 94).
// Each now fails closed with 500 lookup_failed, as the pre-check does. The
// request is a keyed owner `dispute.opened` on a contract still awaiting
// acceptance, so no acceptance event is required to build it.
describe('log-event reads inside the write loop, at the handler', () => {
  const FAILED = { data: null, error: { code: '57014', message: 'canceling statement' } }
  const NOTHING = { data: null, error: null }
  const keyed = () => post({ type: 'dispute.opened', contract_id: CONTRACT_ID, idempotency_key: KEY })
  const own = { id: '66666666-6666-4666-8666-666666666666', type: 'dispute.opened', actor_id: OWNER_ID }

  beforeEach(() => {
    state.contract = { ...state.contract, state: 'AWAITING_ACCEPTANCE' }
  })

  it('answers lookup_failed when the chain tip read fails, and inserts nothing', async () => {
    state.eventReads = [NOTHING, FAILED]
    const r = await reply(await keyed())
    expect(r).toEqual({ status: 500, body: { error: 'lookup_failed' } })
    expect(state.inserts).toBe(0)
  })

  it('answers lookup_failed when the twin lookup after a TF001 refusal fails', async () => {
    state.eventReads = [NOTHING, NOTHING, NOTHING, FAILED]
    state.insertResult = { data: null, error: { code: 'TF001', message: 'not permitted in this state' } }
    const r = await reply(await keyed())
    expect(r).toEqual({ status: 500, body: { error: 'lookup_failed' } })
    expect(state.inserts).toBe(1)
  })

  it('still replays the twin after a TF001 refusal when the lookup succeeds', async () => {
    state.eventReads = [NOTHING, NOTHING, NOTHING, { data: own, error: null }]
    state.insertResult = { data: null, error: { code: 'TF001', message: 'not permitted in this state' } }
    const r = await reply(await keyed())
    expect(r).toEqual({ status: 200, body: { event: own, deduplicated: true } })
  })

  it('answers lookup_failed when the lookup after an idempotency-key 23505 fails', async () => {
    state.eventReads = [NOTHING, NOTHING, NOTHING, FAILED]
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "events_idempotency_idx"' } }
    const r = await reply(await keyed())
    expect(r).toEqual({ status: 500, body: { error: 'lookup_failed' } })
    expect(state.inserts).toBe(1)
  })

  it('answers 409 idempotency_key_in_use after a 23505 for another actor\'s key', async () => {
    state.eventReads = [NOTHING, NOTHING, NOTHING, { data: { ...own, actor_id: 'guest:guest@example.invalid' }, error: null }]
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "events_idempotency_idx"' } }
    const r = await reply(await keyed())
    expect(r).toEqual({ status: 409, body: { error: 'idempotency_key_in_use' } })
  })
})
