// The delegated-append live trial's fixed facts, its attempt record and its
// cleanup, shared by tests/e2e/delegated-append.spec.js and the operator's
// scripts/delegated-trial-cleanup.mjs (docs/plans/row4-owner-append.md §4c
// step 5; Codex T213).
//
// THE ATTEMPT RECORD
// One approved run is one attempt id. Its state file is created exclusively,
// so the same attempt can never run twice or overlap itself; its idempotency
// key is derived from the id, so even a resent append is the same event. The
// file holds the baseline taken before any write-capable request, each phase,
// and which trial resources this attempt owns. Cleanup acts on those only.
//
// OUTPUT
// Status codes, error words matching [a-z_]{1,64} and fixed text. Never a
// response body, never CLI output, never a credential: see word().
//
// No function here writes an event. The only hosted changes are the ones
// cleanup makes: revoking the trial's own grant and unsetting
// ENTRY_DELEGATED_APPEND once this attempt has taken ownership of it.

import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_PROJECT_REF } from './e2eGuard.mjs'
import { E2E_ORIGIN, installPinnedFetch, isPinned } from './pinnedFetch.mjs'
import { selectPublishableKey } from '../../tests/e2e/publishableKey.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The approved bot fixture (T261, T267, T269): TERMS_ACCEPTED, performed_by
// creator, owned by the E2E test earner.
export const DEAL = '0853c261-035a-4703-b78a-52180e1765e3'
export const TYPE = 'performance.asserted'
export const OUT_OF_SCOPE_TYPE = 'payment.acknowledged'
export const ORIGIN = 'https://project-trustflow.vercel.app'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const GRANT_TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/
export const ATTEMPT = /^[a-z0-9][a-z0-9-]{2,39}$/
export const STATE_DIR = path.join(REPO_ROOT, 'tests/e2e/.delegated-trial')
export const BUDGET = { closed: 0, open: 1 }
export const keyFor = attempt => `trial-${attempt}`

// The E2E database, read-only at the connection. Host and ref from source control.
const DB_URL = `postgresql://postgres@db.${E2E_PROJECT_REF}.supabase.co:5432/postgres`
  + '?options=-c%20default_transaction_read_only%3Don'
// The item T269 read the same password from.
const DB_PASSWORD_REF = 'op://Private/Supabase_Kenji/trustflow e2e password DB'

/** An error whose text this module wrote: fixed words, codes and ids only. */
export class TrialError extends Error {}
/** A thrown error's text if this module wrote it, otherwise fixed text. */
export const safeMessage = e => (e instanceof TrialError ? e.message : 'request failed')

/** A response's error field, reduced to something safe to print. */
export const word = v => (v === null || v === undefined) ? 'none'
  : (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : 'unexpected')

// ── Child processes: async, bounded, allowlisted environment, output kept ───

/**
 * Run a CLI. The environment is PATH, HOME, USER, TMPDIR plus `env`: nothing
 * that could re-point a tool at another project. stdout is returned to the
 * caller only; stderr is discarded.
 */
export function run(cmd, args, { env = {}, timeout = 60_000 } = {}) {
  const base = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR']
    .filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...base, ...env }, timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout) => resolve(err
        ? { status: typeof err.code === 'number' ? err.code : -1, stdout: '' }
        : { status: 0, stdout }))
  })
}

const supabaseEnv = () => (process.env.SUPABASE_ACCESS_TOKEN ? { SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN } : {})

/** The E2E publishable key (tests/e2e/publishableKey.js grammar), by explicit ref. */
export async function publishableKey() {
  const r = await run('supabase', ['projects', 'api-keys', '--project-ref', E2E_PROJECT_REF, '-o', 'json'], { env: supabaseEnv() })
  if (r.status !== 0) throw new TrialError('supabase projects api-keys failed')
  return selectPublishableKey(r.stdout)
}

/**
 * The v5 gate as the E2E database holds it: 'open' or 'closed'. Read-only
 * connection; the password goes to the child's environment only.
 */
export async function readGate() {
  const opEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OP_')))
  const pw = await run('op', ['read', '--no-newline', DB_PASSWORD_REF], { env: opEnv, timeout: 90_000 })
  if (pw.status !== 0 || pw.stdout === '') throw new TrialError('gate readback: the E2E database password could not be read')
  const r = await run('supabase', ['db', 'query', '--db-url', DB_URL, '-o', 'json',
    'select open from private.v5_write_gate where id'], { env: { PGPASSWORD: pw.stdout }, timeout: 90_000 })
  if (r.status !== 0) throw new TrialError(`gate readback: supabase db query exited ${r.status}`)
  let rows
  try { rows = JSON.parse(r.stdout).rows } catch { rows = null }
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.open !== 'boolean') {
    throw new TrialError('gate readback: not exactly one boolean gate row')
  }
  return rows[0].open ? 'open' : 'closed'
}

