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
//      `manage-entry-agent-credential` `issue`. No SQL fallback: if issuance
//      is off (503 issuance_disabled) the run stops and says so;
//   3. reads the grant back from the owner's list;
//   4. leaves, in the channel dir (a private 0700 directory, outside the
//      repository or git-ignored, never reached through a symlink):
//        grant         `<grant-uuid>.<secret>`, 0600: the delegate bot's credential
//        agent.json    contract id, grant id, scopes, expiry, the publishable key
//        invite.json   the invite token, for the guest bot (a secret, 0600)
//        manifest.json what was done, phase by phase (no secret in it)
//
// NO ORPHAN GRANT
// The grant id is recorded (durably, fsync then rename) the moment an issue
// response carries one, before the response is validated or any file is
// written. Any failure after an issue was sent revokes every live grant on the
// run's own deal (the deal was created by this run, so every grant on it is
// the run's) and reads the revocation back; whatever it could not verify, the
// operator finishes with `--revoke`, which works from any phase. On a failed
// run, the invite and grant files are removed; `--revoke` removes them too.
//
// DETERMINISTIC AND NEVER RETRIED
// The manifest is created exclusively, so a run id bootstraps at most once.
// A create whose outcome is unknown is never retried (docs/plans/row2-c5-
// create.md): the run stops, and the operator inspects the owner's drafts.
//
// Defaults (Row 7 least privilege): scopes `read` + `performance.asserted`,
// 24 hours.
//
// OUTPUT: fixed text, status codes, error words and nonsecret ids. Never the
// grant secret, the invite token, a session or a response body.

import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ClientError, GRANT_TOKEN, PUBLISHABLE_TOKEN, RUN_ID, UUID, assertPrivateDir, word,
} from '../lib/delegatedClient.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export { RUN_ID }
export const DEFAULT_SCOPES = Object.freeze(['read', 'performance.asserted'])
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const SKEW_MS = 5 * 60 * 1000
export const FIXTURE_BANNER = 'FIXTURE AUTH (E2E): the QA earner by password grant; not the production sign-up path'
const SECRET_FILES = ['grant', 'invite.json']

// ── Arguments ───────────────────────────────────────────────────────────────

const USAGE = 'usage: bootstrap.mjs (--run <id> | --revoke <id>) --dir <channel dir>'

/** { mode: 'bootstrap'|'revoke', run, dir }, or a ClientError with fixed text. */
export function parseArgs(argv) {
  const known = new Set(['--run', '--revoke', '--dir'])
  const seen = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i] in seen || argv[i + 1] === undefined) throw new ClientError(USAGE)
    seen[argv[i]] = argv[i + 1]
  }
  const { '--run': run = null, '--revoke': revoke = null, '--dir': dir = null } = seen
  if ((run === null) === (revoke === null) || !dir) throw new ClientError(USAGE)
  const id = run ?? revoke
  if (!RUN_ID.test(id)) throw new ClientError('the run id must match [a-z0-9][a-z0-9-]{2,39}')
  return { mode: run ? 'bootstrap' : 'revoke', run: id, dir: path.resolve(dir) }
}

// ── The channel dir: canonical, contained, private ──────────────────────────

/** git check-ignore, with only what git needs in its environment. */
function gitIgnores(dir) {
  try {
    execFileSync('git', ['check-ignore', '-q', dir], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' } })
    return true
  } catch { return false }
}

/**
 * The channel dir's canonical path: ancestors resolved through realpath, the
 * leaf itself never a symlink. A dir that does not exist yet is resolved
 * through its (existing) parent. Inside the repository it must be
 * git-ignored, judged on the canonical path, so a symlinked ancestor cannot
 * smuggle it in or out.
 */
export function canonicalChannelDir(dir, { repoRoot = REPO_ROOT, isIgnored = gitIgnores } = {}) {
  const abs = path.resolve(dir)
  let canonical
  let exists = true
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new ClientError('the channel dir is a symlink')
  } catch (e) {
    if (e instanceof ClientError) throw e
    exists = false
  }
  if (exists) {
    canonical = realpathSync(abs)
  } else {
    let parent
    try { parent = realpathSync(path.dirname(abs)) } catch { throw new ClientError('the channel dir\'s parent does not exist') }
    canonical = path.join(parent, path.basename(abs))
  }
  const root = realpathSync(repoRoot)
  const rel = path.relative(root, canonical)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (inside && !isIgnored(canonical)) throw new ClientError('the channel dir is inside the repository and not git-ignored')
  return { canonical, exists }
}

