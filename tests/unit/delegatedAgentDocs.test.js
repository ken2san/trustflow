import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { GRANT_HEADER, PUBLISHABLE_TOKEN, DELEGATION_REFUSED, DELEGATED_UNAVAILABLE } from '../../supabase/functions/_shared/delegatedAuth.ts'
import { DELEGATED_TYPES } from '../../supabase/functions/_shared/delegatedEvent.ts'
import * as client from '../../scripts/lib/delegatedClient.mjs'

// Pins the unpublished delegated-agent instructions (docs/api/delegated-agent-access.md)
// to the server code, the way tests/unit/shownTerms.test.js pins the published
// spec: a word, type or header the server does not use fails the build, and so
// does publishing the draft before production approval.

const DOC = readFileSync('docs/api/delegated-agent-access.md', 'utf8')
const SERVER = ['supabase/functions/log-event/index.ts', 'supabase/functions/delegated-owner-read/index.ts',
  'supabase/functions/_shared/delegatedAuth.ts'].map(f => readFileSync(f, 'utf8')).join('\n')

const section = name => {
  const start = DOC.indexOf(`## ${name}`)
  expect(start, `section ${name}`).toBeGreaterThan(-1)
  const next = DOC.indexOf('\n## ', start + 3)
  return DOC.slice(start, next === -1 ? undefined : next)
}

describe('delegated agent instructions (draft) match the server', () => {
  it('stays marked E2E-only and unpublished, and the published docs still say no scoped credential exists', () => {
    expect(DOC).toMatch(/\*\*Status: E2E only\. Not available in production\.\*\*/)
    const llms = readFileSync('public/llms.txt', 'utf8')
    expect(llms).toContain('No per-agent scoped')
    for (const f of ['public/llms.txt', 'public/agent-protocol.md']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/delegated-agent-access|x-trustflow-grant/)
    }
  })

  it('names the grant header and publishable key grammar the server admits', () => {
    expect(client.GRANT_HEADER).toBe(GRANT_HEADER)
    expect(client.PUBLISHABLE_TOKEN.source).toBe(PUBLISHABLE_TOKEN.source)
    expect(section('Calling with a grant')).toContain(`\`${GRANT_HEADER}\``)
    const token = `${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}.${'f'.repeat(64)}`
    expect(client.GRANT_TOKEN.test(token)).toBe(true)
    expect(section('Getting a grant')).toContain(`The whole value is ${token.length} characters`)
    expect(section('Calling with a grant')).toMatch(/no `Authorization` header/)
  })

  it('lists exactly the delegated event types', () => {
    const list = section('Getting a grant').split('- **Event types:**')[1].split('\n\n')[0]
    const types = [...list.matchAll(/`([a-z]+\.[a-z]+)`/g)].map(m => m[1]).sort()
    expect(types).toEqual([...DELEGATED_TYPES].sort())
    expect(section('Getting a grant')).not.toMatch(/`accept`/)
  })

  it('every documented error word is one the delegated routes return, and the uniform refusal and both 503s are documented', () => {
    const words = [...section('Answers').matchAll(/^\|[^|]*\|\s*([^|]*)\|/gm)]
      .flatMap(m => [...m[1].matchAll(/`([a-z_]+)`/g)].map(x => x[1]))
    expect(words.length).toBeGreaterThan(8)
    for (const w of words) expect(SERVER, w).toContain(`'${w}'`)
    for (const w of [DELEGATION_REFUSED.error, DELEGATED_UNAVAILABLE.error, 'delegated_read_unavailable']) {
      expect(words, w).toContain(w)
    }
    // The success answers of both routes, including the read's 200 (the read
    // route answers 200 with the projection: delegated-owner-read/index.ts).
    const answers = section('Answers')
    expect(answers).toMatch(/^\| 200 \| — \| \(read\)/m)
    expect(answers).toMatch(/^\| 201 \| — \| \(record\)/m)
    expect(answers).toMatch(/^\| 200 \| — \| \(record\) a replay/m)
    expect(SERVER).toMatch(/status: 200, headers: \{ \.\.\.cors/)
  })
})