// ── The grant file ──────────────────────────────────────────────────────────

/** `<grant-uuid>.<64 hex>` from a regular file owned by this user, mode exactly 0600. */
export function readGrantFile(file) {
  if (!file) throw new TrialError('TF_DELEGATED_GRANT_FILE is not set')
  // One open, no symlink followed; every check is on that descriptor.
  let fd
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
    throw new TrialError('the grant file cannot be opened (missing, unreadable or a symlink)')
  }
  let grant
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new TrialError('the grant file is not a regular file')
    if (st.uid !== process.getuid()) throw new TrialError('the grant file is not owned by this user')
    if ((st.mode & 0o7777) !== 0o600) throw new TrialError('the grant file mode must be exactly 0600')
    grant = readFileSync(fd, 'utf8').trim()
  } catch (e) {
    throw e instanceof TrialError ? e : new TrialError('the grant file cannot be read')
  } finally {
    closeSync(fd)
  }
  const m = GRANT_TOKEN.exec(grant)
  if (!m) throw new TrialError('the grant file does not hold "<uuid>.<64 hex>"')
  return { grant, grantId: m[1] }
}

export const fakeGrant = () => `${randomUUID()}.${randomBytes(32).toString('hex')}`

// ── The attempt record ──────────────────────────────────────────────────────

export const statePath = attempt => path.join(STATE_DIR, `${attempt}.json`)

/** Create the attempt's record, exclusively: an attempt runs at most once. */
export function createState(attempt, mode) {
  if (!ATTEMPT.test(attempt ?? '')) throw new TrialError('TF_DELEGATED_ATTEMPT must match [a-z0-9][a-z0-9-]{2,39}')
  if (!(mode in BUDGET)) throw new TrialError('mode must be closed or open')
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  let fd
  try { fd = openSync(statePath(attempt), 'wx', 0o600) } catch (e) {
    if (e.code === 'EEXIST') throw new TrialError(`attempt ${attempt} already ran; a retry is refused (use a new, approved attempt id)`)
    throw new TrialError('the attempt record could not be created')
  }
  const state = { attempt, mode, budget: BUDGET[mode], key: keyFor(attempt), created_at: new Date().toISOString(),
    grant_id: null, flag_owned: false, phases: {} }
  writeFileSync(fd, JSON.stringify(state, null, 2))
  closeSync(fd)
  return state
}

export function readState(attempt) {
  if (!ATTEMPT.test(attempt ?? '')) throw new TrialError('not an attempt id')
  try { return JSON.parse(readFileSync(statePath(attempt), 'utf8')) } catch { throw new TrialError(`no record for attempt ${attempt}`) }
}

/** Merge `patch` into the record, atomically (fresh 0600 file, then rename). */
export function updateState(attempt, patch) {
  const next = { ...readState(attempt), ...patch, updated_at: new Date().toISOString() }
  const tmp = `${statePath(attempt)}.${randomBytes(6).toString('hex')}.next`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, statePath(attempt))
  } catch {
    rmSync(tmp, { force: true })
    throw new TrialError('the attempt record could not be updated')
  }
  return next
}

/** Record one phase with its time, e.g. phase(a, 'append_sent', { key }). */
export const phase = (attempt, name, detail = {}) =>
  updateState(attempt, { phases: { ...readState(attempt).phases, [name]: { at: new Date().toISOString(), ...detail } } })

// ── Requests ────────────────────────────────────────────────────────────────

/** A delegated log-event call: publishable key as apikey, no Authorization unless `extra` adds one. */
export async function delegatedPost({ pub, grantHeader, body, extra = [] }) {
  if (!isPinned()) throw new TrialError('delegatedPost: the pinned fetch is not installed')
  const headers = new Headers([['Content-Type', 'application/json'], ['apikey', pub], ['Origin', ORIGIN]])
  if (grantHeader !== null) headers.append('x-trustflow-grant', grantHeader)
  for (const [k, v] of extra) headers.append(k, v)
  const r = await fetch(`${E2E_ORIGIN}/functions/v1/log-event`, { method: 'POST', headers, body: JSON.stringify(body) })
  let json = null
  try { json = JSON.parse(await r.text()) } catch { /* compared by status only */ }
  return { status: r.status, error: word(json?.error), json }
}

/** Rows holding exactly this idempotency key, anywhere the owner can read. */
export async function rowsWithKey(tf, token, key) {
  const r = await tf.rest(token, `events?idempotency_key=eq.${encodeURIComponent(key)}&select=id,contract_id`)
  if (r.status !== 200 || !Array.isArray(r.body)) throw new TrialError(`by-key readback answered ${r.status}`)
  return r.body
}

