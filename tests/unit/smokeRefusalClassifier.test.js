import { describe, it, expect } from 'vitest'
import {
  classifyRefusal, REFUSAL_TERMS, REFUSAL_RPC_ARGS,
} from '../../scripts/smoke-production.mjs'

// The production refusal probes' classifier (Codex T157). Offline: mocked
// statuses and bodies only; importing the script sends no request.

describe('classifyRefusal', () => {
  it('stops on any 2xx, even with a 42501 code in the body', () => {
    for (const [status, body] of [
      [200, { status: 'not_authorized' }],
      [201, null],
      [204, null],
      [200, { code: '42501' }],
      [200, [{ id: 1 }]],
      [200, 'text'],
    ]) {
      const c = classifyRefusal(status, body)
      expect(c).toMatchObject({ outcome: 'reached_2xx', pass: false, stop: true })
    }
  })

  it('reports only allowlisted RPC statuses on a 2xx', () => {
    expect(classifyRefusal(200, { status: 'not_authorized' }).detail).toContain('not_authorized')
    expect(classifyRefusal(200, { status: 'created' }).detail).toContain('created')
    expect(classifyRefusal(200, { status: '<script>' }).detail).toContain('unrecognized')
  })

  it('passes a database refusal (42501) as db_refused', () => {
    expect(classifyRefusal(401, { code: '42501' })).toMatchObject({ outcome: 'db_refused', pass: true, stop: false })
    expect(classifyRefusal(403, { code: '42501' })).toMatchObject({ outcome: 'db_refused', pass: true })
  })

  it('keeps an HTTP-boundary refusal distinct from a database refusal', () => {
    for (const body of [null, {}, { message: 'Invalid API key' }, { code: 'PGRST301' }]) {
      expect(classifyRefusal(401, body)).toMatchObject({ outcome: 'http_refused', pass: true })
    }
    expect(classifyRefusal(403, {}).detail).toContain('database ACL not shown')
  })

  it('fails a real 23514 as check_reached', () => {
    expect(classifyRefusal(400, { code: '23514' })).toMatchObject({ outcome: 'check_reached', pass: false, stop: false })
  })

  it('treats a generic 400 and other statuses as inconclusive', () => {
    for (const [status, body] of [
      [400, null], [400, {}], [400, { code: 'PGRST102' }], [400, { code: '22P02' }],
      [404, { code: 'PGRST202' }], [500, null], [0, null], [400, { code: 23514 }],
    ]) {
      expect(classifyRefusal(status, body)).toMatchObject({ outcome: 'inconclusive', pass: false, stop: false })
    }
  })
})

describe('refusal probe bodies', () => {
  it('carry a currency outside every allowed list', () => {
    expect(REFUSAL_TERMS.currency).toBe('XXX')
    expect(REFUSAL_RPC_ARGS.p_currency).toBe('XXX')
  })

  it('name every create_entry_contract parameter', () => {
    expect(Object.keys(REFUSAL_RPC_ARGS).sort()).toEqual([
      'p_amount_minor', 'p_currency', 'p_deadline', 'p_dod', 'p_earner_display_name',
      'p_invited_hirer_email', 'p_performed_by', 'p_project_name',
    ])
  })
})
