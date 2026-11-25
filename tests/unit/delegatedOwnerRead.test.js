import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildAgreementSnapshot, deriveAgreementHash, sha256Hex, stableStringify,
} from '../../supabase/functions/_shared/eventCanonical.ts'

// The real delegated-owner-read handler (row 5b), in-process. The database is a
// fake: these tests pin what Edge does with each RPC answer and what it shapes
// from an `ok` result. What the RPC decides is tests/sql/delegated_owner_read*.sh;
// the exact emitted receipt against the offline verifier is
// tests/sql/delegated_owner_read_receipt.sh.

const state = vi.hoisted(() => {
  const s = { handler: null, env: {}, rpcCalls: [], rpcAnswer: null, tableReads: 0 }
  globalThis.Deno = {
    serve: (handler) => { s.handler = handler },
    env: { get: (k) => s.env[k] },
  }
  return s
})

vi.mock('https://esm.sh/@supabase/supabase-js@2.99.1', () => ({
  createClient: () => ({
    from: () => { state.tableReads += 1; throw new Error('the read route must never read a table') },
    auth: { getUser: () => { throw new Error('no owner-session fallback') } },
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args })
      const a = state.rpcAnswer
      if (typeof a === 'function') return a()
      return a
    },
  }),
}))

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const CONTRACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GRANT_ID = 'cccccccc-0000-4000-8000-000000000001'
const SECRET = '7'.repeat(64)
const ANON = 'anon-public-key'
const CANARY = 'noncredential-canary-5b'
const ORIGIN = 'https://project-trustflow.vercel.app'

