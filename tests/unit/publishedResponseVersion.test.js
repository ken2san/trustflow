import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The public agent documents ship with the frontend, but guest-contract-events
// ships separately. Until its response version 2 is deployed, the documents
// must describe it as planned and say what the deployed function actually
// returns (Codex 114, blocking 1). When the function release ships, change the
// documents and this test together.

const protocol = readFileSync('public/agent-protocol.md', 'utf8')
const llms = readFileSync('public/llms.txt', 'utf8')
const section = protocol.slice(protocol.indexOf('### Guest response versions'))
  .split('\n### ')[0]

describe('published guest response versions, before the function release', () => {
  it('says version 2 is planned and not deployed', () => {
    expect(section).toMatch(/version 2 is planned and not yet deployed/)
    expect(section).toMatch(/ignores\s+`\?response_version=2`/)
    expect(section).toMatch(/unversioned\s+version 1 body/)
    expect(llms).toMatch(/returns response version 1 only, and ignores `\?response_version=2`/)
    expect(llms).toMatch(/planned,\s+not deployed/)
  })

  it('keeps the interim warning about the version 1 trust_model label', () => {
    expect(section).toMatch(/Those values name the hash format only\. They do not\s+identify who wrote an event/)
    expect(llms).toMatch(/`trust_model: "server_attested"` names the hash format, not who\s+wrote an event/)
  })

  it('describes the version 2 errors and the flip as future behaviour', () => {
    expect(section).toMatch(/Planned errors, none of which the deployed function returns yet/)
    expect(section).toMatch(/will be `400 invalid_response_version`/)
    expect(section).toMatch(/will be\s+refused with `400 response_version_required`/)
    // The present-tense wording the first draft used.
    expect(section).not.toMatch(/answers in one of two shapes/)
    expect(section).not.toMatch(/value is `400 invalid_response_version`/)
  })

  it('does not tell agents to rely on the query parameter today', () => {
    expect(llms).not.toMatch(/POST \/functions\/v1\/guest-contract-events\?response_version=2/)
  })
})
