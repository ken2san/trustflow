#!/usr/bin/env node
// Deterministic bot bootstrap for the delegated (Row 7) path. E2E only,
// operator-run.
//
//   node scripts/agents/bootstrap.mjs --run <id> --dir <channel dir>
//   node scripts/agents/bootstrap.mjs --revoke <id> --dir <channel dir>
//
// FIXTURE AUTH, NOT THE PRODUCTION SIGN-UP PATH
// The owner here is the existing E2E QA earner, signed in by password grant
// through scripts/lib/tfClient.mjs (an admin-created, already-confirmed
// account; docs/e2e-project.md). In production a human signs in through the
// browser (OTP and CAPTCHA), issues the grant in the owner UI and hands the
// shown-once string to their agent; the agent never signs in. Nothing here
// signs anyone up, touches CAPTCHA, anonymous sign-in or email confirmation,
// or uses service_role.
//
// WHAT IT DOES, once per run id
//   1. creates one deal through `create_entry_contract` (server-side creation);
//   2. issues one owner_account grant through the product endpoint
//      `manage-entry-agent-credential` `issue`. There is no SQL fallback: if
//      issuance is off (503 issuance_disabled) the run stops and says so;
//   3. reads the grant back from the owner's list;
//   4. leaves, in the channel dir, everything the two bots need:
//        grant       `<grant-uuid>.<secret>`, 0600: the delegate bot's credential
//        agent.json  contract id, scopes, expiry, the public publishable key
//        invite.json the invite token, for the guest bot (a secret, 0600)
//        manifest.json  what was done, phase by phase (no secret in it)
//
// DETERMINISTIC AND NEVER RETRIED
// The manifest is created exclusively, so a run id bootstraps at most once.
// A create whose outcome is unknown is never retried (docs/plans/row2-c5-
// create.md): the run stops, and the operator inspects the owner's drafts.
// `--revoke` revokes that run's grant, reads the revocation back and deletes
// the grant file.
//
// Defaults (Row 7 least privilege): scopes `read` + `performance.asserted`,
// 24 hours.
//
// OUTPUT: fixed text, status codes, error words and nonsecret ids. Never the
// grant secret, the invite token, a session or a response body.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClientError, GRANT_TOKEN, PUBLISHABLE_TOKEN, RUN_ID, UUID, word } from '../lib/delegatedClient.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export { RUN_ID }
export const DEFAULT_SCOPES = Object.freeze(['read', 'performance.asserted'])
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const SKEW_MS = 5 * 60 * 1000
export const FIXTURE_BANNER = 'FIXTURE AUTH (E2E): the QA earner by password grant; not the production sign-up path'

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** { mode: 'bootstrap'|'revoke', run, dir }, or a ClientError with fixed text. */
export function parseArgs(argv) {
  const at = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] ?? null : null }
  const known = new Set(['--run', '--revoke', '--dir'])
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i])) throw new ClientError('usage: bootstrap.mjs (--run <id> | --revoke <id>) --dir <channel dir>')
  }
  const run = at('--run'), revoke = at('--revoke'), dir = at('--dir')
  if ((run === null) === (revoke === null) || !dir) {
    throw new ClientError('usage: bootstrap.mjs (--run <id> | --revoke <id>) --dir <channel dir>')
  }
  const id = run ?? revoke
  if (!RUN_ID.test(id)) throw new ClientError('the run id must match [a-z0-9][a-z0-9-]{2,39}')
  return { mode: run ? 'bootstrap' : 'revoke', run: id, dir: path.resolve(dir) }
}

/**
 * The channel dir must not be a place a credential could be committed from:
 * outside the repository, or inside it only where git ignores it.
 */
export function assertChannelDir(dir, { repoRoot = REPO_ROOT, isIgnored = gitIgnores } = {}) {
  const rel = path.relative(repoRoot, dir)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (inside && !isIgnored(dir)) throw new ClientError('the channel dir is inside the repository and not git-ignored')
  return dir
}

function gitIgnores(dir) {
  try { execFileSync('git', ['check-ignore', '-q', dir], { cwd: REPO_ROOT, stdio: 'ignore' }); return true } catch { return false }
}

/** The issue request body for a deal: owner_account, least-privilege defaults. */
export function issueBody(contractId, { now = Date.now(), scopes = DEFAULT_SCOPES, ttlMs = DEFAULT_TTL_MS } = {}) {
  return { action: 'issue', contract_id: contractId, issuer_kind: 'owner_account',
    scopes: [...scopes], expires_at: new Date(now + ttlMs).toISOString() }
}

