import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync, unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installPinnedFetch } from '../../scripts/lib/pinnedFetch.mjs'
import {
  ClientError, assertPrivateDir, delegatedAppend, delegatedRead, delegatedRequest, readGrantFile,
} from '../../scripts/lib/delegatedClient.mjs'
import {
  DEFAULT_SCOPES, DEFAULT_TTL_MS, canonicalChannelDir, issueBody, parseArgs, phase, prepareChannelDir,
  resolveRecordedGrantId, runBootstrap, runRevoke, validateIssue, writeExclusive,
} from '../../scripts/agents/bootstrap.mjs'
import { assertGrantOnly, assertedKey, readAgentConfig, runAgent } from '../../scripts/agents/owner-delegate-agent.mjs'
import { run as runChild } from '../../scripts/lib/delegatedTrial.mjs'

// Row 7 bot pieces, offline: the delegated client, the bootstrap (its channel
// dir, files, and every post-issue failure path against a stub owner client),
// and the delegate bot. No network: fetch is a stub behind the pin, and the
// owner client is a stub implementing the issue/list/revoke contract of
// supabase/functions/manage-entry-agent-credential/index.ts.

const E2E = 'https://yqjtawffpesplqyurlpj.supabase.co'
const CID = '11111111-1111-4111-8111-111111111111'
const GID = '22222222-2222-4222-8222-222222222222'
const SECRET = 'ab'.repeat(32)
const INVITE = 'invite-token-secret-value'
const PUB = 'sb_publishable_test_key_1'
const thrown = f => { try { f() } catch (e) { return e } return null }
const thrownAsync = async p => { try { await p } catch (e) { return e } return null }
const tmp = prefix => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
const mode = f => statSync(f).mode & 0o7777
const manifest = d => JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'))

/** A stub of the owner client: create, issue, list and revoke, with the server's shapes. */
function stubTf({ issue = 'ok', revokeFails = false, listFails = false } = {}) {
  const grants = []
  const calls = []
  const live = () => grants.filter(g => g.revoked_at === null)
  return {
    grants, calls, live,
    PROJECT_REF: 'yqjtawffpesplqyurlpj',
    async ownerSession() { return { token: 'owner-token', userId: 'u' } },
    async rest(_t, p) {
      calls.push(p)
      return { status: 200, body: { status: 'created', contract: { id: CID, invite_token: INVITE } } }
    },
    async invoke(name, { body }) {
      calls.push(`${name}:${body.action}`)
      if (body.action === 'list') return listFails ? { status: 500, data: null, reason: 'list_failed' } : { status: 200, data: { grants: grants.map(g => ({ ...g })) } }
      if (body.action === 'revoke') {
        if (revokeFails) return { status: 500, data: null, reason: 'revoke_failed' }
        const g = grants.find(x => x.id === body.id)
        if (g) g.revoked_at = new Date().toISOString()
        return { status: 200, data: { status: 'revoked' } }
      }
      if (issue === 'disabled') return { status: 503, data: null, reason: 'issuance_disabled' }
      if (issue === 'throw_empty') throw new TypeError('network failure before commit')
      if (issue === 'mismatched_other_id') {
        const g = { status: 'issued', id: OTHER, contract_id: CID, issuer_kind: 'owner_account',
          scopes: [...body.scopes, 'payment.reported'], expires_at: body.expires_at }
        return { status: 201, data: { grant: g, secret: SECRET } }
      }
      const row = { id: GID, contract_id: CID, issuer_kind: 'owner_account', scopes: [...body.scopes],
        created_at: new Date().toISOString(), expires_at: body.expires_at, revoked_at: null }
      grants.push(row)
      if (issue === 'throw') throw new TypeError('network failure')
      if (issue === 'gateway_503') return { status: 503, data: null, reason: 'http_503' }
      const g = { status: 'issued', ...row, scopes: issue === 'broader' ? [...body.scopes, 'payment.reported'] : row.scopes }
      return { status: 201, data: { grant: g, secret: SECRET } }
    },
  }
}
const deps = (tf, extra = {}) => ({ tf, publishableKey: async () => PUB, ...extra })
const OTHER = '33333333-3333-4333-8333-333333333333'
/** A grant on the same deal the run did not issue (e.g. one the owner made later in the UI). */
const unrelated = (over = {}) => ({ id: OTHER, contract_id: CID, issuer_kind: 'owner_account', scopes: [...DEFAULT_SCOPES],
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null, ...over })

