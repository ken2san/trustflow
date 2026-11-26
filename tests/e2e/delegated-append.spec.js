// tests/e2e/delegated-append.spec.js
//
// Row 4 step 5 live trial (docs/plans/row4-owner-append.md §4b, §4c step 5):
// an owner_account grant appends through `log-event`, the stored row is v5
// with the grant's authority, and all four row 3 readers recompute it as
// `match`. Items 1-4 of "What counts as done", against hosted E2E only.
//
// THIS SPEC WRITES A PERMANENT ROW. `events` is append-only (DO INSTEAD
// NOTHING rules), so in `open` mode the one delegated row it writes can never
// be removed. That is why it is opt-in, why it runs only as a recorded step
// with its own approval, and why every guard below runs before any request
// that could write.
//
// RUNNING IT (an operator step, never part of a routine suite run):
//
//   TF_DELEGATED_TRIAL=closed|open \
//   TF_DELEGATED_GRANT_FILE=<file holding "<grant-uuid>.<secret>", mode 0600> \
//   npx playwright test tests/e2e/delegated-append.spec.js --project=chromium
//
//   closed  the v5 gate is still closed: the valid call must be 503
//           delegated_append_unavailable and nothing may be stored (0 rows).
//           The dry run on the hosted target, before the gate opens.
//   open    the gate is open: exactly one delegated v5 row is written.
//
// The operator turns ENTRY_DELEGATED_APPEND on before the run (the spec only
// checks it). The spec never turns any flag on; afterAll always revokes the
// grant and unsets ENTRY_DELEGATED_APPEND, then confirms the 503. The gate row
// is never touched here.
//
// Out of this spec, covered by tests/sql/delegated_append*.sh: revoke racing an
// admitted append, an expired grant, an issuer who is no longer the owner, a
// second grant's or a guest's colliding key, and the role/state matrix.
//
// NEVER PRINT the grant secret, the publishable key or any token: assertion
// messages carry status codes and error words only.

import { test, expect } from '@playwright/test'
import { readFileSync, statSync, mkdtempSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SUPABASE_URL } from './liveEnv.js'
import { readPublishableKey } from './publishableKey.js'
import { assertE2EProject, E2E_PROJECT_REF } from '../../scripts/lib/e2eGuard.mjs'
import { readerVerdicts, verifyReceipt, runNode, ROW_MATCH } from './delegatedReaders.js'

const MODE = process.env.TF_DELEGATED_TRIAL
// The approved bot fixture (T261, T267, T269): TERMS_ACCEPTED, performed_by
// creator, owned by the E2E test earner.
const DEAL = '0853c261-035a-4703-b78a-52180e1765e3'
const TYPE = 'performance.asserted'
const OUT_OF_SCOPE_TYPE = 'payment.acknowledged'
const ORIGIN = 'https://project-trustflow.vercel.app'
const GRANT_TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/
// The write budget for the whole run: the one delegated row, and only in open mode.
const BUDGET = MODE === 'open' ? 1 : 0
const COLUMNS = ['id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at', 'event_hash',
  'prev_event_hash', 'hash_version', 'payload_hash', 'agreement_hash', 'idempotency_key', 'tsa_token',
  'credential_id', 'issuer_kind'].join(',')

test.describe.configure({ mode: 'serial' })