/**
 * Create (0700) or accept the channel dir, then require it to be a private
 * directory owned by this user.
 */
export function prepareChannelDir(dir, { create = true, ...opts } = {}) {
  const { canonical, exists } = canonicalChannelDir(dir, opts)
  if (!exists) {
    if (!create) throw new ClientError('the channel dir does not exist')
    try { mkdirSync(canonical, { mode: 0o700 }) } catch { throw new ClientError('the channel dir could not be created') }
    chmodSync(canonical, 0o700) // the umask can narrow mkdir's mode further, never widen it; set it exactly
  }
  return assertPrivateDir(canonical)
}

// ── Files: exclusive, no symlink, complete or absent ────────────────────────

const file = (dir, name) => path.join(dir, name)
const EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/**
 * Create `name` with `text`, exclusively, owner-only and never through a
 * symlink, flushed to disk. A partial write is removed: the file is either
 * complete or absent. `write` is injectable so a test can fail it.
 */
export function writeExclusive(dir, name, text, { write = writeFileSync } = {}) {
  let fd
  try { fd = openSync(file(dir, name), EXCL, 0o600) } catch (e) {
    throw new ClientError(e.code === 'EEXIST' ? `${name} already exists in the channel dir` : `${name} could not be created`)
  }
  try {
    write(fd, text)
    fsyncSync(fd)
  } catch {
    try { closeSync(fd) } catch { /* already closed */ }
    rmSync(file(dir, name), { force: true })
    throw new ClientError(`${name} could not be written; removed`)
  }
  closeSync(fd)
}

/** Remove both secret files; returns the names still present afterwards. */
export function removeSecrets(dir) {
  for (const n of SECRET_FILES) rmSync(file(dir, n), { force: true })
  return SECRET_FILES.filter(n => { try { lstatSync(file(dir, n)); return true } catch { return false } })
}

export function readManifest(dir) {
  try { return JSON.parse(readFileSync(file(dir, 'manifest.json'), 'utf8')) } catch { throw new ClientError('no manifest for this run in the channel dir') }
}

/** Record one phase, durably: a fresh 0600 file, flushed, then renamed over the manifest. */
export function phase(dir, name, detail = {}) {
  const m = readManifest(dir)
  const next = { ...m, phases: { ...m.phases, [name]: { at: new Date().toISOString(), ...detail } } }
  const tmpName = `manifest.json.${randomBytes(6).toString('hex')}.next`
  try {
    writeExclusive(dir, tmpName, JSON.stringify(next, null, 2))
    renameSync(file(dir, tmpName), file(dir, 'manifest.json'))
  } catch {
    rmSync(file(dir, tmpName), { force: true })
    throw new ClientError('the manifest could not be updated')
  }
  try { const d = openSync(dir, 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* best effort on this platform */ }
  return next
}

// ── Issue: request and response ─────────────────────────────────────────────

/** The issue request body for a deal: owner_account, least-privilege defaults. */
export function issueBody(contractId, { now = Date.now(), scopes = DEFAULT_SCOPES, ttlMs = DEFAULT_TTL_MS } = {}) {
  return { action: 'issue', contract_id: contractId, issuer_kind: 'owner_account',
    scopes: [...scopes], expires_at: new Date(now + ttlMs).toISOString() }
}

/** The grant id an issue response carries, if it is a well-formed one; else null. Never throws. */
export const issuedGrantId = res => (typeof res?.data?.grant?.id === 'string' && UUID.test(res.data.grant.id) ? res.data.grant.id : null)

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

// ── Revocation: every live grant on the run's deal, read back ───────────────

const safe = e => (e instanceof ClientError ? e.message : 'request failed')

async function listGrants(tf, token, contractId) {
  const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: token, body: { action: 'list', contract_id: contractId } })
  if (r?.status !== 200 || !Array.isArray(r.data?.grants)) throw new ClientError(`grant list answered ${r?.status ?? 'nothing'} ${word(r?.reason)}`)
  return r.data.grants
}

