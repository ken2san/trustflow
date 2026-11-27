#!/usr/bin/env node
// The owner's agent on the delegated path (Row 7). A separate process holding
// one scoped grant and nothing else.
//
//   env -i PATH="$PATH" HOME="$HOME" TF_CHANNEL_DIR=<dir from scripts/agents/bootstrap.mjs> \
//     node scripts/agents/owner-delegate-agent.mjs
//
// Start it with a minimal environment, as above: it refuses to run if any
// variable whose name says it carries a credential is set (see
// CREDENTIAL_ENV), so an operator shell full of tokens is refused, not used.
//
// WHAT IT IS GIVEN (all from the channel dir, a private 0700 directory)
//   grant       `<grant-uuid>.<secret>`, 0600: the shown-once value
//   agent.json  the deal id, the grant id, scopes and expiry, and the
//               project's publishable key (a public identifier, sent as `apikey`)
//
// WHAT IT IS NOT GIVEN
// No account: no address, password, refresh token or JWT, and no module that
// holds them (it does not import tests/e2e/liveEnv.js or scripts/lib/
// tfClient.mjs). Unlike scripts/agents/owner-agent.mjs, whose key IS the
// account, this process can do only what the grant's scopes allow, on one
// deal, until the grant expires or the owner revokes it.
//
// WHAT IT DOES
//   1. reads the deal through `delegated-owner-read` (`read` scope);
//   2. appends `performance.asserted` through `log-event`, with a key derived
//      from the run id, so a rerun is a replay, never a second event;
//   3. sends the same request again and expects the original event back.
// It fails if the grant allows none of these (a run that did nothing is not a
// pass), and reports a 503 as the route being off, never as a pass.
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
  ClientError, PUBLISHABLE_TOKEN, RUN_ID, UUID, assertPrivateDir, delegatedAppend, delegatedRead, readGrantFile, word,
} from '../lib/delegatedClient.mjs'
import { reporter } from './lib.mjs'

/**
 * Variable names that mean the environment carries a credential this process
 * must not hold: account sign-in inputs, sessions, keys and tokens of any kind.
 */
export const CREDENTIAL_ENV = /PASSWORD|PASSWD|SECRET|TOKEN|SESSION|SERVICE_ROLE|ANON_KEY|API_KEY|PRIVATE_KEY|KEY_FILE|PGPASS|CREDENTIAL|^TF_TEST_EARNER_/i
/** Terminal bookkeeping whose names match the pattern but carry no credential. */
const HARMLESS_ENV = new Set(['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'SECURITYSESSIONID'])

export function assertGrantOnly(env = process.env) {
  const held = Object.keys(env).filter(k => CREDENTIAL_ENV.test(k) && !HARMLESS_ENV.has(k)).sort()
  if (held.length) throw new ClientError(`refusing to run: ${held.join(', ')} set; start with a minimal environment (env -i)`)
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
  if (!Array.isArray(c?.scopes) || !c.scopes.every(s => typeof s === 'string')) bad.push('scopes')
  if (bad.length) throw new ClientError(`agent.json is malformed in: ${bad.join(', ')}`)
  return c
}

export const assertedKey = run => `bot-${run}-performance-asserted`
/** The bot's actions, by the scope each needs. */
export const ACTIONS = Object.freeze(['read', 'performance.asserted'])

/**
 * Run the agent from a channel dir. `client` = { read, append } is injectable
 * so the flow can be tested offline. Returns the reporter's failures.
 */
export async function runAgent({ dir: given, env = process.env, client = { read: delegatedRead, append: delegatedAppend } }) {
  assertGrantOnly(env)
  if (!given) throw new ClientError('TF_CHANNEL_DIR is not set')
  const dir = assertPrivateDir(given)
  const cfg = readAgentConfig(dir)
  const actions = ACTIONS.filter(a => cfg.scopes.includes(a))
  if (!actions.length) throw new ClientError(`the grant allows none of this bot's actions (${ACTIONS.join(', ')}); nothing to do is not a pass`)
  const { grant, grantId } = readGrantFile(path.join(dir, 'grant'), { envName: 'the grant file' })
  if (grantId !== cfg.grant_id) throw new ClientError('the grant file and agent.json name different grants')

  const r = reporter('delegate')
  const base = { pub: cfg.publishable_key, grant, contractId: cfg.contract_id }
  if (actions.includes('read')) {
    const read = await client.read(base)
    r.ok('read the deal under the grant', read.status === 200, `HTTP ${read.status} ${read.status === 200 ? '' : read.error}`)
  }
  if (actions.includes('performance.asserted')) {
    const op = { ...base, type: 'performance.asserted', payload: { note: `delegated bot ${cfg.run}` }, idempotencyKey: assertedKey(cfg.run) }
    const first = await client.append(op)
    const firstId = first.json?.event?.id ?? null
    const appended = (first.status === 201 || first.status === 200) && UUID.test(firstId ?? '')
    r.ok('asserted performance under the grant', appended,
      `HTTP ${first.status} ${first.status < 300 ? (first.json?.deduplicated ? 'replayed' : 'appended') : first.error}`)
    if (appended) {
      const again = await client.append(op)
      r.ok('the same request again is a replay of the same event',
        again.status === 200 && again.json?.deduplicated === true && again.json?.event?.id === firstId, `HTTP ${again.status} ${word(again.error)}`)
    }
  }
  return r.failures
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  (async () => {
    // The environment first, before anything is read or any module could use it.
    assertGrantOnly()
    installPinnedFetch()
    const failures = await runAgent({ dir: process.env.TF_CHANNEL_DIR })
    if (failures.length) process.exit(1)
  })().catch(e => {
    console.error(e instanceof ClientError ? e.message : 'delegate agent failed (unexpected error; nothing printed from it)')
    process.exit(1)
  })
}