describe('delegated client', () => {
  let calls, original
  beforeEach(() => {
    original = globalThis.fetch
    calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ event: { id: GID }, deduplicated: false, error: 'Not A Word!' }), { status: 201 })
    }
    installPinnedFetch()
  })
  afterEach(() => { globalThis.fetch = original })

  it('sends the publishable key and the grant, no Authorization, to E2E only, with redirects refused', async () => {
    const r = await delegatedAppend({ pub: PUB, grant: `${GID}.${SECRET}`, contractId: CID, type: 'performance.asserted', idempotencyKey: 'k1' })
    expect(r.status).toBe(201)
    expect(r.error).toBe('unexpected')
    const { url, init } = calls[0]
    expect(url).toBe(`${E2E}/functions/v1/log-event`)
    expect(init.redirect).toBe('error')
    expect(init.headers.get('apikey')).toBe(PUB)
    expect(init.headers.get('x-trustflow-grant')).toBe(`${GID}.${SECRET}`)
    expect(init.headers.has('authorization')).toBe(false)
    expect(JSON.parse(init.body)).toEqual({ type: 'performance.asserted', contract_id: CID, payload: {}, idempotency_key: 'k1' })
  })

  it('reads with exactly one body key', async () => {
    await delegatedRead({ pub: PUB, grant: `${GID}.${SECRET}`, contractId: CID })
    expect(calls[0].url).toBe(`${E2E}/functions/v1/delegated-owner-read`)
    expect(JSON.parse(calls[0].init.body)).toEqual({ contract_id: CID })
  })

  it('refuses without the pin, and refuses a non-function path', async () => {
    globalThis.fetch = async () => new Response('{}')
    await expect(delegatedRequest({ fn: 'log-event', pub: PUB, grantHeader: 'x', body: {} })).rejects.toBeInstanceOf(ClientError)
    installPinnedFetch()
    await expect(delegatedRequest({ fn: '../rest/v1/events', pub: PUB, grantHeader: 'x', body: {} })).rejects.toThrow('not a function name')
  })

  it('reads a 0600 grant file and refuses a loose one', () => {
    const d = tmp('tf-bot-')
    try {
      const f = path.join(d, 'grant')
      writeFileSync(f, `${GID}.${SECRET}\n`, { mode: 0o600 })
      expect(readGrantFile(f)).toEqual({ grant: `${GID}.${SECRET}`, grantId: GID })
      chmodSync(f, 0o644)
      expect(thrown(() => readGrantFile(f))?.message).toBe('the grant file mode must be exactly 0600')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('child processes get an allowlisted environment, not the caller\'s', async () => {
    process.env.TF_TEST_LEAK_SECRET = 'should-not-reach-a-child'
    try {
      const r = await runChild('/usr/bin/env', [], { env: { EXTRA_OK: '1' } })
      expect(r.status).toBe(0)
      const names = r.stdout.split('\n').filter(Boolean).map(l => l.split('=')[0])
      expect(names).not.toContain('TF_TEST_LEAK_SECRET')
      expect(names).toContain('EXTRA_OK')
      expect(names.every(n => ['PATH', 'HOME', 'USER', 'TMPDIR', 'EXTRA_OK'].includes(n))).toBe(true)
    } finally { delete process.env.TF_TEST_LEAK_SECRET }
  })
})

describe('bootstrap: arguments and request', () => {
  it('parses exactly one mode, a run id and a dir; repeated or unknown flags are refused', () => {
    expect(parseArgs(['--run', 'bot-1', '--dir', '/tmp/x'])).toEqual({ mode: 'bootstrap', run: 'bot-1', dir: '/tmp/x' })
    expect(parseArgs(['--revoke', 'bot-1', '--dir', '/tmp/x']).mode).toBe('revoke')
    for (const bad of [[], ['--run', 'bot-1'], ['--run', 'a1b', '--revoke', 'b2c', '--dir', '/x'], ['--run', 'Bad!', '--dir', '/x'],
      ['--run', 'bot-1', '--dir', '/x', '--sql', 'y'], ['--run', 'bot-1', '--dir', '/x', '--dir', '/y'], ['--run', 'bot-1', '--dir']]) {
      expect(thrown(() => parseArgs(bad)), JSON.stringify(bad)).toBeInstanceOf(ClientError)
    }
  })

  it('asks for least privilege by default: owner_account, read + performance.asserted, 24 hours', () => {
    const now = Date.parse('2026-12-01T00:00:00.000Z')
    expect(issueBody(CID, { now })).toEqual({ action: 'issue', contract_id: CID, issuer_kind: 'owner_account',
      scopes: ['read', 'performance.asserted'], expires_at: '2026-12-02T00:00:00.000Z' })
    expect(DEFAULT_SCOPES).not.toContain('accept')
    expect(DEFAULT_TTL_MS).toBe(24 * 3600 * 1000)
  })

  it('accepts only an issue response matching the request, and never prints the secret', () => {
    const now = Date.now()
    const good = { status: 201, data: { secret: SECRET, grant: { id: GID, contract_id: CID, issuer_kind: 'owner_account',
      scopes: ['read', 'performance.asserted'], expires_at: new Date(now + DEFAULT_TTL_MS).toISOString() } } }
    expect(validateIssue(good, { contractId: CID, now })).toMatchObject({ grantId: GID, token: `${GID}.${SECRET}` })
    const variant = (patch, grantPatch = {}) => ({ ...good, ...patch, data: { ...good.data, ...(patch.data ?? {}), grant: { ...good.data.grant, ...grantPatch } } })
    for (const [label, res, field] of [
      ['broader scopes', variant({}, { scopes: ['read', 'performance.asserted', 'payment.reported'] }), 'scopes'],
      ['another deal', variant({}, { contract_id: GID }), 'contract_id'],
      ['counterpart kind', variant({}, { issuer_kind: 'counterpart_account' }), 'issuer_kind'],
      ['expiry beyond 24h', variant({}, { expires_at: new Date(now + 2 * DEFAULT_TTL_MS).toISOString() }), 'expires_at'],
      ['bad secret', variant({ data: { secret: 'XYZ' } }), 'secret'],
    ]) {
      const e = thrown(() => validateIssue(res, { contractId: CID, now }))
      expect(e, label).toBeInstanceOf(ClientError)
      expect(e.message, label).toContain(field)
      expect(e.message, label).not.toContain(SECRET)
    }
  })
})

describe('bootstrap: channel dir containment and privacy', () => {
  let root
  beforeEach(() => { root = tmp('tf-chan-') })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  const repo = () => { const r = path.join(root, 'repo'); mkdirSync(r, { recursive: true }); return r }

  it('judges containment on the canonical path, so a symlinked ancestor cannot move a dir into the repo', () => {
    const r = repo()
    mkdirSync(path.join(r, 'src'))
    symlinkSync(path.join(r, 'src'), path.join(root, 'alias'))
    expect(thrown(() => canonicalChannelDir(path.join(root, 'alias', 'chan'), { repoRoot: r, isIgnored: () => false }))?.message)
      .toBe('the channel dir is inside the repository and not git-ignored')
    expect(canonicalChannelDir(path.join(root, 'alias', 'chan'), { repoRoot: r, isIgnored: () => true }).canonical)
      .toBe(path.join(r, 'src', 'chan'))
    // The same through an existing dir, which takes the realpath branch.
    mkdirSync(path.join(r, 'src', 'chan'))
    expect(thrown(() => canonicalChannelDir(path.join(root, 'alias', 'chan'), { repoRoot: r, isIgnored: () => false }))?.message)
      .toBe('the channel dir is inside the repository and not git-ignored')
    // A repo-local name that merely starts with `..` is inside, so it must be git-ignored.
    expect(thrown(() => canonicalChannelDir(path.join(r, '..chan'), { repoRoot: r, isIgnored: () => false }))?.message)
      .toBe('the channel dir is inside the repository and not git-ignored')
    mkdirSync(path.join(r, '..chan'))
    expect(thrown(() => canonicalChannelDir(path.join(r, '..chan'), { repoRoot: r, isIgnored: () => false }))?.message)
      .toBe('the channel dir is inside the repository and not git-ignored')
    expect(canonicalChannelDir(path.join(root, 'sibling'), { repoRoot: r, isIgnored: () => false }).canonical)
      .toBe(path.join(root, 'sibling'))
    mkdirSync(path.join(root, 'outside'))
    symlinkSync(path.join(root, 'outside'), path.join(r, 'out'))
    expect(canonicalChannelDir(path.join(r, 'out', 'chan'), { repoRoot: r, isIgnored: () => false }).canonical)
      .toBe(path.join(root, 'outside', 'chan'))
  })

  it('refuses a leaf symlink, a missing parent, a loose or foreign directory; creates exactly 0700', () => {
    const r = repo()
    mkdirSync(path.join(root, 'real'), { mode: 0o700 })
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    const opts = { repoRoot: r, isIgnored: () => false }
    expect(thrown(() => prepareChannelDir(path.join(root, 'link'), opts))?.message).toBe('the channel dir is a symlink')
    // lstat("link/") follows the link; the trailing slash must not hide it.
    for (const p of [`${path.join(root, 'link')}/`, `${path.join(root, 'link')}//`, `${path.join(root, 'link')}/.`]) {
      expect(thrown(() => assertPrivateDir(p))?.message, p).toBe('the channel dir is a symlink')
    }
    expect(assertPrivateDir(`${path.join(root, 'real')}/`)).toBe(path.join(root, 'real'))
    expect(thrown(() => prepareChannelDir(path.join(root, 'no', 'such', 'chan'), opts))?.message).toBe('the channel dir\'s parent does not exist')
    mkdirSync(path.join(root, 'loose'), { mode: 0o755 })
    chmodSync(path.join(root, 'loose'), 0o755)
    expect(thrown(() => prepareChannelDir(path.join(root, 'loose'), opts))?.message).toBe('the channel dir mode must be exactly 0700')
    expect(thrown(() => prepareChannelDir(path.join(root, 'fresh'), { ...opts, create: false }))?.message).toBe('the channel dir does not exist')
    // A umask that strips owner bits: mkdir alone would leave the dir unusable (0000), so the mode is set exactly.
    const oldMask = process.umask(0o700)
    try {
      const made = prepareChannelDir(path.join(root, 'fresh'), opts)
      expect(mode(made)).toBe(0o700)
    } finally { process.umask(oldMask) }
    expect(thrown(() => assertPrivateDir(path.join(root, 'real', 'missing')))?.message).toBe('the channel dir does not exist')
  })
})

describe('bootstrap: files are exclusive, private and complete or absent', () => {
  let d
  beforeEach(() => { d = tmp('tf-files-'); chmodSync(d, 0o700) })
  afterEach(() => { rmSync(d, { recursive: true, force: true }) })

  it('creates 0600, refuses an existing file or a symlink in its place, and removes a partial write', () => {
    writeExclusive(d, 'manifest.json', JSON.stringify({ run: 'bot-1', phases: {} }))
    expect(mode(path.join(d, 'manifest.json'))).toBe(0o600)
    expect(thrown(() => writeExclusive(d, 'manifest.json', '{}'))?.message).toBe('manifest.json already exists in the channel dir')
    symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'grant'))
    expect(thrown(() => writeExclusive(d, 'grant', 'x'))).toBeInstanceOf(ClientError)
    expect(existsSync(path.join(d, 'elsewhere'))).toBe(false)
    const e = thrown(() => writeExclusive(d, 'invite.json', 'x', { write: () => { throw new Error('disk full') } }))
    expect(e?.message).toBe('invite.json could not be written; removed')
    expect(existsSync(path.join(d, 'invite.json'))).toBe(false)
  })

  it('records phases durably without losing earlier ones, and leaves no staging file', () => {
    writeExclusive(d, 'manifest.json', JSON.stringify({ run: 'bot-1', phases: {} }))
    phase(d, 'created', { contract_id: CID })
    phase(d, 'issued', { grant_id: GID })
    expect(Object.keys(manifest(d).phases)).toEqual(['created', 'issued'])
    expect(mode(path.join(d, 'manifest.json'))).toBe(0o600)
    expect(readFileSync(path.join(d, 'manifest.json'), 'utf8')).not.toMatch(/\.next/)
    expect(statSync(d).isDirectory()).toBe(true)
  })
})

