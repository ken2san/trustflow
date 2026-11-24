import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// The real log-event handler on the delegated route (row 4b), in-process. The
// database is a fake: these tests pin what Edge does with each RPC answer, not
// what the RPC decides (tests/sql/delegated_append.sh covers that).

const state = vi.hoisted(() => {
  const s = {
    handler: null, env: {}, contract: null, eventReads: [], rpcCalls: [], rpcAnswers: {}, getUserCalls: 0,
    contractReads: 0,
  }
  globalThis.Deno = {
    serve: (handler) => { s.handler = handler },
    env: { get: (k) => s.env[k] },
  }
  return s
})

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.1', () => {
  const query = (table) => {
    const q = {
      select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => {
        if (table === 'contracts') { state.contractReads += 1; return { data: state.contract, error: null } }
        return state.eventReads.length ? state.eventReads.shift() : { data: null, error: null }
      },
      insert: () => { throw new Error('the delegated route must never use the generic insert') },
    }
    return q
  }
  return {
    createClient: () => ({
      from: query,
      auth: { getUser: async () => { state.getUserCalls += 1; return { data: { user: null }, error: null } } },
      rpc: async (name, args) => {
        state.rpcCalls.push({ name, args })
        const queue = state.rpcAnswers[name] ?? []
        if (queue.length) return queue.shift()
        // Every delegated request is authorized by replay first (M1); an
        // authorized grant with no earlier write answers 'none'.
        if (name === 'replay_delegated_event') return { data: { status: 'none' }, error: null }
        return { data: null, error: { code: 'XX000', message: `unexpected rpc ${name}` } }
      },
    }),
  }
})

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const CONTRACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GRANT_ID = 'cccccccc-0000-4000-8000-000000000001'
const SECRET = '7'.repeat(64)
const ANON = 'anon-public-key'