const post = (body, headers = {}, method = 'POST') => state.handler(new Request('http://fake.invalid/functions/v1/delegated-owner-read', {
  method,
  headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${ANON}`,
    'x-trustflow-grant': `${GRANT_ID}.${SECRET}`, 'x-canary': CANARY, ...headers,
  },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
}))
const reply = async (res) => ({ status: res.status, body: await res.json() })
const ok = (data) => ({ data, error: null })

const contract = {
  id: CONTRACT_ID, state: 'DRAFTING', project_name: 'P', dod: ['a'], amount_minor: 1000, amount_jpy: 1000,
  currency: 'JPY', deadline: null, performed_by: 'creator', earner_display_name: 'Owner',
}
const boundary = (over = {}) => ({
  order: 'created_at,id', total_count: 1, returned_count: 1, returned_bytes: 100, truncated: false,
  cap_events: 500, cap_bytes: 1048576, tail: null, acceptance_count: 0, acceptance_anchor: null, ...over,
})
let seq = 0
const ev = (over = {}) => {
  seq += 1
  const id = `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, '0')}`
  return {
    id, type: 'contract.initiated', contract_id: CONTRACT_ID, dod_hash: 'd'.repeat(64),
    created_at: '2026-11-24T10:00:00.000+00:00', prev_event_hash: null, payload_hash: 'p'.repeat(64),
    agreement_hash: null, hash_version: 4, credential_id: null, issuer_kind: null, event_hash: 'h'.repeat(64),
    timestamp_token_present: false, payload: { step: 1 }, canonical_inputs_complete: true, withheld: [],
    actor_id: OWNER_ID, ...over,
  }
}
const result = (events, over = {}) => ({
  status: 'ok', authorized_at: '2026-11-24T12:00:00.000+00:00', contract, events,
  read_boundary: boundary({ total_count: events.length, returned_count: events.length }), ...over,
})

let logs
beforeAll(async () => {
  await import('../../supabase/functions/delegated-owner-read/index.ts')
  expect(state.handler).toBeTypeOf('function')
})
beforeEach(() => {
  state.env = {
    ENTRY_DELEGATED_READ: 'on', SUPABASE_ANON_KEY: ANON,
    SUPABASE_URL: 'http://fake.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service',
  }
  state.rpcCalls = []
  state.rpcAnswer = ok(result([ev()]))
  state.tableReads = 0
  logs = []
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...a) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

const REFUSED = { status: 403, body: { error: 'delegation_refused' } }

describe('delegated-owner-read: route, admission and refusals', () => {
  it('flag off (absent or not exactly "on"): 503, no RPC', async () => {
    for (const v of [undefined, 'true', 'ON']) {
      state.env.ENTRY_DELEGATED_READ = v
      expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual({ status: 503, body: { error: 'delegated_read_unavailable' } })
    }
    expect(state.rpcCalls).toEqual([])
  })

  it('unsupported method: 405; OPTIONS answers the CORS preflight', async () => {
    expect((await post(null, {}, 'GET')).status).toBe(405)
    const allowed = await post(null, { Origin: ORIGIN }, 'OPTIONS')
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(allowed.headers.get('Access-Control-Allow-Headers')).toContain('x-trustflow-grant')
    const other = await post(null, { Origin: 'https://evil.example' }, 'OPTIONS')
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(state.rpcCalls).toEqual([])
  })

  it('malformed body: 400, before admission and with no RPC', async () => {
    for (const b of ['not json', [], {}, { contract_id: 'nope' }, { contract_id: CONTRACT_ID.toUpperCase() },
      { contract_id: CONTRACT_ID, extra: 1 }, { contract_id: CONTRACT_ID, credential_id: GRANT_ID }]) {
      expect(await reply(await post(b))).toEqual({ status: 400, body: { error: 'invalid_body' } })
    }
    // A malformed body is answered alike with a refused grant.
    expect(await reply(await post({}, { 'x-trustflow-grant': 'nope' }))).toEqual({ status: 400, body: { error: 'invalid_body' } })
    expect(state.rpcCalls).toEqual([])
  })

  it('absent, malformed or mixed credentials: the one 403, no RPC, no session check', async () => {
    const cases = [
      { 'x-trustflow-grant': '' },
      { 'x-trustflow-grant': 'nope' },
      { 'x-trustflow-grant': `${GRANT_ID}.${SECRET}, ${GRANT_ID}.${SECRET}` },
      { Authorization: 'Bearer user-session-jwt' },
      { Authorization: '' },
      { 'x-guest-access-token': 'g'.repeat(43) },
    ]
    for (const h of cases) expect(await reply(await post({ contract_id: CONTRACT_ID }, h))).toEqual(REFUSED)
    const none = new Request('http://fake.invalid/functions/v1/delegated-owner-read', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON}` },
      body: JSON.stringify({ contract_id: CONTRACT_ID }),
    })
    expect(await reply(await state.handler(none))).toEqual(REFUSED)
    expect(state.rpcCalls).toEqual([])
  })

  it('an empty anon key configuration admits nothing', async () => {
    state.env.SUPABASE_ANON_KEY = ''
    expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual(REFUSED)
    expect(state.rpcCalls).toEqual([])
  })

  it('one RPC, hash-only parameters; no table read', async () => {
    await post({ contract_id: CONTRACT_ID })
    expect(state.rpcCalls).toEqual([{
      name: 'read_delegated_owner_deal',
      args: { p_contract_id: CONTRACT_ID, p_credential_id: GRANT_ID, p_secret_hash: createHash('sha256').update(SECRET).digest('hex') },
    }])
    expect(JSON.stringify(state.rpcCalls)).not.toContain(SECRET)
    expect(state.tableReads).toBe(0)
  })

  it('every authorization status from the RPC is the same 403 with no detail', async () => {
    for (const s of ['malformed', 'grant_unknown', 'secret_mismatch', 'issuer_kind', 'issuer_not_owner', 'revoked', 'expired', 'scope']) {
      state.rpcAnswer = ok({ status: s })
      expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual(REFUSED)
    }
  })

  it('an RPC status outside the read vocabulary is drift: generic 500', async () => {
    for (const s of ['gate_closed', 'appended', undefined]) {
      state.rpcAnswer = ok(s === undefined ? null : { status: s })
      expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual({ status: 500, body: { error: 'internal_error' } })
    }
  })

  it('RPC absent (PGRST202): 503 with no fallback', async () => {
    state.rpcAnswer = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual({ status: 503, body: { error: 'delegated_read_unavailable' } })
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.tableReads).toBe(0)
  })

  it('an RPC error or a throw is a generic 500; the raw message reaches neither the body nor a log', async () => {
    state.rpcAnswer = { data: null, error: { code: '25P02', message: `raw detail ${CANARY}-msg` } }
    expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual({ status: 500, body: { error: 'internal_error' } })
    state.rpcAnswer = () => { throw new Error(`thrown ${CANARY}-throw`) }
    expect(await reply(await post({ contract_id: CONTRACT_ID }))).toEqual({ status: 500, body: { error: 'internal_error' } })
    expect(logs.join('\n')).not.toContain(`${CANARY}-`)
  })

  it('logs carry a fixed reason and validated ids only: never the secret, a header or the canary', async () => {
    state.rpcAnswer = ok({ status: 'revoked' })
    await post({ contract_id: CONTRACT_ID })
    await post({ contract_id: CONTRACT_ID }, { Authorization: 'Bearer user-session-jwt' })
    const all = logs.join('\n')
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(CANARY)
    expect(all).not.toContain('user-session-jwt')
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { fn: 'delegated-owner-read', delegated_read_refusal: 'revoked', contract_id: CONTRACT_ID, credential_id: GRANT_ID },
      { fn: 'delegated-owner-read', delegated_read_refusal: 'mixed_credentials', contract_id: CONTRACT_ID, credential_id: null },
    ])
  })

  it('every answer is private, no-store', async () => {
    const answers = [
      await post({ contract_id: CONTRACT_ID }),
      await post({}),
      await post({ contract_id: CONTRACT_ID }, { 'x-trustflow-grant': 'nope' }),
      await post(null, {}, 'GET'),
      await post(null, {}, 'OPTIONS'),
    ]
    state.env.ENTRY_DELEGATED_READ = undefined
    answers.push(await post({ contract_id: CONTRACT_ID }))
    for (const a of answers) expect(a.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('delegated-owner-read: the 200 envelope and its receipt', () => {
  const read = async (events, over = {}) => {
    state.rpcAnswer = ok(result(events, over))
    const r = await reply(await post({ contract_id: CONTRACT_ID }))
    expect(r.status).toBe(200)
    return r.body
  }

  it('exactly contract, events, read_boundary and receipt; contract and boundary as materialized', async () => {
    const body = await read([ev()])
    expect(Object.keys(body).sort()).toEqual(['contract', 'events', 'read_boundary', 'receipt'])
    expect(body.contract).toEqual(contract)
    expect(body.read_boundary).toEqual(boundary())
  })

  it('an empty trail: receipt null, boundary still reported', async () => {
    const body = await read([])
    expect(body.receipt).toBeNull()
    expect(body.events).toEqual([])
    expect(body.read_boundary.total_count).toBe(0)
  })

  it('stored_format classifies each row apart from canonical_inputs_complete', async () => {
    const body = await read([
      ev(),
      ev({ hash_version: 5, credential_id: GRANT_ID, issuer_kind: 'owner_account' }),
      ev({ hash_version: 99 }),
      ev({ hash_version: 4, credential_id: GRANT_ID }),
    ])
    expect(body.events.map((e) => [e.stored_format, e.canonical_inputs_complete])).toEqual([
      ['legacy', true], ['v5', true], ['unsupported', true], ['invalid', true],
    ])
  })

  it('a complete read: start first_event, tail complete, legacy and v5 blocks per version', async () => {
    const v5 = ev({ hash_version: 5, credential_id: GRANT_ID, issuer_kind: 'owner_account', timestamp_token_present: true })
    const body = await read([ev(), v5])
    expect(body.receipt.read).toEqual({ start: 'first_event', tail_complete: true, pages: 1, row_cap: 500 })
    expect(body.receipt.source).toEqual({ api: 'delegated-owner-read', issued_for_role: 'owner', authority: 'entry_agent_grant' })
    expect(body.receipt.issued_at).toBe('2026-11-24T12:00:00.000+00:00')
    expect(Object.keys(body.receipt.acts[0].canonical)).not.toContain('credential_id')
    expect(body.receipt.acts[1].canonical).toMatchObject({ credential_id: GRANT_ID, issuer_kind: 'owner_account', hash_version: 5 })
    // The token's presence crosses; its bytes were never read.
    expect(body.receipt.acts.map((a) => a.timestamp_token_present)).toEqual([false, true])
  })

  it('a capped read is never labelled complete', async () => {
    const body = await read([ev()], { read_boundary: boundary({ total_count: 600, truncated: true }) })
    expect(body.receipt.read.tail_complete).toBe(false)
    expect(body.read_boundary).toMatchObject({ total_count: 600, returned_count: 1, truncated: true })
  })

  it('a withheld actor: absent from the canonical block and declared, never substituted', async () => {
    const guest = ev({ canonical_inputs_complete: false, withheld: ['actor_id', 'payload.counterparty_email'] })
    delete guest.actor_id
    const body = await read([guest])
    const act = body.receipt.acts[0]
    expect(Object.prototype.hasOwnProperty.call(act.canonical, 'actor_id')).toBe(false)
    expect(act.canonical_withheld).toEqual(['actor_id'])
    expect(body.events[0].withheld).toEqual(['actor_id', 'payload.counterparty_email'])
    expect(JSON.stringify(body)).not.toContain('@')
  })

  it('no withheld input: no canonical_withheld key on the act', async () => {
    const body = await read([ev()])
    expect('canonical_withheld' in body.receipt.acts[0]).toBe(false)
  })

  it('no projected field the RPC did not send; idempotency key and raw token are never emitted', async () => {
    const body = await read([ev()])
    const text = JSON.stringify(body)
    expect(text).not.toContain('tsa_token')
    expect(body.receipt.acts[0].idempotency_key).toBeNull()
    expect(Object.keys(body.events[0]).sort()).toEqual([...Object.keys(ev()), 'stored_format'].sort())
  })

  describe('accepted terms', () => {
    const snapshot = buildAgreementSnapshot(contract)
    const acceptance = async (over = {}) => ev({
      type: 'dod.consent_recorded', agreement_hash: await deriveAgreementHash(contract),
      payload: { _agreement: snapshot }, ...over,
    })

    it('draft: accepted null (no_acceptance), current terms present', async () => {
      const body = await read([ev()])
      expect(body.receipt.agreement.accepted).toBeNull()
      expect(body.receipt.agreement.accepted_status).toBe('no_acceptance')
      expect(body.receipt.agreement.current.agreement_hash).toBe(await sha256Hex(stableStringify(snapshot)))
    })

    it('the anchor in the prefix: the accepted snapshot and digest', async () => {
      const a = await acceptance()
      const body = await read([ev(), a], { read_boundary: boundary({ total_count: 2, returned_count: 2, acceptance_count: 1, acceptance_anchor: { event_id: a.id, sequence: 1, in_prefix: true } }) })
      expect(body.receipt.agreement.accepted).toEqual({
        snapshot, snapshot_version: 1, agreement_hash: a.agreement_hash, acceptance_event_id: a.id,
      })
    })

    it('a contract state that suggests acceptance is not acceptance evidence', async () => {
      state.rpcAnswer = ok(result([ev()], { contract: { ...contract, state: 'ACTIVE' } }))
      const body = (await reply(await post({ contract_id: CONTRACT_ID }))).body
      expect(body.receipt.agreement).toMatchObject({ accepted: null, accepted_status: 'no_acceptance', state: 'ACTIVE' })
    })

    it('the anchor past the prefix: accepted null, outside_read_prefix (never pre-acceptance)', async () => {
      const body = await read([ev()], { read_boundary: boundary({ total_count: 600, truncated: true, acceptance_count: 1, acceptance_anchor: { event_id: 'x', sequence: 550, in_prefix: false } }) })
      expect(body.receipt.agreement).toMatchObject({ accepted: null, accepted_status: 'outside_read_prefix' })
    })

    it('a second acceptance anywhere in the deal: accepted null even if the prefix shows one', async () => {
      const a = await acceptance()
      const body = await read([a], { read_boundary: boundary({ total_count: 600, truncated: true, acceptance_count: 2, acceptance_anchor: { event_id: a.id, sequence: 0, in_prefix: true } }) })
      expect(body.receipt.agreement).toMatchObject({ accepted: null, accepted_status: 'multiple_acceptances' })
    })
  })
})