describe('bootstrap: the run, against a stub owner client', () => {
  let d
  beforeEach(() => { d = tmp('tf-run-'); chmodSync(d, 0o700) })
  afterEach(() => { rmSync(d, { recursive: true, force: true }) })
  const files = () => ['grant', 'invite.json', 'agent.json'].filter(n => existsSync(path.join(d, n)))

  it('success: one deal, one least-privilege grant, private files, and no secret in the manifest', async () => {
    const tf = stubTf()
    await runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(Object.keys(manifest(d).phases)).toEqual(['owner_session', 'create_sent', 'created', 'issue_sent', 'issue_received', 'issued', 'grant_listed', 'ready'])
    expect(files()).toEqual(['grant', 'invite.json', 'agent.json'])
    for (const n of files()) expect(mode(path.join(d, n)), n).toBe(0o600)
    expect(readFileSync(path.join(d, 'grant'), 'utf8')).toBe(`${GID}.${SECRET}`)
    expect(JSON.parse(readFileSync(path.join(d, 'agent.json'), 'utf8'))).toMatchObject({ contract_id: CID, grant_id: GID, scopes: DEFAULT_SCOPES, publishable_key: PUB })
    const text = readFileSync(path.join(d, 'manifest.json'), 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(INVITE)
    expect(tf.live()).toHaveLength(1)
    const again = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(stubTf()) }))
    expect(again?.message).toBe('manifest.json already exists in the channel dir')
  })

  it('a response that fails validation: observed id is recorded for diagnostics, nothing is auto-revoked, secrets removed', async () => {
    const tf = stubTf({ issue: 'broader' })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toBe(`issue response differs from the request in: scopes. Cleanup incomplete (observed grant id ${GID} was never validated against the run's request: reconcile manually in the owner UI; nothing was revoked): run --revoke bot-1`)
    const m = manifest(d)
    expect(m.phases.issue_received.observed_grant_id).toBe(GID)
    expect(m.phases.issued).toBeUndefined()
    expect(Object.keys(m.phases).indexOf('issue_received')).toBeLessThan(Object.keys(m.phases).indexOf('failed'))
    expect(m.phases.failed).toMatchObject({ auto_revoked: [], problems: [expect.stringContaining('never validated')] })
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(tf.live()).toHaveLength(1)
    expect(files()).toEqual([])
  })

  it('a grant file that cannot be written: validated grant is revoked, secrets removed', async () => {
    const tf = stubTf()
    writeFileSync(path.join(d, 'grant'), 'squatter', { mode: 0o600 })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toMatch(/^grant already exists in the channel dir\. Cleaned up: 1 grant/)
    expect(tf.live()).toHaveLength(0)
    expect(files()).toEqual([])
  })

  it('an issue whose answer never arrived: does not auto-revoke by inferred match and asks for manual reconciliation', async () => {
    const tf = stubTf({ issue: 'throw' })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toBe('issue: no answer. Cleanup incomplete (issuance outcome is unknown (1 grant(s) currently listed on the run\'s deal, no validated grant id): reconcile manually in the owner UI; nothing was revoked): run --revoke bot-1')
    expect(manifest(d).phases.issue_unknown).toBeTruthy()
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(tf.live()).toHaveLength(1)
  })

  it('a failure after issue whose cleanup also fails points the operator at --revoke, which then finishes from that phase', async () => {
    const tf = stubTf({ revokeFails: true })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf, { publishableKey: async () => 'eyJ.not-publishable' }) }))
    expect(e?.message).toMatch(/^not a publishable key\. Cleanup incomplete \(revoke .* answered 500 revoke_failed; still live after revoke: .*\): run --revoke bot-1$/)
    expect(files()).toEqual([])
    expect(tf.live()).toHaveLength(1)
    // The operator's revoke, with a working client over the same server state.
    const ok = stubTf(); ok.grants.push(...tf.grants)
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(ok) })
    expect(r).toEqual({ revoked: [GID], problems: [] })
    expect(ok.live()).toHaveLength(0)
    expect(manifest(d).phases.revoked).toMatchObject({ contract_id: CID, revoked: [GID], problems: [] })
  })

  it('issuance off (503 issuance_disabled): stops with no fallback, no grant, and --revoke stays clean with no remote call', async () => {
    const tf = stubTf({ issue: 'disabled' })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toBe('issue answered 503 issuance_disabled: issuance is off on this project; no fallback. Cleaned up: 0 grant(s) revoked and read back, secrets removed')
    expect(tf.calls.some(c => /sql|rpc\/issue/i.test(c))).toBe(false)
    expect(manifest(d).phases.issue_refused).toMatchObject({ status: 503, error: 'issuance_disabled' })
    expect(files()).toEqual([])
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r).toEqual({ revoked: [], problems: [] })
    expect(tf.calls.filter(c => c.endsWith(':revoke') || c.endsWith(':list'))).toEqual([])
  })

  it('gateway/platform 503 (http_503) after grant creation stays unresolved in bootstrap and --revoke, including persisted manifests', async () => {
    const tf = stubTf({ issue: 'gateway_503' })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toBe('issue answered 503 unexpected. Cleanup incomplete (issuance outcome is unknown (1 grant(s) currently listed on the run\'s deal, no validated grant id): reconcile manually in the owner UI; nothing was revoked): run --revoke bot-1')
    expect(manifest(d).phases.issue_refused).toBeUndefined()
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(tf.live()).toHaveLength(1)
    expect(files()).toEqual([])

    // --revoke also stays unresolved and makes no revoke call.
    const r1 = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r1.revoked).toEqual([])
    expect(r1.problems[0]).toMatch(/issuance outcome is unknown \(1 grant\(s\) currently listed/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(tf.live()).toHaveLength(1)

    // Persisted manifest with non-issuance_disabled or malformed issue_refused must also fail closed.
    for (const badRefusal of [{ status: 503, error: 'http_503' }, { status: 503, error: 'unexpected' }, { status: 500, error: 'issuance_disabled' }, {}]) {
      const m = manifest(d)
      m.phases.issue_refused = badRefusal
      writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m, null, 2), { mode: 0o600 })
      const r2 = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
      expect(r2.revoked, JSON.stringify(badRefusal)).toEqual([])
      expect(r2.problems.length, JSON.stringify(badRefusal)).toBeGreaterThan(0)
      expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    }
  })

  it('--revoke reports a list failure as a problem, still removes both secrets, and refuses another run\'s manifest', async () => {
    await runBootstrap({ run: 'bot-1', dir: d, deps: deps(stubTf()) })
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(stubTf({ listFails: true })) })
    expect(r.problems).toEqual(['revoke readback: grant list answered 500 list_failed'])
    expect(files()).toEqual(['agent.json'])
    expect((await thrownAsync(runRevoke({ run: 'bot-2', dir: d, deps: deps(stubTf()) })))?.message).toBe('the manifest in this dir is for another run')
  })
})