/**
 * Revoke every live grant on `contractId` and read the list back. The deal was
 * created by this run, so every grant on it is the run's. Never throws:
 * returns { revoked: [ids], problems: [fixed text] }; empty problems = verified.
 */
export async function revokeRunGrants(tf, token, contractId) {
  const problems = [], revoked = []
  let grants
  try { grants = await listGrants(tf, token, contractId) } catch (e) { return { revoked, problems: [safe(e)] } }
  for (const g of grants.filter(x => x.revoked_at === null)) {
    try {
      const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: token,
        body: { action: 'revoke', contract_id: contractId, id: g.id } })
      if (r?.status !== 200) problems.push(`revoke ${g.id} answered ${r?.status ?? 'nothing'} ${word(r?.reason)}`)
      else revoked.push(g.id)
    } catch (e) { problems.push(`revoke ${g.id}: ${safe(e)}`) }
  }
  try {
    const live = (await listGrants(tf, token, contractId)).filter(x => typeof x.revoked_at !== 'string').map(x => x.id)
    if (live.length) problems.push(`still live after revoke: ${live.join(', ')}`)
  } catch (e) { problems.push(`revoke readback: ${safe(e)}`) }
  return { revoked, problems }
}

// ── The run ─────────────────────────────────────────────────────────────────

function tomorrowLocalISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA')
}

/**
 * Bootstrap one run. `deps` = { tf: { ownerSession, rest, invoke, PROJECT_REF },
 * publishableKey: async () => string, say, now }. Injected so every failure
 * path can be tested offline.
 */
export async function runBootstrap({ run, dir, deps }) {
  const { tf, publishableKey, say = () => {}, now = () => Date.now() } = deps
  writeExclusive(dir, 'manifest.json', JSON.stringify({ run, created_at: new Date(now()).toISOString(),
    fixture_auth: FIXTURE_BANNER, scopes: DEFAULT_SCOPES, ttl_ms: DEFAULT_TTL_MS, phases: {} }, null, 2))
  say(FIXTURE_BANNER)
  const owner = await tf.ownerSession()
  phase(dir, 'owner_session', { project_ref: tf.PROJECT_REF ?? null })

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
  const contract = created?.status === 200 && created.body?.status === 'created' ? created.body.contract : null
  if (!contract || !UUID.test(contract.id ?? '') || typeof contract.invite_token !== 'string') {
    phase(dir, 'create_failed', { status: created?.status ?? null, error: word(created?.body?.status ?? created?.body?.error) })
    throw new ClientError(`create answered ${created?.status ?? 'nothing'} ${word(created?.body?.status ?? created?.body?.error)}`)
  }
  phase(dir, 'created', { contract_id: contract.id })
  say(`created deal ${contract.id}`)

  let issueSent = false
  try {
    writeExclusive(dir, 'invite.json', JSON.stringify({ run, invite_token: contract.invite_token }))
    const issuedAt = now()
    phase(dir, 'issue_sent')
    issueSent = true
    let issued
    try {
      issued = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token, body: issueBody(contract.id, { now: issuedAt }) })
    } catch {
      phase(dir, 'issue_unknown')
      throw new ClientError('issue: no answer')
    }
    // Durable before anything else can fail: the id is what makes this grant recoverable.
    const grantId = issuedGrantId(issued)
    if (grantId) phase(dir, 'issue_received', { grant_id: grantId, status: issued?.status ?? null })
    if (issued?.status === 503) {
      phase(dir, 'issue_refused', { status: 503, error: word(issued.reason) })
      throw new ClientError(`issue answered 503 ${word(issued.reason)}: issuance is off on this project; no fallback`)
    }
    const grant = validateIssue(issued, { contractId: contract.id, now: issuedAt })
    writeExclusive(dir, 'grant', grant.token)
    phase(dir, 'issued', { grant_id: grant.grantId, scopes: grant.scopes, expires_at: grant.expiresAt })
    say(`issued grant ${grant.grantId} (${grant.scopes.join(', ')}; until ${grant.expiresAt})`)

    const listedRow = (await listGrants(tf, owner.token, contract.id)).find(g => g.id === grant.grantId)
    if (!listedRow || listedRow.revoked_at !== null || listedRow.issuer_kind !== 'owner_account') {
      throw new ClientError('the grant is not listed live after issue')
    }
    phase(dir, 'grant_listed')

    const pub = await publishableKey()
    if (!PUBLISHABLE_TOKEN.test(pub ?? '')) throw new ClientError('not a publishable key')
    writeExclusive(dir, 'agent.json', JSON.stringify({ run, contract_id: contract.id, grant_id: grant.grantId,
      scopes: grant.scopes, expires_at: grant.expiresAt, publishable_key: pub }, null, 2))
    phase(dir, 'ready')
    say(`BOOTSTRAP READY: ${dir} (grant, agent.json, invite.json)`)
  } catch (e) {
    const reason = safe(e)
    const left = removeSecrets(dir)
    const auto = issueSent ? await revokeRunGrants(tf, owner.token, contract.id) : { revoked: [], problems: [] }
    if (left.length) auto.problems.push(`could not remove: ${left.join(', ')}`)
    try { phase(dir, 'failed', { reason, auto_revoked: auto.revoked, problems: auto.problems }) } catch { auto.problems.push('the manifest could not be updated') }
    throw new ClientError(auto.problems.length
      ? `${reason}. Cleanup incomplete (${auto.problems.join('; ')}): run --revoke ${run}`
      : `${reason}. Cleaned up: ${auto.revoked.length} grant(s) revoked and read back, secrets removed`)
  }
}