/**
 * Check an issue response against what was asked; returns { grantId, token,
 * scopes, expiresAt } or throws a ClientError naming the field (never a value).
 */
export function validateIssue(res, { contractId, scopes = DEFAULT_SCOPES, now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (res?.status !== 201) throw new ClientError(`issue answered ${res?.status ?? 'nothing'} ${word(res?.reason)}`)
  const g = res.data?.grant, secret = res.data?.secret
  const bad = []
  if (typeof g?.id !== 'string' || !UUID.test(g.id)) bad.push('id')
  if (g?.contract_id !== contractId) bad.push('contract_id')
  if (g?.issuer_kind !== 'owner_account') bad.push('issuer_kind')
  if (!Array.isArray(g?.scopes) || g.scopes.length !== scopes.length || !scopes.every(s => g.scopes.includes(s))) bad.push('scopes')
  const exp = Date.parse(g?.expires_at ?? '')
  if (!(exp > now && exp <= now + ttlMs + SKEW_MS)) bad.push('expires_at')
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) bad.push('secret')
  if (bad.length) throw new ClientError(`issue response differs from the request in: ${bad.join(', ')}`)
  const token = `${g.id}.${secret}`
  if (!GRANT_TOKEN.test(token)) throw new ClientError('issue response does not form a grant token')
  return { grantId: g.id, token, scopes: [...g.scopes], expiresAt: g.expires_at }
}

// ── The channel dir ─────────────────────────────────────────────────────────

const file = (dir, name) => path.join(dir, name)

/** Create `name` with `text`, exclusively and owner-only; refuses an existing file. */
export function writeExclusive(dir, name, text) {
  let fd
  try { fd = openSync(file(dir, name), 'wx', 0o600) } catch (e) {
    throw new ClientError(e.code === 'EEXIST' ? `${name} already exists in the channel dir` : `${name} could not be created`)
  }
  try { writeFileSync(fd, text) } finally { closeSync(fd) }
}

export function readManifest(dir) {
  try { return JSON.parse(readFileSync(file(dir, 'manifest.json'), 'utf8')) } catch { throw new ClientError('no manifest for this run in the channel dir') }
}

/** Record one phase, atomically (fresh 0600 file, then rename). */
export function phase(dir, name, detail = {}) {
  const m = readManifest(dir)
  const next = { ...m, phases: { ...m.phases, [name]: { at: new Date().toISOString(), ...detail } } }
  const tmp = file(dir, `manifest.json.${randomBytes(6).toString('hex')}.next`)
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file(dir, 'manifest.json'))
  } catch {
    rmSync(tmp, { force: true })
    throw new ClientError('the manifest could not be updated')
  }
  return next
}

// ── Main ────────────────────────────────────────────────────────────────────

const say = line => console.log(line)

async function client() {
  // Pinned before tfClient loads, so every request it makes is E2E-only.
  const { installPinnedFetch } = await import('../lib/pinnedFetch.mjs')
  installPinnedFetch()
  return import('../lib/tfClient.mjs')
}

async function listed(tf, token, contractId, grantId) {
  const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: token, body: { action: 'list', contract_id: contractId } })
  if (r.status !== 200) throw new ClientError(`grant list answered ${r.status} ${word(r.reason)}`)
  return (r.data?.grants ?? []).find(g => g.id === grantId) ?? null
}

function tomorrowLocalISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA')
}

