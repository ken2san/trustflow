#!/usr/bin/env node
// The owner's agent on the delegated path (Row 7). A separate process holding
// one scoped grant and nothing else.
//
//   TF_CHANNEL_DIR=<dir from scripts/agents/bootstrap.mjs> \
//   node scripts/agents/owner-delegate-agent.mjs
//
// WHAT IT IS GIVEN (all from the channel dir)
//   grant       `<grant-uuid>.<secret>`, 0600: the shown-once value
//   agent.json  the deal id, the grant's scopes and expiry, and the project's
//               publishable key (a public identifier, sent as `apikey`)
//
// WHAT IT IS NOT GIVEN
// No account: no address, password, refresh token or JWT, and no module that
// holds them (it does not import tests/e2e/liveEnv.js or scripts/lib/
// tfClient.mjs). It refuses to start if any of those is in its environment.
// Unlike scripts/agents/owner-agent.mjs, whose key IS the account, this
// process can do only what the grant's scopes allow, on one deal, until the
// grant expires or the owner revokes it.
//
// WHAT IT DOES
//   1. reads the deal through `delegated-owner-read` (`read` scope);
//   2. appends `performance.asserted` through `log-event`, with a key derived
//      from the run id, so a rerun is a replay, never a second event;
//   3. sends the same request again and expects the original event back.
// A 503 is reported as the route being off, not as a pass.
//
// THIS IS NOT AN AUTHORITY BOUNDARY: it runs as the same OS user as the
// operator (see scripts/two-agent-transaction.mjs). What it shows is that the
// grant alone is enough, not that the process could not reach more.
//
// E2E only (scripts/lib/pinnedFetch.mjs). Output: status codes, error words,
// nonsecret ids. Never the grant secret or a response body.

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { installPinnedFetch } from '../lib/pinnedFetch.mjs'
import {
  ClientError, PUBLISHABLE_TOKEN, RUN_ID, UUID, delegatedAppend, delegatedRead, readGrantFile, word,
} from '../lib/delegatedClient.mjs'
import { reporter } from './lib.mjs'

/** Environment names that would mean this process holds more than a grant. */
export const FORBIDDEN_ENV = Object.freeze(['TF_TEST_EARNER_EMAIL', 'TF_TEST_EARNER_PASSWORD',
  'TF_OWNER_KEY_FILE', 'TF_TEST_EARNER_SESSION', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN'])

export function assertGrantOnly(env = process.env) {
  const held = FORBIDDEN_ENV.filter(k => env[k] !== undefined)
  if (held.length) throw new ClientError(`refusing to run: ${held.join(', ')} set; this process holds one grant and nothing else`)
}

/** agent.json, checked field by field (never echoed). */
export function readAgentConfig(dir) {
  let c
  try { c = JSON.parse(readFileSync(path.join(dir, 'agent.json'), 'utf8')) } catch { throw new ClientError('no agent.json in the channel dir') }
  const bad = []
  if (!RUN_ID.test(c?.run ?? '')) bad.push('run')
  if (!UUID.test(c?.contract_id ?? '')) bad.push('contract_id')
  if (!UUID.test(c?.grant_id ?? '')) bad.push('grant_id')
  if (!PUBLISHABLE_TOKEN.test(c?.publishable_key ?? '')) bad.push('publishable_key')
  if (!Array.isArray(c?.scopes)) bad.push('scopes')
  if (bad.length) throw new ClientError(`agent.json is malformed in: ${bad.join(', ')}`)
  return c
}

export const assertedKey = run => `bot-${run}-performance-asserted`

async function main() {
  assertGrantOnly()
  const dir = process.env.TF_CHANNEL_DIR
  if (!dir) throw new ClientError('TF_CHANNEL_DIR is not set')
  installPinnedFetch()
  const cfg = readAgentConfig(dir)
  const { grant, grantId } = readGrantFile(path.join(dir, 'grant'), { envName: 'the grant file' })
  if (grantId !== cfg.grant_id) throw new ClientError('the grant file and agent.json name different grants')
  const r = reporter('delegate')
  const base = { pub: cfg.publishable_key, grant, contractId: cfg.contract_id }

  if (cfg.scopes.includes('read')) {
    const read = await delegatedRead(base)
    r.ok('read the deal under the grant', read.status === 200, `HTTP ${read.status} ${read.status === 200 ? '' : read.error}`)
  }
  if (cfg.scopes.includes('performance.asserted')) {
    const op = { ...base, type: 'performance.asserted', payload: { note: `delegated bot ${cfg.run}` }, idempotencyKey: assertedKey(cfg.run) }
    const first = await delegatedAppend(op)
    const firstId = first.json?.event?.id ?? null
    r.ok('asserted performance under the grant', (first.status === 201 || first.status === 200) && UUID.test(firstId ?? ''),
      `HTTP ${first.status} ${first.status < 300 ? (first.json?.deduplicated ? 'replayed' : 'appended') : first.error}`)
    if (firstId) {
      const again = await delegatedAppend(op)
      r.ok('the same request again is a replay of the same event',
        again.status === 200 && again.json?.deduplicated === true && again.json?.event?.id === firstId, `HTTP ${again.status} ${word(again.error)}`)
    }
  }
  if (r.failures.length) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => {
    console.error(e instanceof ClientError ? e.message : 'delegate agent failed (unexpected error; nothing printed from it)')
    process.exit(1)
  })
}
