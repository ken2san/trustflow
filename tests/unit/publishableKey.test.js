import { describe, it, expect } from 'vitest'
import { projectRef, selectPublishableKey } from '../e2e/publishableKey.js'

// The E2E fixture's key selection (delegated transport). Pure parts only: the
// CLI call itself is exercised by the hosted runbook, never here.
const PUB = 'sb_publishable_testkeyAAAA'
const rows = (...r) => JSON.stringify(r)
const legacy = { name: 'anon', type: 'legacy', api_key: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig' }
const secret = { name: 'default', type: 'secret', api_key: 'sb_secret_abc' }

describe('selectPublishableKey', () => {
  it('picks the default publishable key, never the legacy anon or a secret key', () => {
    expect(selectPublishableKey(rows(legacy, secret, { name: 'default', type: 'publishable', api_key: PUB }))).toBe(PUB)
  })

  it('only the fixed alias is accepted, and its refusal does not echo the requested name', () => {
    let message = ''
    try { selectPublishableKey(rows({ name: 'web', type: 'publishable', api_key: PUB }), 'web-CANARY') } catch (e) { message = e.message }
    expect(message).toBe('unsupported publishable key alias')
  })

  it.each([
    ['not JSON', 'nope'],
    ['not a list', '{}'],
    ['no publishable key', rows(legacy, secret)],
    ['two with the same name', rows({ name: 'default', type: 'publishable', api_key: PUB }, { name: 'default', type: 'publishable', api_key: PUB })],
    ['a mislabelled secret', rows({ name: 'default', type: 'publishable', api_key: 'sb_secret_abc' })],
    ['a missing value', rows({ name: 'default', type: 'publishable' })],
    ['a value with a space', rows({ name: 'default', type: 'publishable', api_key: `${PUB} x` })],
    ['a value with a comma', rows({ name: 'default', type: 'publishable', api_key: `${PUB}, ${PUB}` })],
    ['a bare prefix', rows({ name: 'default', type: 'publishable', api_key: 'sb_publishable_' })],
  ])('refuses %s, with a message that carries no key', (_label, json) => {
    let message = ''
    try { selectPublishableKey(json) } catch (e) { message = e.message }
    expect(message).not.toBe('')
    expect(message).not.toContain('sb_')
    expect(message).not.toContain('eyJ')
  })
})

describe('projectRef', () => {
  it('takes the ref of a hosted project URL only', () => {
    expect(projectRef('https://yqjtawffpesplqyurlpj.supabase.co')).toBe('yqjtawffpesplqyurlpj')
    expect(() => projectRef('http://127.0.0.1:54321')).toThrow()
    expect(() => projectRef(undefined)).toThrow()
  })
})