const post = (body, headers = {}) => state.handler(new Request('http://fake.invalid/functions/v1/log-event', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${ANON}`,
    'x-trustflow-grant': `${GRANT_ID}.${SECRET}`, ...headers,
  },
  body: JSON.stringify(body),
}))
const reply = async (res) => ({ status: res.status, body: await res.json() })
const write = { type: 'payment.acknowledged', contract_id: CONTRACT_ID, payload: { note: 'paid', _auth_method: 'account_session' } }
const appended = (id = 'e1') => ({ data: { status: 'appended', event: { id } }, error: null })
const status = (s) => ({ data: { status: s }, error: null })
const appendCalls = () => state.rpcCalls.filter((c) => c.name === 'append_delegated_event')

let logs
beforeAll(async () => {
  await import('../../supabase/functions/log-event/index.ts')
  expect(state.handler).toBeTypeOf('function')
})
beforeEach(() => {
  state.env = {
    ENTRY_DELEGATED_APPEND: 'on', SUPABASE_ANON_KEY: ANON,
    SUPABASE_URL: 'http://fake.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service',
  }
  state.contract = { id: CONTRACT_ID, state: 'DRAFTING', dod: ['test'], performed_by: 'creator', earner_user_id: OWNER_ID }
  state.eventReads = []
  state.rpcCalls = []
  state.rpcAnswers = {}
  state.getUserCalls = 0
  state.contractReads = 0
  logs = []
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...a) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('log-event delegated route: dispatch and admission', () => {
  it('flag off: 503 for the whole route, before any lookup or RPC', async () => {
    state.env.ENTRY_DELEGATED_APPEND = undefined
    expect(await reply(await post(write))).toEqual({ status: 503, body: { error: 'delegated_append_unavailable' } })
    expect(state.rpcCalls).toEqual([])
  })

  it('a present grant header never falls back: a user JWT alongside is mixed, refused 403, no session check', async () => {
    const r = await reply(await post(write, { Authorization: 'Bearer user-session-jwt' }))
    expect(r).toEqual({ status: 403, body: { error: 'delegation_refused' } })
    expect(state.getUserCalls).toBe(0)
    expect(state.rpcCalls).toEqual([])
  })

  it('a malformed grant header is the same 403', async () => {
    expect(await reply(await post(write, { 'x-trustflow-grant': 'nope' })))
      .toEqual({ status: 403, body: { error: 'delegation_refused' } })
  })

  it('authority fields in the body are a 400', async () => {
    expect((await reply(await post({ ...write, credential_id: GRANT_ID }))).status).toBe(400)
    expect((await reply(await post({ ...write, issuer_kind: 'owner_account' }))).status).toBe(400)
  })

  it('a float in the payload is a 400', async () => {
    expect(await reply(await post({ ...write, payload: { n: 1.5 } })))
      .toEqual({ status: 400, body: { error: 'invalid_payload' } })
  })

  it('a deal that does not exist is the uniform 403, not the legacy 404', async () => {
    state.contract = null
    expect(await reply(await post(write))).toEqual({ status: 403, body: { error: 'delegation_refused' } })
  })
})

describe('log-event delegated route: the append call', () => {
  it('sends the secret hash only, the predicted reserved fields, and answers 201', async () => {
    state.rpcAnswers.append_delegated_event = [appended()]
    const r = await reply(await post(write))
    expect(r).toEqual({ status: 201, body: { event: { id: 'e1' }, deduplicated: false } })
    const [call] = appendCalls()
    expect(call.args.p_credential_id).toBe(GRANT_ID)
    expect(call.args.p_secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(call.args)).not.toContain(SECRET)
    expect(call.args.p_performed_by).toBe('creator')
    expect(call.args.p_hashed_inputs).toEqual({ dod: ['test'], agreement: null })
    expect(call.args.p_event.payload._auth_method).toBe('entry_agent_grant')
    expect(call.args.p_event.payload._role_in_agreement).toBe('performer')
    expect(call.args.p_event.payload.note).toBe('paid')
    expect(call.args.p_event).not.toHaveProperty('credential_id')
  })

  it('a stale context is rebuilt and retried; the second call succeeds', async () => {
    state.rpcAnswers.append_delegated_event = [status('context_changed'), appended('e2')]
    expect((await reply(await post(write))).status).toBe(201)
    expect(appendCalls()).toHaveLength(2)
    expect(appendCalls()[0].args.p_event.id).not.toBe(appendCalls()[1].args.p_event.id)
  })

  it('a locked role that forbids the type after a retry is refused, never written', async () => {
    state.rpcAnswers.append_delegated_event = [status('context_changed'), status('wrong_party_for_event_type')]
    expect(await reply(await post(write))).toEqual({ status: 403, body: { error: 'wrong_party_for_event_type' } })
  })

  it('exhaustion answers from the last refusal: clock_window gives clock_skew, context_changed stays itself', async () => {
    state.rpcAnswers.append_delegated_event = Array(5).fill(status('clock_window'))
    expect(await reply(await post(write))).toEqual({ status: 409, body: { error: 'clock_skew' } })
    state.rpcAnswers.append_delegated_event = Array(5).fill(status('context_changed'))
    expect(await reply(await post(write))).toEqual({ status: 409, body: { error: 'context_changed' } })
  })

  it('grant refusals are 403; gate states and the v5 CHECK are 503', async () => {
    for (const s of ['expired', 'revoked', 'secret_mismatch', 'scope']) {
      state.rpcAnswers.append_delegated_event = [status(s)]
      expect(await reply(await post(write))).toEqual({ status: 403, body: { error: 'delegation_refused' } })
    }
    state.rpcAnswers.append_delegated_event = [status('gate_closed')]
    expect((await reply(await post(write))).status).toBe(503)
    state.rpcAnswers.append_delegated_event = [{ data: null, error: { code: '23514',
      message: 'new row for relation "events" violates check constraint "events_v5_writes_disabled"' } }]
    expect(await reply(await post(write))).toEqual({ status: 503, body: { error: 'delegated_append_unavailable' } })
  })

  it('a reserved-field mismatch is a loud 500, never retried', async () => {
    state.rpcAnswers.append_delegated_event = [status('reserved_fields_mismatch')]
    expect((await reply(await post(write))).status).toBe(500)
    expect(appendCalls()).toHaveLength(1)
    expect(logs.join('\n')).toContain('reserved_fields_mismatch')
  })

  it('a keyed retry is answered by replay before any new proposal', async () => {
    state.rpcAnswers.replay_delegated_event = [{ data: { status: 'replayed', event: { id: 'e0' } }, error: null }]
    expect(await reply(await post({ ...write, idempotency_key: 'k1' })))
      .toEqual({ status: 200, body: { event: { id: 'e0' }, deduplicated: true } })
    expect(appendCalls()).toHaveLength(0)
  })

  it('old schema: a database without the delegated RPCs (PGRST202) is a 503, never a write', async () => {
    const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    state.rpcAnswers.append_delegated_event = [missing]
    expect(await reply(await post(write))).toEqual({ status: 503, body: { error: 'delegated_append_unavailable' } })
    state.rpcAnswers.replay_delegated_event = [missing]
    expect(await reply(await post({ ...write, idempotency_key: 'k1' })))
      .toEqual({ status: 503, body: { error: 'delegated_append_unavailable' } })
    expect(appendCalls()).toHaveLength(1)
  })

  it('M1: an unauthorized grant on an existing deal is the uniform 403 before any read of the deal', async () => {
    for (const s of ['secret_mismatch', 'revoked', 'expired', 'scope', 'grant_unknown']) {
      state.contractReads = 0
      state.rpcAnswers.replay_delegated_event = [status(s)]
      expect(await reply(await post(write))).toEqual({ status: 403, body: { error: 'delegation_refused' } })
      expect(state.contractReads).toBe(0)
    }
    expect(appendCalls()).toHaveLength(0)
  })

  it('M1: the authorization call is made with a null key too, and comes first', async () => {
    state.rpcAnswers.append_delegated_event = [appended()]
    await post(write)
    expect(state.rpcCalls[0]).toMatchObject({ name: 'replay_delegated_event', args: { p_idempotency_key: null } })
  })

  it('M1: an array payload and an empty key are 400s before any RPC, whatever the deal', async () => {
    expect(await reply(await post({ ...write, payload: [] }))).toEqual({ status: 400, body: { error: 'invalid_payload' } })
    expect(await reply(await post({ ...write, idempotency_key: '' })))
      .toEqual({ status: 400, body: { error: 'invalid_idempotency_key' } })
    expect(state.rpcCalls).toEqual([])
  })

  it('M1: a null owner after authorization is refused, never a thrown 500', async () => {
    state.contract = { ...state.contract, earner_user_id: null }
    expect(await reply(await post(write))).toEqual({ status: 403, body: { error: 'delegation_refused' } })
    expect(appendCalls()).toHaveLength(0)
  })

  it('M2: a role-forbidden replay is 403, not a key-occupancy answer', async () => {
    state.rpcAnswers.replay_delegated_event = [status('wrong_party_for_event_type')]
    expect(await reply(await post({ ...write, idempotency_key: 'k1' })))
      .toEqual({ status: 403, body: { error: 'wrong_party_for_event_type' } })
  })

  it('M4: a missing gate is a 503 with a loud v5_gate_missing line, from the resolver or the trigger', async () => {
    // Replay never reads the gate; the append's resolver is where gate_missing
    // is reachable (Codex T193 nit).
    state.rpcAnswers.append_delegated_event = [status('gate_missing')]
    expect((await reply(await post(write))).status).toBe(503)
    expect(logs.join('\n')).toContain('v5_gate_missing')
    logs.length = 0
    state.rpcAnswers.append_delegated_event = [{ data: null, error: { code: 'TF012', message: 'the v5 write gate row is missing' } }]
    expect((await reply(await post(write))).status).toBe(503)
    expect(logs.join('\n')).toContain('v5_gate_missing')
  })

  it('M4: TF011 and TF014 from the writer are a loud 500 integrity fault, not a closed gate; TF010 is logged', async () => {
    for (const code of ['TF011', 'TF014', 'TF010']) {
      logs.length = 0
      state.rpcAnswers.append_delegated_event = [{ data: null, error: { code, message: 'ticket fault' } }]
      expect(await reply(await post(write))).toEqual({ status: 500, body: { error: 'insert_failed' } })
      expect(logs.join('\n')).toContain(code)
    }
    state.rpcAnswers.append_delegated_event = [{ data: null, error: { code: 'TF013', message: 'v5 writes are closed' } }]
    expect((await reply(await post(write))).status).toBe(503)
  })

  it('should-fix: TF003 from the trigger is retried as a clock refusal', async () => {
    state.rpcAnswers.append_delegated_event = [{ data: null, error: { code: 'TF003', message: 'created_at must follow' } }, appended('e3')]
    expect((await reply(await post(write))).status).toBe(201)
    state.rpcAnswers.append_delegated_event = Array(5).fill({ data: null, error: { code: 'TF003', message: 'x' } })
    expect(await reply(await post(write))).toEqual({ status: 409, body: { error: 'clock_skew' } })
  })

  it('M3: exhaustion on context_changed is logged, not silent', async () => {
    state.rpcAnswers.append_delegated_event = Array(5).fill(status('context_changed'))
    expect(await reply(await post(write))).toEqual({ status: 409, body: { error: 'context_changed' } })
    expect(logs.join('\n')).toContain('delegated_context_exhausted')
  })

  it('T193: a malformed contract id never reaches a log line; refusals log contract_id null', async () => {
    // Not a credential: a canary that would be visible if the raw body value
    // were logged. Misplaced credentials would travel the same way.
    const CANARY = 'canary-not-a-credential-7f3e9a'
    for (const contractId of [CANARY, `${CONTRACT_ID} ${CANARY}`, CONTRACT_ID.toUpperCase() + CANARY]) {
      logs.length = 0
      const res = await post({ ...write, contract_id: contractId })
      const text = await res.text()
      expect(res.status).toBe(403)
      expect(text).not.toContain(CANARY)
      expect(logs.join('\n')).not.toContain(CANARY)
      const refusal = logs.map(l => { try { return JSON.parse(l) } catch { return null } })
        .find(l => l?.delegated_refusal)
      expect(refusal).toMatchObject({ delegated_refusal: 'grant_unknown', contract_id: null })
    }
    // A malformed grant header is refused before the contract id is checked:
    // the line it writes carries null too, never the body value.
    logs.length = 0
    await post({ ...write, contract_id: CANARY }, { 'x-trustflow-grant': 'malformed' })
    expect(logs.join('\n')).not.toContain(CANARY)
    expect(state.rpcCalls).toEqual([])
  })

  it('T193: an unexpected throw on the delegated route is a generic 500 with no detail', async () => {
    // A contract id that is not a lowercase UUID makes the v5 builder throw.
    state.contract = { ...state.contract, id: 'NOT-A-UUID-canary-7f3e9a' }
    const res = await post(write)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'internal_error' })
    expect(logs.join('\n')).not.toContain('canary-7f3e9a')
  })

  it('the secret never appears in a response or a log line', async () => {
    state.rpcAnswers.append_delegated_event = [status('secret_mismatch')]
    const res = await post(write)
    expect(await res.text()).not.toContain(SECRET)
    expect(logs.join('\n')).not.toContain(SECRET)
    expect(logs.join('\n')).toContain('secret_mismatch')
  })
})