/**
 * Revoke a run from any phase: every live grant on its deal, read back, and
 * both secret files removed whatever happens. Returns { revoked, problems }.
 */
export async function runRevoke({ run, dir, deps }) {
  const { tf, say = () => {} } = deps
  const m = readManifest(dir)
  if (m.run !== run) throw new ClientError('the manifest in this dir is for another run')
  const contractId = m.phases?.created?.contract_id ?? null
  let result = { revoked: [], problems: [] }
  if (contractId) {
    say(FIXTURE_BANNER)
    let owner = null
    try { owner = await tf.ownerSession() } catch (e) { result.problems.push(`owner session: ${safe(e)}`) }
    if (owner) result = await revokeRunGrants(tf, owner.token, contractId)
  }
  const left = removeSecrets(dir)
  if (left.length) result.problems.push(`could not remove: ${left.join(', ')}`)
  try { phase(dir, 'revoked', { contract_id: contractId, revoked: result.revoked, problems: result.problems }) } catch { result.problems.push('the manifest could not be updated') }
  return result
}

// ── Main ────────────────────────────────────────────────────────────────────

async function realDeps() {
  // Pinned before tfClient loads, so every request it makes is E2E-only.
  const { installPinnedFetch } = await import('../lib/pinnedFetch.mjs')
  installPinnedFetch()
  const tf = await import('../lib/tfClient.mjs')
  // The CLI child gets an allowlisted environment and an explicit project ref.
  const { publishableKey } = await import('../lib/delegatedTrial.mjs')
  return { tf, publishableKey, say: line => console.log(line) }
}

async function main() {
  const { mode, run, dir } = parseArgs(process.argv.slice(2))
  const channel = prepareChannelDir(dir, { create: mode === 'bootstrap' })
  const deps = await realDeps()
  if (mode === 'bootstrap') return runBootstrap({ run, dir: channel, deps })
  const { revoked, problems } = await runRevoke({ run, dir: channel, deps })
  for (const p of problems) console.error(`PROBLEM ${p}`)
  console.log(problems.length ? 'REVOKE INCOMPLETE' : `REVOKE VERIFIED: ${revoked.length} grant(s) revoked and read back; secrets removed`)
  if (problems.length) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => {
    console.error(e instanceof ClientError ? e.message : 'bootstrap failed (unexpected error; nothing printed from it)')
    process.exit(1)
  })
}
