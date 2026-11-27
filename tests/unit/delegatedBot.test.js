import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installPinnedFetch } from '../../scripts/lib/pinnedFetch.mjs'
import { ClientError, delegatedAppend, delegatedRead, delegatedRequest, readGrantFile } from '../../scripts/lib/delegatedClient.mjs'
import {
  DEFAULT_SCOPES, DEFAULT_TTL_MS, assertChannelDir, issueBody, parseArgs, phase, validateIssue, writeExclusive,
} from '../../scripts/agents/bootstrap.mjs'
import { FORBIDDEN_ENV, assertGrantOnly, assertedKey, readAgentConfig } from '../../scripts/agents/owner-delegate-agent.mjs'

// Row 7 bot pieces, offline: the delegated client, the bootstrap's pure parts,
// and the delegate bot's guards. No network: fetch is a stub behind the pin.

const E2E = 'https://yqjtawffpesplqyurlpj.supabase.co'
const CID = '11111111-1111-4111-8111-111111111111'
const GID = '22222222-2222-4222-8222-222222222222'
const SECRET = 'ab'.repeat(32)
const PUB = 'sb_publishable_test_key_1'
const thrown = f => { try { f() } catch (e) { return e } return null }

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
    expect(init.method).toBe('POST')
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
})

describe('grant file', () => {
  it('reads a 0600 grant and refuses a loose one', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'tf-bot-'))
    try {
      const f = path.join(d, 'grant')
      writeFileSync(f, `${GID}.${SECRET}\n`, { mode: 0o600 })
      expect(readGrantFile(f)).toEqual({ grant: `${GID}.${SECRET}`, grantId: GID })
      chmodSync(f, 0o644)
      expect(thrown(() => readGrantFile(f))?.message).toBe('the grant file mode must be exactly 0600')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('bootstrap (pure parts)', () => {
  it('parses exactly one mode, a run id and a dir', () => {
    expect(parseArgs(['--run', 'bot-1', '--dir', '/tmp/x'])).toEqual({ mode: 'bootstrap', run: 'bot-1', dir: '/tmp/x' })
    expect(parseArgs(['--revoke', 'bot-1', '--dir', '/tmp/x']).mode).toBe('revoke')
    for (const bad of [[], ['--run', 'bot-1'], ['--run', 'a', '--revoke', 'b', '--dir', '/x'], ['--run', 'Bad!', '--dir', '/x'], ['--run', 'bot-1', '--dir', '/x', '--sql', 'y']]) {
      expect(thrown(() => parseArgs(bad)), JSON.stringify(bad)).toBeInstanceOf(ClientError)
    }
  })

  it('refuses a channel dir inside the repo unless git ignores it', () => {
    const repoRoot = '/repo'
    expect(assertChannelDir('/tmp/chan', { repoRoot, isIgnored: () => false })).toBe('/tmp/chan')
    expect(thrown(() => assertChannelDir('/repo/scripts/chan', { repoRoot, isIgnored: () => false }))?.message)
      .toBe('the channel dir is inside the repository and not git-ignored')
    expect(assertChannelDir('/repo/test-results/chan', { repoRoot, isIgnored: () => true })).toBe('/repo/test-results/chan')
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
    expect(thrown(() => validateIssue({ status: 503, reason: 'issuance_disabled' }, { contractId: CID }))?.message)
      .toBe('issue answered 503 issuance_disabled')
  })

  it('writes channel files exclusively and 0600, and records phases without losing earlier ones', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'tf-boot-'))
    try {
      writeExclusive(d, 'manifest.json', JSON.stringify({ run: 'bot-1', phases: {} }))
      expect(statSync(path.join(d, 'manifest.json')).mode & 0o777).toBe(0o600)
      expect(thrown(() => writeExclusive(d, 'manifest.json', '{}'))?.message).toBe('manifest.json already exists in the channel dir')
      phase(d, 'created', { contract_id: CID })
      phase(d, 'issued', { grant_id: GID })
      const m = JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'))
      expect(Object.keys(m.phases)).toEqual(['created', 'issued'])
      expect(statSync(path.join(d, 'manifest.json')).mode & 0o777).toBe(0o600)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('delegate bot guards', () => {
  it('refuses to start holding anything but the grant', () => {
    expect(assertGrantOnly({})).toBeUndefined()
    for (const k of FORBIDDEN_ENV) expect(thrown(() => assertGrantOnly({ [k]: 'x' }))?.message, k).toContain(k)
  })

  it('reads a well-formed agent.json and names malformed fields without echoing them', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'tf-agent-'))
    try {
      const cfg = { run: 'bot-1', contract_id: CID, grant_id: GID, scopes: ['read'], expires_at: 'x', publishable_key: PUB }
      writeFileSync(path.join(d, 'agent.json'), JSON.stringify(cfg))
      expect(readAgentConfig(d)).toEqual(cfg)
      writeFileSync(path.join(d, 'agent.json'), JSON.stringify({ ...cfg, publishable_key: 'eyJsecret', contract_id: 'nope' }))
      const e = thrown(() => readAgentConfig(d))
      expect(e.message).toBe('agent.json is malformed in: contract_id, publishable_key')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('derives a stable idempotency key per run, so a rerun is a replay', () => {
    expect(assertedKey('bot-1')).toBe('bot-bot-1-performance-asserted')
    expect(assertedKey('bot-1')).toBe(assertedKey('bot-1'))
  })

  it('holds no account module: neither the bot nor the client imports liveEnv, tfClient or ownerKey', () => {
    for (const f of ['scripts/agents/owner-delegate-agent.mjs', 'scripts/lib/delegatedClient.mjs']) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
      expect(imports.filter(i => /liveEnv|tfClient|ownerKey|earnerSession/.test(i)), f).toEqual([])
    }
  })
})