describe('bootstrap: recovery revokes only the run\'s grant, and survives cleanup errors', () => {
  let d
  beforeEach(() => { d = tmp('tf-rec-'); chmodSync(d, 0o700) })
  afterEach(() => { rmSync(d, { recursive: true, force: true }) })
  const liveIds = tf => tf.live().map(g => g.id).sort()
  const invokes = tf => tf.calls.filter(c => c.startsWith('manage-entry-agent-credential:'))
  /** A secret file that rm cannot remove (a non-empty directory: rmSync without recursive throws). */
  const stuck = name => { mkdirSync(path.join(d, name)); writeFileSync(path.join(d, name, 'x'), 'x') }

  it('a secret that cannot be removed does not stop grant recovery, and the operator is pointed at --revoke', async () => {
    const tf = stubTf()
    stuck('grant')
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e).toBeInstanceOf(ClientError)
    expect(e.message).toBe('grant already exists in the channel dir. Cleanup incomplete (could not remove: grant): run --revoke bot-1')
    expect(tf.live()).toHaveLength(0)
    expect(existsSync(path.join(d, 'invite.json'))).toBe(false)
    expect(manifest(d).phases.failed).toMatchObject({ auto_revoked: [GID], problems: ['could not remove: grant'] })
    // --revoke with the same stuck file: still revokes (idempotently), removes what it can, records the phase.
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r).toEqual({ revoked: [GID], problems: ['could not remove: grant'] })
    expect(manifest(d).phases.revoked).toMatchObject({ revoked: [GID], problems: ['could not remove: grant'] })
  })

  it('--revoke with a recorded grant revokes that grant only, never another grant on the deal', async () => {
    const tf = stubTf()
    await runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) })
    tf.grants.push(unrelated())
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r).toEqual({ revoked: [GID], problems: [] })
    expect(liveIds(tf)).toEqual([OTHER])
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toHaveLength(1)
  })

  it('a failure after a validated issue revokes that grant only, even with another live grant on the deal', async () => {
    const tf = stubTf()
    tf.grants.push(unrelated())
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf, { publishableKey: async () => 'bad-key' }) }))
    expect(e?.message).toMatch(/^not a publishable key\. Cleaned up: 1 grant\(s\) revoked and read back/)
    expect(liveIds(tf)).toEqual([OTHER])
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toHaveLength(1)
  })

  it('before an issue was sent, --revoke touches nothing remote and only removes local secrets', async () => {
    const tf = stubTf()
    writeFileSync(path.join(d, 'invite.json'), 'squatter', { mode: 0o600 })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toMatch(/^invite\.json already exists in the channel dir\. Cleaned up: 0 grant/)
    expect(manifest(d).phases.issue_sent).toBeUndefined()
    expect(invokes(tf)).toEqual([])
    tf.grants.push(unrelated())
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r).toEqual({ revoked: [], problems: [] })
    expect(invokes(tf)).toEqual([])
    expect(liveIds(tf)).toEqual([OTHER])
    expect(existsSync(path.join(d, 'invite.json'))).toBe(false)
  })

  it('unknown issuance with empty initial list stays unresolved (even if a delayed grant commits later)', async () => {
    const tf = stubTf({ issue: 'throw_empty' })
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toMatch(/^issue: no answer\. Cleanup incomplete \(issuance outcome is unknown and 0 grants are currently listed on the run's deal \(a delayed commit may still land\): reconcile manually in the owner UI; nothing was revoked\): run --revoke bot-1$/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    // First --revoke sees empty list: still unresolved, never verified.
    const r1 = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r1.revoked).toEqual([])
    expect(r1.problems[0]).toMatch(/0 grants are currently listed.*delayed commit/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    // Delayed grant now commits on the server; second --revoke still refuses inferred auto-revoke.
    tf.grants.push(unrelated({ id: GID, expires_at: manifest(d).phases.issue_sent.expires_at }))
    const r2 = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r2.revoked).toEqual([])
    expect(r2.problems[0]).toMatch(/1 grant\(s\) currently listed.*no validated grant id/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([GID])
  })

  it('unknown issuance with a sole unrelated grant matching every request field revokes nothing', async () => {
    const tf = stubTf({ issue: 'throw_empty' })
    const fixedNow = Date.parse('2026-12-01T00:00:00.000Z')
    const matchingExpiry = new Date(fixedNow + DEFAULT_TTL_MS).toISOString()
    tf.grants.push(unrelated({ id: OTHER, expires_at: matchingExpiry, created_at: new Date(fixedNow).toISOString() }))
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf, { now: () => fixedNow }) }))
    expect(e?.message).toMatch(/Cleanup incomplete \(issuance outcome is unknown \(1 grant\(s\) currently listed on the run's deal, no validated grant id\): reconcile manually/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([OTHER])
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r.revoked).toEqual([])
    expect(r.problems[0]).toMatch(/1 grant\(s\) currently listed/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([OTHER])
  })

  it('mismatched issue response naming another grant on the deal never revokes that grant', async () => {
    const tf = stubTf({ issue: 'mismatched_other_id' })
    tf.grants.push(unrelated({ id: OTHER }))
    const e = await thrownAsync(runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) }))
    expect(e?.message).toMatch(/issue response differs from the request in: scopes\. Cleanup incomplete \(observed grant id/)
    expect(manifest(d).phases.issue_received.observed_grant_id).toBe(OTHER)
    expect(manifest(d).phases.issued).toBeUndefined()
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([OTHER])
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r.revoked).toEqual([])
    expect(r.problems[0]).toMatch(/never validated against the run's request/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([OTHER])
  })

  it('conflicting or malformed manifest grant ids fail closed without revoking anything', async () => {
    const tf = stubTf()
    await runBootstrap({ run: 'bot-1', dir: d, deps: deps(tf) })
    tf.grants.push(unrelated({ id: OTHER }))
    // Tamper manifest so issue_received disagrees with issued.
    const m = manifest(d)
    m.phases.issue_received.observed_grant_id = OTHER
    writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m, null, 2), { mode: 0o600 })
    const r = await runRevoke({ run: 'bot-1', dir: d, deps: deps(tf) })
    expect(r.revoked).toEqual([])
    expect(r.problems[0]).toMatch(/conflicting grant ids in manifest/)
    expect(tf.calls.filter(c => c.endsWith(':revoke'))).toEqual([])
    expect(liveIds(tf)).toEqual([GID, OTHER])

    expect(resolveRecordedGrantId({ phases: { issued: { grant_id: GID }, issue_received: { observed_grant_id: GID } } })).toEqual({ status: 'trusted', id: GID })
    expect(resolveRecordedGrantId({ phases: { issued: { grant_id: 'NOT-A-UUID' } } }).status).toBe('conflict')
    expect(resolveRecordedGrantId({ phases: { issue_received: { observed_grant_id: 'NOT-A-UUID' } } }).status).toBe('conflict')
    expect(resolveRecordedGrantId({ phases: { issue_received: { observed_grant_id: GID, grant_id: OTHER } } }).status).toBe('conflict')
    expect(resolveRecordedGrantId({ phases: { issue_received: { observed_grant_id: GID } } }).status).toBe('untrusted')
    expect(resolveRecordedGrantId({ phases: {} })).toEqual({ status: 'none' })
  })
})