test.describe('delegated append, live trial (row 4 step 5)', () => {
  test.skip(MODE === undefined, 'Opt-in trial: it writes a permanent row. Set TF_DELEGATED_TRIAL=closed|open to run it.')

  // Filled in beforeAll, only after every guard passed.
  let tf, pub, grant, grantId, owner, contract, baseline
  const key = `t272-${randomUUID()}`
  let written = null
  let revoked = false
  // Set once the target guard has passed. Cleanup acts on E2E only after that,
  // so a run refused for its target makes no call to any project at all.
  let armed = false

  const fakeGrant = () => `${randomUUID()}.${randomBytes(32).toString('hex')}`
  async function post({ grantHeader = grant, body, extra = [] }) {
    const headers = new Headers([['Content-Type', 'application/json'], ['apikey', pub], ['Origin', ORIGIN]])
    if (grantHeader !== null) headers.append('x-trustflow-grant', grantHeader)
    for (const [k, v] of extra) headers.append(k, v)
    const r = await fetch(`${SUPABASE_URL}/functions/v1/log-event`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON: compared by status only */ }
    return { status: r.status, error: json?.error ?? null, json }
  }
  const op = (over = {}) => ({ type: TYPE, contract_id: DEAL, payload: { note: 'row 4 delegated trial' }, idempotency_key: key, ...over })
  async function readDeal() {
    const { rows, read } = await tf.fetchAllEvents(q => tf.rest(owner.token, q), DEAL, COLUMNS)
    return { rows, read }
  }
  /** The run's writes so far, against the budget; fails the moment it is exceeded. */
  async function assertBudget(label, expected) {
    const { rows } = await readDeal()
    const delta = rows.length - baseline.rows.length
    expect(delta, `${label}: rows written so far`).toBe(expected)
    expect(delta, `${label}: write budget`).toBeLessThanOrEqual(BUDGET)
    return rows
  }

  test.beforeAll(async () => {
    // 1. Mode, then target, before anything else is read or sent.
    if (MODE !== 'closed' && MODE !== 'open') throw new Error('TF_DELEGATED_TRIAL must be exactly "closed" or "open"')
    if (assertE2EProject(SUPABASE_URL) !== E2E_PROJECT_REF) throw new Error('not the E2E project')
    armed = true
    // tfClient pins E2E again at import (scripts/lib/tfClient.mjs).
    tf = { ...(await import('../../scripts/lib/tfClient.mjs')), ...(await import('../../scripts/lib/pagedEvents.mjs')) }

    // 2. The grant: from a file only the owner can read, in the header's exact grammar.
    const file = process.env.TF_DELEGATED_GRANT_FILE
    if (!file) throw new Error('TF_DELEGATED_GRANT_FILE is not set')
    if ((statSync(file).mode & 0o077) !== 0) throw new Error('the grant file is readable beyond its owner; chmod 600 it')
    grant = readFileSync(file, 'utf8').trim()
    const m = GRANT_TOKEN.exec(grant)
    if (!m) throw new Error('the grant file does not hold "<uuid>.<64 hex>"')
    grantId = m[1]

    // 3. The owner, the deal and the grant, read back before any write-capable call.
    owner = await tf.ownerSession()
    const c = await tf.rest(owner.token, `contracts?id=eq.${DEAL}&select=*`)
    contract = c.body?.[0]
    if (!contract) throw new Error('the fixture deal is not readable as the test earner')
    if (contract.earner_user_id !== owner.userId) throw new Error('the test earner does not own the fixture deal')
    if (contract.performed_by !== 'creator') throw new Error('the fixture deal is not owner-performed')
    const list = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token, body: { action: 'list', contract_id: DEAL } })
    const g = (list.data?.grants ?? []).find(x => x.id === grantId)
    if (!g) throw new Error(`the grant is not listed for the fixture deal (${list.status} ${list.reason ?? ''})`)
    if (g.issuer_kind !== 'owner_account' || g.revoked_at !== null) throw new Error('the grant is not a live owner_account grant')
    if (!(Date.parse(g.expires_at) > Date.now() + 15 * 60_000)) throw new Error('the grant expires within 15 minutes')
    if (!g.scopes.includes(TYPE) || g.scopes.includes(OUT_OF_SCOPE_TYPE)) {
      throw new Error(`the grant must include ${TYPE} and exclude ${OUT_OF_SCOPE_TYPE}`)
    }

    // 4. Transport key, then the flag: a fake grant must be refused 403 (flag
    //    on). A 503 here means the flag is off; nothing has been sent that could write.
    pub = readPublishableKey(SUPABASE_URL)
    const probe = await post({ grantHeader: fakeGrant(), body: op({ idempotency_key: null }) })
    if (probe.status !== 403) throw new Error(`flag check: a fake grant got ${probe.status} ${probe.error}, not 403 (is ENTRY_DELEGATED_APPEND on?)`)

    // 5. Baseline: the deal's rows and every reader's overall verdict before the trial.
    baseline = await readDeal()
    if (baseline.rows.some(r => r.idempotency_key === key)) throw new Error('the trial key already exists')
    const before = await readerVerdicts({ contract, ...baseline, eventId: null })
    baseline.overall = { slice: before.slice.overall, guest: before.guest.overall, audit: before.audit.overall,
      receipt: verifyReceipt(before.receipt.document).status }
  })

  test.afterAll(async () => {
    // Always, whatever failed, each step independent of the others: revoke the
    // grant, unset the flag, confirm the 503, check the write budget.
    if (!armed) return
    const problems = []
    if (owner && grantId && !revoked) {
      try {
        const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token,
          body: { action: 'revoke', contract_id: DEAL, id: grantId } })
        if (r.status !== 200) problems.push(`revoke answered ${r.status} ${r.reason ?? ''}; revoke the grant by hand`)
      } catch { problems.push('revoke failed to complete; revoke the grant by hand') }
    }
    try {
      execFileSync('supabase', ['secrets', 'unset', 'ENTRY_DELEGATED_APPEND', '--project-ref', E2E_PROJECT_REF],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120_000 })
    } catch { problems.push('supabase secrets unset ENTRY_DELEGATED_APPEND failed; unset it by hand') }
    if (pub) {
      // A secret change reaches new isolates within seconds; allow a short settle.
      let last = null
      for (let i = 0; i < 10; i++) {
        last = await post({ grantHeader: fakeGrant(), body: op({ idempotency_key: null }) }).catch(() => null)
        if (last?.status === 503) break
        await new Promise(res => setTimeout(res, 3000))
      }
      if (last?.status !== 503 || last?.error !== 'delegated_append_unavailable') {
        problems.push(`after unset the route answered ${last?.status} ${last?.error}, not 503`)
      }
    }
    if (baseline) {
      try {
        const { rows } = await readDeal()
        const delta = rows.length - baseline.rows.length
        if (delta > BUDGET) problems.push(`the run wrote ${delta} rows, over its budget of ${BUDGET}`)
      } catch { problems.push('the final row count could not be read') }
    }
    expect(problems, 'afterAll cleanup').toEqual([])
  })

  test('refusals: every bad grant, deal, type or credential mix is refused and writes nothing (item 2)', async () => {
    const otherDeal = randomUUID()
    const cases = [
      ['wrong secret', { grantHeader: `${grantId}.${randomBytes(32).toString('hex')}` }, 403],
      ['unknown grant', { grantHeader: fakeGrant() }, 403],
      ['malformed grant', { grantHeader: `${grantId}.not-hex` }, 403],
      ['blank grant', { grantHeader: '' }, 403],
      ['a deal that does not exist', { body: op({ contract_id: otherDeal }) }, 403],
      ['a type outside the grant', { body: op({ type: OUT_OF_SCOPE_TYPE }) }, 403],
      ['a type outside the allowlist', { body: op({ type: 'dod.consent_recorded' }) }, 400],
      ['grant with a user JWT', { extra: [['Authorization', `Bearer ${owner.token}`]] }, 403],
      ['two grants in one header', { grantHeader: `${grant}, ${fakeGrant()}` }, 403],
      ['authority in the body', { body: op({ credential_id: grantId }) }, 400],
    ]
    for (const [label, over, status] of cases) {
      const r = await post({ body: op({ idempotency_key: `${key}-refusal` }), ...over })
      expect(r.status, label).toBe(status)
      if (status === 403) expect(r.error, label).toBe('delegation_refused')
    }
    await assertBudget('after refusals', 0)
  })

  test('a valid grant appends one v5 row carrying its authority (item 1); closed gate: 503 and nothing stored', async () => {
    const r = await post({ body: op() })
    if (MODE === 'closed') {
      expect(r.status, 'closed gate').toBe(503)
      expect(r.error).toBe('delegated_append_unavailable')
      await assertBudget('closed gate', 0)
      return
    }
    expect(r.status, `open gate answered ${r.error}`).toBe(201)
    expect(r.json.deduplicated).toBe(false)
    written = r.json.event
    expect(written).toMatchObject({ type: TYPE, contract_id: DEAL, hash_version: 5, credential_id: grantId,
      issuer_kind: 'owner_account', actor_id: owner.userId, idempotency_key: key })
    const rows = await assertBudget('after the append', 1)
    const stored = rows.find(x => x.id === written.id)
    expect(stored, 'the returned event is stored').toBeTruthy()
    for (const f of ['event_hash', 'prev_event_hash', 'payload_hash', 'agreement_hash', 'dod_hash', 'hash_version',
      'credential_id', 'issuer_kind', 'actor_id', 'type']) expect(stored[f], f).toEqual(written[f])
    expect(rows.at(-1).id, 'the delegated row is the tip').toBe(written.id)
  })

  test('replay: the same key and grant return the original event, nothing new (item 4)', async () => {
    const r = await post({ body: op() })
    if (MODE === 'closed') {
      expect(r.status).toBe(503)
      await assertBudget('closed replay', 0)
      return
    }
    expect(r.status).toBe(200)
    expect(r.json.deduplicated).toBe(true)
    expect(r.json.event.id).toBe(written.id)
    await assertBudget('after the replay', 1)
  })

  test('the owner session reusing the grant\'s key is a 409 with no row returned (item 4)', async () => {
    test.skip(MODE !== 'open', 'needs the delegated row the open gate writes')
    const r = await tf.invoke('log-event', { ownerToken: owner.token, body: op() })
    expect(r.status).toBe(409)
    expect(r.reason).toBe('idempotency_key_in_use')
    expect(r.data).toBeNull()
    await assertBudget('after the owner collision', 1)
  })

  test('the live row is match in all four readers, and no reader\'s overall verdict changed (item 1)', async () => {
    test.skip(MODE !== 'open', 'needs the delegated row the open gate writes')
    const live = await readDeal()
    const v = await readerVerdicts({ contract, ...live, eventId: written.id })
    expect(v.index, 'row found').toBeGreaterThanOrEqual(0)
    expect(v.slice.row, 'strict slice').toEqual(ROW_MATCH)
    expect(v.guest.row, 'guest response v2').toEqual(ROW_MATCH)
    expect(v.guest.credential, 'guest sees the grant id').toBe(grantId)
    expect(v.guest.label, 'guest credential label').toBe('entry_agent_grant')
    expect(v.audit.row, 'owner export').toEqual(ROW_MATCH)
    expect(v.receipt.act, 'receipt act').toEqual({ credential_id: grantId, issuer_kind: 'owner_account' })
    const offline = verifyReceipt(v.receipt.document)
    expect({ slice: v.slice.overall, guest: v.guest.overall, audit: v.audit.overall, receipt: offline.status },
      'overall verdicts, before vs after the append').toEqual(baseline.overall)

    // The receipt CLI end to end: make-receipt reads the deal itself, verify-receipt checks the file offline.
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'tf-delegated-cli-')), 'receipt.json')
    const made = runNode(['scripts/make-receipt.mjs', DEAL, '--out', out])
    expect(made.status, 'make-receipt exit (0 = issuer recomputation intact)').toBe(baseline.overall.slice === 'verified' ? 0 : 1)
    const checked = runNode(['scripts/verify-receipt.mjs', out])
    expect(checked.status, 'verify-receipt exit, same as the pre-append receipt').toBe(baseline.overall.receipt)
    const file = JSON.parse(readFileSync(out, 'utf8'))
    const act = file.acts.find(a => a.canonical?.id === written.id)
    expect(act?.canonical, 'the CLI receipt carries the row').toMatchObject({ credential_id: grantId, issuer_kind: 'owner_account' })
  })

  test('revoke: afterwards a fresh write and a replay of the same key are both refused (item 3)', async () => {
    const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token,
      body: { action: 'revoke', contract_id: DEAL, id: grantId } })
    expect(r.status).toBe(200)
    revoked = true
    for (const [label, body] of [['fresh write', op({ idempotency_key: `${key}-after-revoke` })], ['replay', op()]]) {
      const after = await post({ body })
      expect(after.status, label).toBe(403)
      expect(after.error, label).toBe('delegation_refused')
    }
    await assertBudget('after revoke', BUDGET)
  })
})
