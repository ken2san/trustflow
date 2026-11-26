import { describe, it, expect } from 'vitest'
import { parseGateRows, gateQueryArgs, E2E_GATE_DB_URL, TrialError } from '../../scripts/lib/delegatedTrial.mjs'

// The gate readback of the delegated-append trial (scripts/lib/delegatedTrial.mjs).
// T278: CLI 2.105.0 prints `-o json` rows bare under the stripped env a real
// run gives it, and wrapped only when it detects an agent. The parser accepts
// the bare shape only, and the query pins it with --agent no.

const WRAPPED = JSON.stringify({ boundary: 'b'.repeat(32), rows: [{ open: false }], warning: 'untrusted' })

describe('delegated trial gate readback', () => {
  it('a bare array of one boolean row is the gate', () => {
    expect(parseGateRows('[\n  {\n    "open": false\n  }\n]\n')).toBe('closed')
    expect(parseGateRows('[{"open":true}]')).toBe('open')
  })

  it('anything else fails closed with fixed text, the agent wrapper included', () => {
    for (const [label, out] of [
      ['agent wrapper', WRAPPED],
      ['empty array (no gate row)', '[]'],
      ['two rows', '[{"open":false},{"open":false}]'],
      ['null open', '[{"open":null}]'],
      ['string open', '[{"open":"false"}]'],
      ['extra key', '[{"open":false,"id":true}]'],
      ['null row', '[null]'],
      ['nested array', '[[false]]'],
      ['not JSON', 'Connecting to remote database...'],
      ['empty output', ''],
    ]) {
      let thrown = null
      try { parseGateRows(out) } catch (e) { thrown = e }
      expect(thrown, label).toBeInstanceOf(TrialError)
      expect(thrown.message, label).toBe('gate readback: not exactly one boolean gate row')
    }
  })

  it('the query pins --agent no, the read-only E2E connection and JSON output', () => {
    const args = gateQueryArgs(E2E_GATE_DB_URL)
    expect(args.slice(0, 2)).toEqual(['db', 'query'])
    expect(args[args.indexOf('--agent') + 1]).toBe('no')
    expect(args[args.indexOf('-o') + 1]).toBe('json')
    expect(E2E_GATE_DB_URL).toBe('postgresql://postgres@db.yqjtawffpesplqyurlpj.supabase.co:5432/postgres'
      + '?options=-c%20default_transaction_read_only%3Don')
    expect(args.at(-1)).toBe('select open from private.v5_write_gate where id')
  })
})