describe('delegate bot', () => {
  let d
  const cfg = { run: 'bot-1', contract_id: CID, grant_id: GID, scopes: ['read', 'performance.asserted'], expires_at: 'x', publishable_key: PUB }
  const setup = (over = {}) => {
    writeFileSync(path.join(d, 'agent.json'), JSON.stringify({ ...cfg, ...over }))
    writeFileSync(path.join(d, 'grant'), `${GID}.${SECRET}`, { mode: 0o600 })
  }
  beforeEach(() => { d = tmp('tf-agent-'); chmodSync(d, 0o700) })
  afterEach(() => { rmSync(d, { recursive: true, force: true }) })
  const ok = { read: async () => ({ status: 200, error: 'none', json: {} }),
    append: async () => ({ status: 200, error: 'none', json: { deduplicated: true, event: { id: GID } } }) }

  it('refuses an environment carrying any credential, and allows terminal bookkeeping', () => {
    expect(assertGrantOnly({ PATH: '/bin', HOME: '/h', TF_CHANNEL_DIR: d, TERM_SESSION_ID: 'w0', ITERM_SESSION_ID: 'x' })).toBeUndefined()
    for (const k of ['TF_TEST_EARNER_EMAIL', 'TF_TEST_EARNER_PASSWORD', 'TF_OWNER_KEY_FILE', 'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ACCESS_TOKEN', 'VITE_SUPABASE_ANON_KEY', 'PGPASSWORD', 'OP_SESSION_my', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) {
      expect(thrown(() => assertGrantOnly({ [k]: 'x' }))?.message, k).toContain(k)
    }
  })

  it('runs read, append and replay under the grant', async () => {
    setup()
    expect(await runAgent({ dir: d, env: {}, client: ok })).toEqual([])
  })

  it('a grant allowing none of its actions is a failure, not a quiet pass', async () => {
    setup({ scopes: ['payment.reported'] })
    expect((await thrownAsync(runAgent({ dir: d, env: {}, client: ok })))?.message).toMatch(/^the grant allows none of this bot's actions/)
  })

  it('a 503 read is a failure, and a failed append is not followed by a replay', async () => {
    setup()
    let appends = 0
    const failures = await runAgent({ dir: d, env: {}, client: {
      read: async () => ({ status: 503, error: 'delegated_read_unavailable', json: null }),
      append: async () => { appends += 1; return { status: 403, error: 'delegation_refused', json: null } } } })
    expect(failures).toEqual(['read the deal under the grant', 'asserted performance under the grant'])
    expect(appends).toBe(1)
  })

  it('refuses a loose channel dir, a credential env, and a grant file naming another grant', async () => {
    setup()
    expect((await thrownAsync(runAgent({ dir: d, env: { GITHUB_TOKEN: 'x' }, client: ok })))?.message).toContain('GITHUB_TOKEN')
    writeFileSync(path.join(d, 'agent.json'), JSON.stringify({ ...cfg, grant_id: CID }))
    expect((await thrownAsync(runAgent({ dir: d, env: {}, client: ok })))?.message).toBe('the grant file and agent.json name different grants')
    chmodSync(d, 0o755)
    expect((await thrownAsync(runAgent({ dir: d, env: {}, client: ok })))?.message).toBe('the channel dir mode must be exactly 0700')
    chmodSync(d, 0o700)
    const link = `${d}-link`
    symlinkSync(d, link)
    try {
      expect((await thrownAsync(runAgent({ dir: `${link}/`, env: {}, client: ok })))?.message).toBe('the channel dir is a symlink')
    } finally { unlinkSync(link) }
  })

  it('reads a well-formed agent.json and names malformed fields without echoing them', () => {
    setup()
    expect(readAgentConfig(d)).toEqual(cfg)
    writeFileSync(path.join(d, 'agent.json'), JSON.stringify({ ...cfg, publishable_key: 'eyJsecret', contract_id: 'nope' }))
    expect(thrown(() => readAgentConfig(d)).message).toBe('agent.json is malformed in: contract_id, publishable_key')
  })

  it('derives a stable idempotency key per run, and holds no account module', () => {
    expect(assertedKey('bot-1')).toBe('bot-bot-1-performance-asserted')
    for (const f of ['scripts/agents/owner-delegate-agent.mjs', 'scripts/lib/delegatedClient.mjs']) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
      expect(imports.filter(i => /liveEnv|tfClient|ownerKey|earnerSession|delegatedTrial/.test(i)), f).toEqual([])
    }
  })
})
