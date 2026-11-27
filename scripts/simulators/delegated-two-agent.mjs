// Row 7 step 3. The two subprocesses act with different request credentials.
// They share an OS user, so this is not a filesystem security boundary.
import { spawn } from 'node:child_process'
import { constants, openSync, fstatSync, readFileSync, closeSync, mkdirSync, lstatSync, existsSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { E2E_ORIGIN, installPinnedFetch } from '../lib/pinnedFetch.mjs'
import { fn } from '../agents/lib.mjs'
import { digestV2 } from '../agents/published-digest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUN = /^[a-z0-9][a-z0-9-]{2,39}$/
const CHILD_TIMEOUT_MS = 150_000
const GUEST_EMAIL = 'agent-guest@example.invalid'

export function parseRun(args, origin) {
  if (origin !== E2E_ORIGIN) throw new Error('delegated simulator requires the exact E2E origin')
  if (args.length !== 4 || args[0] !== '--run' || !RUN.test(args[1] ?? '')
      || args[2] !== '--approve-budget=1/1/2' || args[3] !== '--gate-open-confirmed') {
    throw new Error('use --run <fresh-id> --approve-budget=1/1/2 --gate-open-confirmed (deal/grant/events budget)')
  }
  return args[1]
}

// Stop the guest before using the operator credential for revocation, even when
// the guest or owner lost a write response. Never rerun a write in this layer.
export async function runFixture({ bootstrap, accept, owner, read, stopGuest, revoke }) {
  let step = 'bootstrap'
  let failure = null
  try {
    await bootstrap()
    step = 'accept'
    await accept()
    step = 'owner'
    await owner()
    step = 'read'
    await read()
  } catch {
    failure = `${step} failed`
  } finally {
    try { await stopGuest() } catch { failure ??= 'guest shutdown failed' }
    try { await revoke() } catch { failure = [failure, 'revocation unverified'].filter(Boolean).join('; ') }
  }
  if (failure) throw new Error(failure)
}

function guestEvents(trail, contractId, count) {
  const boundary = trail?.strict_verification?.server?.read_boundary
  if (trail?.response_version !== 2 || trail?.contract?.id !== contractId || boundary?.start !== 'first_event'
      || boundary.tail !== 'complete' || boundary.recorded_count !== count || trail.events?.length !== count) {
    throw new Error('guest trail identity, completeness or write budget failed')
  }
  return trail.events
}

function checkAcceptance(row, acceptanceId) {
  if (row.id !== acceptanceId || row.type !== 'dod.consent_recorded' || row.canonical?.hash_version !== 4) {
    throw new Error('guest acceptance evidence did not match')
  }
}

export function verifyGuestTrail(trail, { contractId, acceptanceId, grantId }) {
  const [acceptance, row] = guestEvents(trail, contractId, 2)
  checkAcceptance(acceptance, acceptanceId)
  if (!UUID.test(row.id ?? '') || row.type !== 'performance.asserted' || row.recorded_credential !== 'entry_agent_grant'
      || row.canonical?.hash_version !== 5 || row.canonical.credential_id !== grantId
      || row.canonical.issuer_kind !== 'owner_account') throw new Error('delegated event authority did not match')
  const strict = row.integrity?.strict
  if (trail.contract.state !== 'AWAITING_CONFIRMATION' || trail.strict_verification.server.overall !== 'verified'
      || strict?.hash !== 'match' || strict.link !== 'linked' || strict.payload !== 'match' || strict.agreement !== 'match') {
    throw new Error('delegated event did not verify')
  }
  return row.id
}

function privateJson(dir, name) {
  const fd = openSync(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 65_536) {
      throw new Error('invalid channel file')
    }
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

export async function guestFixture({ run, expectedDeal, inviteToken, call, accepted }) {
  const preview = await call('validate-invite-token', { body: { invite_token: inviteToken } })
  const terms = preview.data
  if (preview.status !== 200 || terms?.contract_id !== expectedDeal || terms.project_name !== `agent bootstrap ${run}`
      || terms.currency !== 'CAD' || terms.performed_by !== 'creator' || terms.invited_hirer_email !== GUEST_EMAIL) {
    throw new Error('invitation is not for this fresh fixture')
  }
  const invite = await call('validate-invite-token', { body: {
    invite_token: inviteToken, accept: true, hirer_email: GUEST_EMAIL, counterparty_name: 'Counterparty Agent',
    shown_terms_version: 2, shown_terms_digest: digestV2(terms),
  } })
  const { contract_id: contractId, acceptance_event_id: acceptanceId, guest_access_token: guestToken } = invite.data ?? {}
  if (invite.status !== 200 || contractId !== terms.contract_id || !UUID.test(acceptanceId ?? '') || !UUID.test(guestToken ?? '')) {
    throw new Error('invitation acceptance unconfirmed')
  }
  const read = async () => {
    const res = await call('guest-contract-events?response_version=2', { guestToken })
    if (res.status !== 200) throw new Error('guest evidence unavailable')
    return res.data
  }
  const baseline = await read()
  checkAcceptance(guestEvents(baseline, contractId, 1)[0], acceptanceId)
  if (baseline.contract.state !== 'TERMS_ACCEPTED') throw new Error('fixture is not newly accepted')
  const grantId = await accepted({ contractId })
  return verifyGuestTrail(await read(), { contractId, acceptanceId, grantId })
}

async function guestMain() {
  const { TF_CHANNEL_DIR: dir, TF_SIM_RUN: run, TF_SIM_DEAL: expectedDeal, TF_SUPABASE_ANON_KEY: key } = process.env
  if (process.argv[2] !== '--guest' || !process.send || !RUN.test(run ?? '') || !UUID.test(expectedDeal ?? '') || !dir || !key) {
    throw new Error('missing guest setup')
  }
  installPinnedFetch()
  const handed = privateJson(dir, 'invite.json')
  if (handed.run !== run || !UUID.test(handed.invite_token ?? '')) throw new Error('invalid invite handover')
  const id = await guestFixture({ run, expectedDeal, inviteToken: handed.invite_token,
    call: (name, options) => fn(E2E_ORIGIN, key, name, options),
    accepted: ({ contractId }) => new Promise((resolve, reject) => {
      process.once('message', msg => UUID.test(msg?.grantId ?? '') ? resolve(msg.grantId) : reject(new Error('invalid read signal')))
      process.send({ accepted: contractId })
    }),
  })
  process.send({ verified: id }, err => { process.exitCode = err ? 1 : 0; process.disconnect() })
}

export function budgetedOwner(client, contractId, key) {
  let phase = 'initial', sent, eventId
  return {
    async read(input) {
      if (phase !== 'initial' || input.contractId !== contractId) throw new Error('owner read outside the fixture')
      phase = 'pending'
      const result = await client.read(input)
      if (result.status !== 200) throw new Error('delegated owner read failed')
      phase = 'append'
      return result
    },
    async append(input) {
      if (input.contractId !== contractId || input.type !== 'performance.asserted' || input.idempotencyKey !== key
          || (phase !== 'append' && phase !== 'replay')) throw new Error('owner write budget exceeded')
      const replay = phase === 'replay'
      const signature = JSON.stringify([input.grant, input.pub, input.payload])
      if (replay && signature !== sent) throw new Error('the replay does not match the original request')
      phase = 'pending' // A thrown request has an unknown outcome. No retry.
      const result = await client.append(input)
      const id = result.json?.event?.id
      if (result.status !== (replay ? 200 : 201) || result.json?.deduplicated !== replay
          || !UUID.test(id ?? '') || (replay && id !== eventId)) throw new Error('delegated append or replay unconfirmed')
      sent = signature
      eventId = id
      phase = replay ? 'verified' : 'replay'
      return result
    },
    verifiedEvent: () => phase === 'verified' ? eventId : null,
  }
}

async function ownerMain() {
  const { TF_CHANNEL_DIR: dir, TF_SIM_RUN: run, TF_SIM_DEAL: contractId } = process.env
  if (!process.send || !dir || !RUN.test(run ?? '') || !UUID.test(contractId ?? '')) throw new Error('missing owner setup')
  installPinnedFetch()
  const { runAgent, assertedKey } = await import('../agents/owner-delegate-agent.mjs')
  const { delegatedRead, delegatedAppend } = await import('../lib/delegatedClient.mjs')
  const guard = budgetedOwner({ read: delegatedRead, append: delegatedAppend }, contractId, assertedKey(run))
  const failures = await runAgent({ dir, client: guard })
  const eventId = guard.verifiedEvent()
  if (failures.length || !eventId) throw new Error('owner budgeted operation was not verified')
  process.send({ eventId }, err => { process.exitCode = err ? 1 : 0; process.disconnect() })
}

function child(file, args, env, onMessage) {
  const p = spawn(process.execPath, [file, ...args], {
    env, stdio: onMessage ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
  })
  if (onMessage) p.on('message', onMessage)
  const done = new Promise(resolve => {
    const timer = setTimeout(() => p.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    p.on('error', () => {}) // close also fires after a spawn failure
    p.once('close', code => { clearTimeout(timer); resolve(code === 0) })
  })
  return { p, done }
}

function launchGuest(dir, run, contractId, anon) {
  let accept, verified = null
  const ready = new Promise(resolve => { accept = resolve })
  const { p, done } = child(fileURLToPath(import.meta.url), ['--guest'], {
    TF_CHANNEL_DIR: dir, TF_SIM_RUN: run, TF_SIM_DEAL: contractId, TF_SUPABASE_ANON_KEY: anon,
  }, msg => {
    if (UUID.test(msg?.accepted ?? '')) accept(msg.accepted)
    if (UUID.test(msg?.verified ?? '')) verified = msg.verified
  })
  return {
    ready: Promise.race([ready, done.then(() => null)]),
    async read(grantId) {
      if (!p.connected) throw new Error('guest disconnected')
      await new Promise((resolve, reject) => p.send({ grantId }, err => err ? reject(err) : resolve()))
      if (!await done || !verified) throw new Error('guest verification failed')
      return verified
    },
    async stop() { p.kill('SIGKILL'); await done },
  }
}

export function privateAttempt(run, root = path.join(userInfo().homedir, '.trustflow-delegated-sim')) {
  if (!RUN.test(run)) throw new Error('invalid run id')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const st = lstatSync(root)
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700) throw new Error('invalid simulator state directory')
  const dir = path.join(root, run)
  try { mkdirSync(dir, { mode: 0o700 }) } catch { throw new Error('cannot claim a fresh simulator run directory') }
  return dir
}

export async function main(args, env = process.env) {
  const run = parseRun(args, env.VITE_SUPABASE_URL)
  const anon = env.VITE_SUPABASE_ANON_KEY
  if (!anon || !env.TF_TEST_EARNER_EMAIL || !env.TF_TEST_EARNER_PASSWORD) throw new Error('explicit E2E fixture environment required')
  const dir = privateAttempt(run)
  const bootstrapPath = path.join(HERE, '../agents/bootstrap.mjs')
  const simulatorPath = fileURLToPath(import.meta.url)
  const operatorEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
    'TF_TEST_EARNER_EMAIL', 'TF_TEST_EARNER_PASSWORD', 'TF_TEST_EARNER_SESSION', 'SUPABASE_ACCESS_TOKEN']
    .filter(name => env[name] !== undefined).map(name => [name, env[name]]))
  operatorEnv.TF_E2E_ENV_FILE = '/dev/null'
  async function operator(action) {
    if (!await child(bootstrapPath, [action, run, '--dir', dir], operatorEnv).done) throw new Error('operator step failed')
  }
  let guest, config, ownerEvent, eventId
  console.log(`E2E fixture ${run}: 1 deal, 1 grant, 1 acceptance and 1 v5 append (same-key replay only).`)
  try {
    await runFixture({
      bootstrap: () => operator('--run'),
      async accept() {
        config = privateJson(dir, 'agent.json')
        if (config.run !== run || !UUID.test(config.contract_id ?? '') || !UUID.test(config.grant_id ?? '')
            || !Array.isArray(config.scopes) || config.scopes.length !== 2
            || !config.scopes.includes('read') || !config.scopes.includes('performance.asserted')) throw new Error('invalid bot handover')
        guest = launchGuest(dir, run, config.contract_id, anon)
        if (await guest.ready !== config.contract_id) throw new Error('guest acceptance not confirmed')
        unlinkSync(path.join(dir, 'invite.json'))
      },
      async owner() {
        const ownerEnv = { TF_CHANNEL_DIR: dir, TF_SIM_RUN: run, TF_SIM_DEAL: config.contract_id }
        const { done } = child(simulatorPath, ['--owner'], ownerEnv, msg => { ownerEvent = msg?.eventId })
        if (!await done || !UUID.test(ownerEvent ?? '')) throw new Error('grant-only owner failed')
      },
      async read() {
        eventId = await guest.read(config.grant_id)
        if (eventId !== ownerEvent) throw new Error('guest saw a different event')
      },
      stopGuest: () => guest?.stop(),
      async revoke() {
        if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error('no bootstrap manifest')
        await operator('--revoke')
      },
    })
  } catch (err) {
    throw new Error(`${err.message}. Inspect the run record and reconcile any unacknowledged writes before recovery. Do not rerun.`)
  } finally {
    console.log(`Recovery record: ${dir}. Operator cleanup: bootstrap.mjs --revoke ${run} --dir <record directory>.`)
  }
  console.log(`Guest verified v5 event ${eventId}. Grant revocation completed.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const start = process.argv[2] === '--owner' ? ownerMain : guestMain
  start().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect() })
}