/** The owner's list entry for a grant on DEAL, or null. */
export async function listedGrant(tf, token, grantId, contractId = DEAL) {
  const list = await tf.invoke('manage-entry-agent-credential', { ownerToken: token, body: { action: 'list', contract_id: contractId } })
  if (list.status !== 200) throw new TrialError(`grant list answered ${list.status} ${word(list.reason)}`)
  return (list.data?.grants ?? []).find(g => g.id === grantId) ?? null
}

export async function loadClient() {
  installPinnedFetch()
  return { ...(await import('./tfClient.mjs')), ...(await import('./pagedEvents.mjs')) }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Undo what this attempt owns, verify each step, and record the result.
 * `attempt` names the record; without one (a run that died before creating
 * it) the operator names the resources: `grantId` (must be listed on DEAL) and
 * `unsetFlag`. Returns the problems found; an empty list means verified.
 */
export async function cleanupTrial({ attempt = null, grantId = null, unsetFlag = false } = {}) {
  const problems = []
  const state = attempt ? readState(attempt) : null
  const grantToRevoke = state?.grant_id ?? grantId
  const flag = (state?.flag_owned ?? false) || unsetFlag
  const result = {}
  let tf, owner
  try {
    tf = await loadClient()
    owner = await tf.ownerSession()
  } catch { problems.push('the owner session could not be opened; revoke the grant and unset the flag by hand') }

  if (grantToRevoke && owner) {
    try {
      if (!UUID.test(grantToRevoke)) throw new TrialError('not a grant id')
      let g = await listedGrant(tf, owner.token, grantToRevoke)
      if (!g) throw new TrialError('the grant is not listed on the fixture deal')
      if (g.revoked_at === null) {
        const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token,
          body: { action: 'revoke', contract_id: DEAL, id: grantToRevoke } })
        if (r.status !== 200) problems.push(`revoke answered ${r.status} ${word(r.reason)}`)
        g = await listedGrant(tf, owner.token, grantToRevoke)
      }
      result.grant_revoked = g?.revoked_at !== null && g?.revoked_at !== undefined
      if (!result.grant_revoked) problems.push('the grant list does not show the grant revoked; revoke it by hand')
    } catch (e) { problems.push(`revoke could not be verified (${safeMessage(e)}); revoke it by hand`) }
  }

  // Not owned (never seen on by this attempt): left as found; the operator
  // who turned it on says so with --unset-flag.
  result.flag_touched = flag
  if (flag) {
    const u = await run('supabase', ['secrets', 'unset', 'ENTRY_DELEGATED_APPEND', '--project-ref', E2E_PROJECT_REF],
      { env: supabaseEnv(), timeout: 120_000 })
    if (u.status !== 0) problems.push(`supabase secrets unset exited ${u.status}; unset ENTRY_DELEGATED_APPEND by hand`)
    // A secret change reaches new isolates within seconds; allow a short, bounded settle.
    let last = null
    try {
      installPinnedFetch()
      const pub = await publishableKey()
      // Until the flag's own answer; a gateway or restart 503 is retried.
      const off = r => r?.status === 503 && r?.error === 'delegated_append_unavailable'
      for (let i = 0; i < 10 && !off(last); i++) {
        if (i) await new Promise(res => setTimeout(res, 3000))
        last = await delegatedPost({ pub, grantHeader: '',
          body: { type: TYPE, contract_id: DEAL, payload: {}, idempotency_key: null } }).catch(() => null)
      }
    } catch { /* recorded below */ }
    result.flag_off = last?.status === 503 && last?.error === 'delegated_append_unavailable'
    if (!result.flag_off) problems.push(`after unset the route answered ${last?.status ?? 'nothing'} ${last?.error ?? ''}, not 503`)
  }

  try { result.gate = await readGate() } catch (e) { problems.push(safeMessage(e)) }

  if (state?.baseline && owner) {
    try {
      const { rows } = await tf.fetchAllEvents(q => tf.rest(owner.token, q), DEAL, 'id')
      result.rows_written = rows.length - state.baseline.count
      result.rows_with_key = (await rowsWithKey(tf, owner.token, state.key)).length
      if (result.rows_written > state.budget || result.rows_with_key > state.budget) {
        problems.push(`the attempt wrote ${result.rows_written} rows (${result.rows_with_key} with its key), over its budget of ${state.budget}`)
      }
    } catch { problems.push('the final row count could not be read') }
  }

  if (attempt) updateState(attempt, { cleanup: { at: new Date().toISOString(), ...result, problems } })
  return { problems, result }
}
