import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const s = { handler: null, gate: '', user: null, result: null, calls: [] }
  globalThis.Deno = { serve: fn => { s.handler = fn }, env: { get: key => key === 'ENTRY_CREDENTIAL_ISSUANCE' ? s.gate : 'http://fake.invalid' } }
  return s
})
vi.mock('https://esm.sh/@supabase/supabase-js@2.99.1', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    rpc: async (name, args) => { state.calls.push({ name, args }); return state.result },
  }),
}))
const owner = '11111111-1111-4111-8111-111111111111'
const deal = '22222222-2222-4222-8222-222222222222'
const grant = '33333333-3333-4333-8333-333333333333'
const request = (body, token = 'session') => state.handler(new Request('http://fake.invalid', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))
const inDays = n => new Date(Date.now() + n * 86_400_000).toISOString()
const issue = () => ({ action: 'issue', contract_id: deal, issuer_kind: 'owner_account', scopes: ['read'], expires_at: inDays(7) })
beforeAll(async () => { await import('../../supabase/functions/manage-entry-agent-credential/index.ts') })
beforeEach(() => { state.gate = ''; state.user = { id: owner, is_anonymous: false }; state.result = { data: { status: 'issued', id: grant }, error: null }; state.calls = [] })
describe('credential issuance and revocation boundary', () => {
  it('refuses issuance with the gate off before authentication or database access', async () => {
    for (const gate of [undefined, '', 'ON', 'true', '1', ' on', 'on ']) {
      state.gate = gate
      const res = await request(issue()); expect(res.status).toBe(503); expect(state.calls).toEqual([])
    }
  })
  it('issues one secret only after the server RPC accepts, never passing the secret to it', async () => {
    state.gate = 'on'
    const res = await request(issue()); const body = await res.json()
    expect(res.status).toBe(201); expect(body.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(state.calls[0].args.p_issuer_id).toBe(owner)
    expect(state.calls[0].args.p_secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(state.calls)).not.toContain(body.secret)
  })
  it('never returns a secret when the database rejects issuance', async () => {
    state.gate = 'on'; state.result = { data: { status: 'not_authorized' }, error: null }
    const res = await request(issue()); expect(res.status).toBe(403); expect(await res.text()).not.toContain('secret')
  })
  it('rejects anonymous accounts and does not call a database function', async () => {
    state.gate = 'on'; state.user = { id: owner, is_anonymous: true }
    expect((await request(issue())).status).toBe(403); expect(state.calls).toEqual([])
  })
  it('allows issuer-authenticated revocation with issuance disabled', async () => {
    state.result = { data: { status: 'revoked' }, error: null }
    const res = await request({ action: 'revoke', contract_id: deal, id: grant })
    expect(res.status).toBe(200); expect(state.calls[0]).toEqual({ name: 'revoke_entry_agent_credential', args: { p_contract_id: deal, p_id: grant, p_issuer_id: owner } })
  })
  it('lists only through the issuer-bound metadata RPC even while issuance is disabled', async () => {
    state.result = { data: [{ id: grant, scopes: ['read'] }], error: null }
    const res = await request({ action: 'list', contract_id: deal })
    expect(res.status).toBe(200)
    expect(state.calls[0]).toEqual({ name: 'list_entry_agent_credentials', args: { p_contract_id: deal, p_issuer_id: owner } })
    expect(await res.json()).toEqual({ grants: [{ id: grant, scopes: ['read'] }] })
  })
  it('rejects malformed and unknown scope inputs before issuance', async () => {
    state.gate = 'on'
    for (const scopes of [[], ['manage'], ['read', 'read'], ['accept']]) {
      expect((await request({ ...issue(), scopes })).status).toBe(400)
    }
    expect(state.calls).toEqual([])
  })
  it('refuses expiries that are past, beyond 30 days or not a strict instant, before the database', async () => {
    state.gate = 'on'
    for (const expires_at of [inDays(-1), inDays(30.01), '9999-12-31T00:00:00Z',
      inDays(7).slice(0, 10), inDays(7).replace('Z', ''), 'tomorrow', '', Date.now() + 86_400_000, null, undefined]) {
      expect((await request({ ...issue(), expires_at })).status).toBe(400)
    }
    expect(state.calls).toEqual([])
  })
  it('refuses a calendar-impossible date inside the window instead of letting it roll over', async () => {
    state.gate = 'on'
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-02-10T00:00:00Z'))
    try {
      for (const expires_at of ['2027-02-29T00:00:00Z', '2027-02-30T00:00:00Z', '2027-02-20T24:00:00Z', '2027-02-20T12:60:00Z']) {
        expect((await request({ ...issue(), expires_at })).status).toBe(400)
      }
      expect(state.calls).toEqual([])
      expect((await request({ ...issue(), expires_at: '2027-02-28T00:00:00Z' })).status).toBe(201)
    } finally { vi.useRealTimers() }
  })
  it('passes the expiry to the database as canonical UTC, offset forms included', async () => {
    state.gate = 'on'
    const at = new Date(Date.now() + 2 * 86_400_000); at.setUTCMilliseconds(0)
    const offset = new Date(at.getTime() + 9 * 3_600_000).toISOString().replace('.000Z', '+09:00')
    expect((await request({ ...issue(), expires_at: offset })).status).toBe(201)
    expect(state.calls[0].args.p_expires_at).toBe(at.toISOString())
  })
})
