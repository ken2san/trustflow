import { describe, expect, it, vi, afterEach } from 'vitest'
import { E2E_ORIGIN, installPinnedFetch } from '../../scripts/lib/pinnedFetch.mjs'
import {
  buildProbeRow,
  classifyEventsInsertRefusal,
  parseProbeArgs,
  runDirectInsertProbe,
} from '../../scripts/probe-direct-events-insert.mjs'

const DEAL = '11111111-1111-4111-8111-111111111111'
const PUB = 'sb_publishable_test_key_123'

describe('W2b direct POST /rest/v1/events probe', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('requires exact E2E origin, valid UUID deal, explicit zero-write guard, and publishable key', () => {
    const validEnv = { VITE_SUPABASE_URL: E2E_ORIGIN, TF_E2E_PUBLISHABLE_KEY: PUB }
    expect(parseProbeArgs(['--deal', DEAL, '--approve-zero-write-probe'], validEnv)).toEqual({
      dealId: DEAL,
      pub: PUB,
    })

    for (const badOrigin of [undefined, 'https://fqgpzhwvvfsxswlnbbgg.supabase.co', `${E2E_ORIGIN}/extra`, 'http://localhost:54321']) {
      expect(() => parseProbeArgs(['--deal', DEAL, '--approve-zero-write-probe'], {
        VITE_SUPABASE_URL: badOrigin,
        TF_E2E_PUBLISHABLE_KEY: PUB,
      })).toThrow('exact E2E origin')
    }

    expect(() => parseProbeArgs(['--deal', DEAL], validEnv)).toThrow('usage:')
    expect(() => parseProbeArgs(['--deal', 'not-a-uuid', '--approve-zero-write-probe'], validEnv)).toThrow('usage:')
    expect(() => parseProbeArgs(['--deal', DEAL, '--approve-zero-write-probe'], {
      VITE_SUPABASE_URL: E2E_ORIGIN,
      TF_E2E_PUBLISHABLE_KEY: 'eyJ.legacy-jwt',
    })).toThrow('sb_publishable_')
  })

  it('classifies 42501 and 401/403 as pass, and stops on 2xx, TF triggers, constraint codes, or inconclusive responses', () => {
    expect(classifyEventsInsertRefusal(403, { code: '42501' })).toMatchObject({ outcome: 'db_refused', pass: true, stop: false })
    expect(classifyEventsInsertRefusal(401, { message: 'Unauthorized' })).toMatchObject({ outcome: 'http_refused', pass: true, stop: false })
    expect(classifyEventsInsertRefusal(403, { message: 'Forbidden' })).toMatchObject({ outcome: 'http_refused', pass: true, stop: false })

    // Trigger or constraint refusal proves privileges did NOT refuse -> FAIL + STOP.
    for (const code of ['TF001', 'TF011', '23514', '23502', '23503', '23505']) {
      expect(classifyEventsInsertRefusal(400, { code }), code).toMatchObject({
        outcome: 'privilege_bypass',
        pass: false,
        stop: true,
        code,
      })
    }
    expect(classifyEventsInsertRefusal(403, { code: 'TF011' })).toMatchObject({
      outcome: 'privilege_bypass',
      pass: false,
      stop: true,
    })

    expect(classifyEventsInsertRefusal(201, {})).toMatchObject({ outcome: 'reached_2xx', pass: false, stop: true })
    expect(classifyEventsInsertRefusal(200, {})).toMatchObject({ outcome: 'reached_2xx', pass: false, stop: true })
    expect(classifyEventsInsertRefusal(500, { error: 'raw secret leak' })).toMatchObject({
      outcome: 'inconclusive',
      pass: false,
      stop: true,
    })
  })

  it('sends exactly one pinned POST /rest/v1/events with publishable apikey, no Authorization, no grant secret, and no retries', async () => {
    const calls = []
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ code: '42501', message: 'permission denied for table events' }), { status: 403 })
    })
    installPinnedFetch()

    const res = await runDirectInsertProbe({ dealId: DEAL, pub: PUB })
    expect(res).toMatchObject({
      status: 403,
      classification: { outcome: 'db_refused', pass: true, stop: false, code: '42501' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${E2E_ORIGIN}/rest/v1/events`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.headers.get('apikey')).toBe(PUB)
    expect(calls[0].init.headers.has('authorization')).toBe(false)
    expect(calls[0].init.headers.has('x-trustflow-grant')).toBe(false)
    expect(JSON.parse(calls[0].init.body)).toEqual(buildProbeRow(DEAL))

    // Transport error is never retried and fails closed with stop: true.
    const failingFetch = vi.fn().mockRejectedValue(new Error('network drop'))
    const errRes = await runDirectInsertProbe({ dealId: DEAL, pub: PUB, fetchImpl: failingFetch })
    expect(failingFetch).toHaveBeenCalledTimes(1)
    expect(errRes).toMatchObject({
      status: null,
      classification: { outcome: 'inconclusive', pass: false, stop: true },
    })
  })
})