async function bootstrap(run, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeExclusive(dir, 'manifest.json', JSON.stringify({ run, created_at: new Date().toISOString(),
    fixture_auth: FIXTURE_BANNER, scopes: DEFAULT_SCOPES, ttl_ms: DEFAULT_TTL_MS, phases: {} }, null, 2))
  const tf = await client()
  say(FIXTURE_BANNER)
  const owner = await tf.ownerSession()
  phase(dir, 'owner_session', { project_ref: tf.PROJECT_REF })

  phase(dir, 'create_sent')
  let created
  try {
    created = await tf.rest(owner.token, 'rpc/create_entry_contract', { method: 'POST', body: JSON.stringify({
      p_earner_display_name: 'Bootstrap Owner',
      p_project_name: `agent bootstrap ${run}`,
      p_dod: ['Deliver the agreed work'],
      p_amount_minor: 125050,
      p_currency: 'CAD',
      p_deadline: tomorrowLocalISO(),
      p_invited_hirer_email: 'agent-guest@example.invalid',
      p_performed_by: 'creator',
    }) })
  } catch {
    phase(dir, 'create_unknown')
    throw new ClientError('create: no answer. Do not retry: inspect the owner\'s recent drafts first')
  }
  const contract = created.status === 200 && created.body?.status === 'created' ? created.body.contract : null
  if (!contract || !UUID.test(contract.id ?? '') || typeof contract.invite_token !== 'string') {
    phase(dir, 'create_failed', { status: created.status, error: word(created.body?.status ?? created.body?.error) })
    throw new ClientError(`create answered ${created.status} ${word(created.body?.status ?? created.body?.error)}`)
  }
  writeExclusive(dir, 'invite.json', JSON.stringify({ run, invite_token: contract.invite_token }))
  phase(dir, 'created', { contract_id: contract.id })
  say(`created deal ${contract.id}`)

  // The product endpoint only. No SQL fallback.
  const now = Date.now()
  phase(dir, 'issue_sent')
  const issued = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token, body: issueBody(contract.id, { now }) })
  if (issued.status === 503) {
    phase(dir, 'issue_refused', { status: 503, error: word(issued.reason) })
    throw new ClientError(`issue answered 503 ${word(issued.reason)}: issuance is off on this project; no fallback`)
  }
  const grant = validateIssue(issued, { contractId: contract.id, now })
  writeExclusive(dir, 'grant', grant.token)
  phase(dir, 'issued', { grant_id: grant.grantId, scopes: grant.scopes, expires_at: grant.expiresAt })
  say(`issued grant ${grant.grantId} (${grant.scopes.join(', ')}; until ${grant.expiresAt})`)

  const g = await listed(tf, owner.token, contract.id, grant.grantId)
  if (!g || g.revoked_at !== null || g.issuer_kind !== 'owner_account') throw new ClientError('the grant is not listed live after issue')
  phase(dir, 'grant_listed')

  const { readPublishableKey } = await import('../../tests/e2e/publishableKey.js')
  const pub = readPublishableKey(tf.SUPABASE_URL)
  if (!PUBLISHABLE_TOKEN.test(pub)) throw new ClientError('not a publishable key')
  writeExclusive(dir, 'agent.json', JSON.stringify({ run, contract_id: contract.id, grant_id: grant.grantId,
    scopes: grant.scopes, expires_at: grant.expiresAt, publishable_key: pub }, null, 2))
  phase(dir, 'ready')
  say(`BOOTSTRAP READY: ${dir} (grant, agent.json, invite.json)`)
}

async function revoke(run, dir) {
  const m = readManifest(dir)
  if (m.run !== run) throw new ClientError('the manifest in this dir is for another run')
  const contractId = m.phases?.created?.contract_id, grantId = m.phases?.issued?.grant_id
  if (!contractId || !grantId) throw new ClientError('this run issued no grant; nothing to revoke')
  const tf = await client()
  say(FIXTURE_BANNER)
  const owner = await tf.ownerSession()
  let g = await listed(tf, owner.token, contractId, grantId)
  if (!g) throw new ClientError('the grant is not listed on the run\'s deal')
  if (g.revoked_at === null) {
    const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token,
      body: { action: 'revoke', contract_id: contractId, id: grantId } })
    if (r.status !== 200) throw new ClientError(`revoke answered ${r.status} ${word(r.reason)}`)
    g = await listed(tf, owner.token, contractId, grantId)
  }
  if (typeof g?.revoked_at !== 'string') throw new ClientError('the grant list does not show the grant revoked')
  rmSync(file(dir, 'grant'), { force: true })
  if (existsSync(file(dir, 'grant'))) throw new ClientError('the grant file could not be deleted')
  phase(dir, 'revoked', { grant_id: grantId })
  say(`REVOKED grant ${grantId}; grant file deleted`)
}

async function main() {
  const { mode, run, dir } = parseArgs(process.argv.slice(2))
  assertChannelDir(dir)
  await (mode === 'bootstrap' ? bootstrap(run, dir) : revoke(run, dir))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => {
    console.error(e instanceof ClientError ? e.message : 'bootstrap failed (unexpected error; nothing printed from it)')
    process.exit(1)
  })
}
