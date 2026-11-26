// tests/e2e/delegated-append.spec.js
//
// Row 4 step 5 live trial (docs/plans/row4-owner-append.md §4b, §4c step 5):
// an owner_account grant appends through `log-event`, the stored row is v5
// with the grant's authority, and all four row 3 readers recompute it as
// `match`. Items 1-4 of "What counts as done", against hosted E2E only.
//
// THIS SPEC CAN WRITE A PERMANENT ROW. `events` is append-only, so in `open`
// mode the one delegated row it writes can never be removed. Hence (Codex T213):
//
//   * one approved attempt per run. TF_DELEGATED_ATTEMPT names it; its record
//     tests/e2e/.delegated-trial/<attempt>.json is created exclusively, so a
//     retry or an overlapping run of the same attempt is refused, and its
//     idempotency key trial-<attempt> makes a resent append the same event.
//     Playwright retries, repeat-each and more than one worker are refused;
//   * the gate is read back from the E2E database (read-only) before the
//     first write-capable request and again just before the append, and must
//     equal the mode;
//   * the baseline (row count, tip, every reader's verdict, all verified) is
//     taken and recorded before any write-capable request;
//   * every case that would store a row if the check under test were broken
//     runs only in `closed` mode, where the confirmed closed gate stops any
//     v5 row (the resolver decides authorization before the gate, so each
//     refusal is still a 403). `open` sends only the one append and two
//     same-key replays, which the unique (contract_id, idempotency_key) index
//     keeps from adding a row even if dedupe were broken.
//
// Every request goes through scripts/lib/pinnedFetch.mjs: E2E origin only,
// redirects refused, time-bounded. The receipt CLI child runs with the same
// guard preloaded. Cleanup (scripts/lib/delegatedTrial.mjs cleanupTrial) acts
// only on what the attempt record says it owns, verifies each step, and is
// also runnable by hand: node scripts/delegated-trial-cleanup.mjs <attempt>.
//
// RUNNING IT (an operator step with its own approval, never a routine run):
//
//   TF_DELEGATED_TRIAL=closed|open TF_DELEGATED_ATTEMPT=<id> \
//   TF_DELEGATED_GRANT_FILE=<regular file you own, mode 0600, "<uuid>.<secret>"> \
//   TF_DELEGATED_OTHER_DEAL=<approved comparison deal; closed mode only> \
//   npx playwright test tests/e2e/delegated-append.spec.js --project=chromium --workers=1
//
//   closed  gate closed: every refusal is 403/400 with no row for its key; the
//           valid call is 503 and stores nothing; revoke, then a fresh write
//           is refused. The dry run, and where the refusal coverage lives.
//   open    gate open: exactly one delegated v5 row, its replay, all four
//           readers verified, revoke, then its replay is refused.
//
// The operator turns ENTRY_DELEGATED_APPEND on before each run; the spec only
// observes it, and takes ownership of turning it off once it has seen it on.
// Each run revokes its grant, so each needs a fresh one. The gate row is never
// written here.
//
// Not claimed live, covered by tests/sql/delegated_append*.sh: revoke racing an
// admitted append (delegated_append_races.sh), an expired grant, an issuer who
// is no longer the owner, another grant's or operation's colliding key, the
// role/state matrix. Mixing a grant with a real user JWT or a guest token:
// tests/unit/delegatedAuth.test.js (here the bearer is the publishable key, so
// a broken dispatch could not write as the owner). The owner path reusing a
// delegated key is not exercised live: that attempt could store a v4 row.
//
// OUTPUT: status codes, error words, field names and fixed text only.

import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SUPABASE_URL } from './liveEnv.js'
import { assertE2EProject, E2E_PROJECT_REF } from '../../scripts/lib/e2eGuard.mjs'
import { E2E_ORIGIN, installPinnedFetch } from '../../scripts/lib/pinnedFetch.mjs'
import {
  DEAL, TYPE, OUT_OF_SCOPE_TYPE, UUID, BUDGET, keyFor, word, fakeGrant, readGrantFile, readGate,
  createState, updateState, phase, publishableKey, delegatedPost, rowsWithKey, listedGrant, loadClient, cleanupTrial,
} from '../../scripts/lib/delegatedTrial.mjs'
import { readerVerdicts, verifyReceipt, verifyReceiptFile, runPinnedNode, ROW_MATCH } from './delegatedReaders.js'

const MODE = process.env.TF_DELEGATED_TRIAL
const ATTEMPT_ID = process.env.TF_DELEGATED_ATTEMPT
const OTHER_DEAL = process.env.TF_DELEGATED_OTHER_DEAL
const COLUMNS = ['id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at', 'event_hash',
  'prev_event_hash', 'hash_version', 'payload_hash', 'agreement_hash', 'idempotency_key', 'tsa_token',
  'credential_id', 'issuer_kind'].join(',')
const STORED_FIELDS = ['event_hash', 'prev_event_hash', 'payload_hash', 'agreement_hash', 'dod_hash', 'hash_version',
  'credential_id', 'issuer_kind', 'actor_id', 'type', 'idempotency_key']
// Every reader's whole-trail verdict, lower-cased words, and RECEIPT VERIFIED.
const VERIFIED = { slice: 'verified', guest: 'verified', audit: 'verified', receipt: true }

// Bounded, but above the 30 s default: the gate readback can wait on a vault
// unlock, and cleanup's own calls are each time-limited (scripts/lib/delegatedTrial.mjs).
test.describe.configure({ mode: 'serial', retries: 0, timeout: 300_000 })

test.describe('delegated append, live trial (row 4 step 5)', () => {
  test.skip(MODE === undefined, 'Opt-in trial: it can write a permanent row. Set TF_DELEGATED_TRIAL=closed|open to run it.')

  // Filled in beforeAll, only after every guard passed.
  let tf, pub, grant, grantId, owner, contract, state
  const key = keyFor(ATTEMPT_ID)
  let written = null
  // Set once this attempt's record exists. Cleanup then acts only on what the
  // record says the attempt owns; a run refused earlier owns nothing.
  let armed = false

  const op = (over = {}) => ({ type: TYPE, contract_id: DEAL, payload: { note: 'row 4 delegated trial' }, idempotency_key: key, ...over })
  const readDeal = (deal, columns) => tf.fetchAllEvents(q => tf.rest(owner.token, q), deal, columns)
  const count = async deal => (await readDeal(deal, 'id')).rows.length
  const keyed = async k => (await rowsWithKey(tf, owner.token, k)).length
  async function gateIs(expected, label) {
    const gate = await readGate()
    phase(ATTEMPT_ID, `gate_${label}`, { gate })
    if (gate !== expected) throw new Error(`gate readback (${label}): ${gate}, expected ${expected}; nothing more is sent`)
  }
  /** Rows on the fixture deal since the baseline, against the attempt's budget. */
  async function assertWritten(label, expected) {
    const delta = (await count(DEAL)) - state.baseline.count
    expect(delta, `${label}: rows written so far`).toBe(expected)
    expect(delta, `${label}: write budget`).toBeLessThanOrEqual(BUDGET[MODE])
  }
  /** Every reader over the whole trail; the receipt verdict needs RECEIPT VERIFIED. */
  async function verdicts(eventId) {
    const read = await readDeal(DEAL, COLUMNS)
    const v = await readerVerdicts({ contract, ...read, eventId })
    const overall = { slice: v.slice.overall, guest: v.guest.overall, audit: v.audit.overall,
      receipt: verifyReceipt(v.receipt.document).verified }
    return { v, overall: Object.fromEntries(Object.entries(overall).map(([k, x]) => [k, typeof x === 'boolean' ? x : word(x?.toLowerCase())])), read }
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000)
    // Per repetition: only a run that creates its own attempt record cleans up.
    armed = false
    // 1. Mode, attempt, run shape, target: before anything is read or sent.
    const testInfo = test.info()
    if (MODE !== 'closed' && MODE !== 'open') throw new Error('TF_DELEGATED_TRIAL must be exactly "closed" or "open"')
    if (testInfo.retry !== 0 || testInfo.repeatEachIndex !== 0 || testInfo.project.repeatEach > 1 || testInfo.config.workers !== 1) {
      throw new Error('run once: --workers=1, no retries, no --repeat-each')
    }
    if (assertE2EProject(SUPABASE_URL) !== E2E_PROJECT_REF || SUPABASE_URL.replace(/\/$/, '') !== E2E_ORIGIN) {
      throw new Error('not the E2E project')
    }
    installPinnedFetch()
    if (MODE === 'closed' && !(UUID.test(OTHER_DEAL ?? '') && OTHER_DEAL !== DEAL)) {
      throw new Error('closed mode needs TF_DELEGATED_OTHER_DEAL: an approved comparison deal other than the fixture')
    }
    ;({ grant, grantId } = readGrantFile(process.env.TF_DELEGATED_GRANT_FILE))

    // 2. The attempt record: exclusive, so this attempt runs at most once.
    state = createState(ATTEMPT_ID, MODE)
    armed = true

    // 3. The gate, read back from the database, before any write-capable request.
    await gateIs(MODE, 'before')

    // 4. The owner, the deal and the grant, read back.
    tf = await loadClient()
    owner = await tf.ownerSession()
    contract = (await tf.rest(owner.token, `contracts?id=eq.${DEAL}&select=*`)).body?.[0]
    if (!contract) throw new Error('the fixture deal is not readable as the test earner')
    if (contract.earner_user_id !== owner.userId) throw new Error('the test earner does not own the fixture deal')
    if (contract.performed_by !== 'creator') throw new Error('the fixture deal is not owner-performed')
    if (contract.state !== 'TERMS_ACCEPTED') throw new Error(`the fixture deal is ${word(contract.state?.toLowerCase())}, not terms_accepted`)
    const g = await listedGrant(tf, owner.token, grantId)
    if (!g) throw new Error('the grant is not listed for the fixture deal')
    if (g.issuer_kind !== 'owner_account' || g.revoked_at !== null) throw new Error('the grant is not a live owner_account grant')
    if (!(Date.parse(g.expires_at) > Date.now() + 15 * 60_000)) throw new Error('the grant expires within 15 minutes')
    if (!g.scopes.includes(TYPE) || g.scopes.includes(OUT_OF_SCOPE_TYPE)) {
      throw new Error(`the grant must include ${TYPE} and exclude ${OUT_OF_SCOPE_TYPE}`)
    }
    // Verified as this trial's grant: from here cleanup revokes it.
    state = updateState(ATTEMPT_ID, { grant_id: grantId })
    let otherCount = null
    if (MODE === 'closed') {
      const other = (await tf.rest(owner.token, `contracts?id=eq.${OTHER_DEAL}&select=id,earner_user_id`)).body?.[0]
      if (!other || other.earner_user_id !== owner.userId) throw new Error('the comparison deal is not an owner-owned deal')
      if (await listedGrant(tf, owner.token, grantId, OTHER_DEAL)) throw new Error('the grant is listed on the comparison deal')
      otherCount = await count(OTHER_DEAL)
    }

    // 5. Baseline, recorded before any write-capable request: verified in every reader.
    if (await keyed(key) !== 0) throw new Error('the attempt key already holds a row')
    const before = await verdicts(null)
    const tip = before.read.rows.at(-1)
    state = updateState(ATTEMPT_ID, { baseline: { count: before.read.rows.length, tip_id: tip?.id ?? null,
      tip_hash: tip?.event_hash ?? null, other_count: otherCount, verdicts: before.overall } })
    const unverified = Object.keys(VERIFIED).filter(k => before.overall[k] !== VERIFIED[k])
    if (unverified.length) throw new Error(`the baseline is not verified in: ${unverified.join(', ')}; nothing is sent`)

    // 6. The flag: a fake grant must be refused 403 (flag on). Its own key, read back.
    pub = await publishableKey()
    // A blank grant: refused in memory by delegatedAdmission when the flag is
    // on, the flag's own 503 when it is off. Only the delegated route's 403
    // word counts as "on"; any other 403 (a legacy route, a gateway) does not.
    const probe = await delegatedPost({ pub, grantHeader: '', body: op({ idempotency_key: `${key}-probe` }) })
    if (probe.status !== 403 || probe.error !== 'delegation_refused') {
      throw new Error(`flag check: the probe got ${probe.status} ${probe.error}, not 403 delegation_refused (is ENTRY_DELEGATED_APPEND on?)`)
    }
    // Seen on: from here cleanup turns it off.
    state = updateState(ATTEMPT_ID, { flag_owned: true })
    if (await keyed(`${key}-probe`) !== 0) throw new Error('the flag probe stored a row')
  })

  test.afterAll(async () => {
    if (!armed) return
    test.setTimeout(900_000)
    try {
      const { problems } = await cleanupTrial({ attempt: ATTEMPT_ID })
      expect(problems, 'afterAll cleanup (rerun: node scripts/delegated-trial-cleanup.mjs <attempt>)').toEqual([])
    } finally {
      armed = false
    }
  })

  test('refusals: each bad grant, deal, type or credential mix is refused and stores no row (item 2; closed gate)', async () => {
    test.skip(MODE !== 'closed', 'cases that would store a row if broken run only behind the confirmed closed gate')
    // [label, request overrides, status, error word]. dispute.opened passes
    // pre-dispatch (ALLOWED_TYPES) and reaches the delegated route, outside
    // DELEGATED_TYPES. A grant can never hold it as a scope (table CHECK and
    // issuance), so the resolver's scope check would refuse it too: the uniform
    // 403 proves the delegated route refused with no row, and only the function
    // log's delegated_refusal "allowlist" tells which check did.
    const cases = [
      ['wrong secret', { grantHeader: `${grantId}.${'0'.repeat(64)}` }, 403, 'delegation_refused'],
      ['unknown grant', { grantHeader: fakeGrant() }, 403, 'delegation_refused'],
      ['malformed grant', { grantHeader: `${grantId}.not-hex` }, 403, 'delegation_refused'],
      ['blank grant', { grantHeader: '' }, 403, 'delegation_refused'],
      ['the grant on a different real deal', { body: { contract_id: OTHER_DEAL } }, 403, 'delegation_refused'],
      ['a type outside the grant', { body: { type: OUT_OF_SCOPE_TYPE } }, 403, 'delegation_refused'],
      ['a type outside the delegated allowlist', { body: { type: 'dispute.opened' } }, 403, 'delegation_refused'],
      ['a server-recorded type (refused before dispatch)', { body: { type: 'dod.consent_recorded' } }, 400, 'type_is_server_recorded'],
      ['grant with a bearer', { extra: [['Authorization', `Bearer ${pub}`]] }, 403, 'delegation_refused'],
      ['two grants in one header', { grantHeader: `${grant}, ${fakeGrant()}` }, 403, 'delegation_refused'],
      ['authority in the body', { body: { credential_id: grantId } }, 400, 'authority_is_server_derived'],
    ]
    for (const [i, [label, over, status, error]] of cases.entries()) {
      const k = `${key}-r${i}`
      const r = await delegatedPost({ pub, grantHeader: over.grantHeader ?? grant,
        body: op({ ...over.body, idempotency_key: k }), extra: over.extra ?? [] })
      expect(r.status, label).toBe(status)
      expect(r.error, label).toBe(error)
      expect(await keyed(k), `${label}: rows with its key`).toBe(0)
    }
    await assertWritten('after refusals', 0)
    expect((await count(OTHER_DEAL)) - state.baseline.other_count, 'comparison deal: rows written').toBe(0)
  })

  test('a valid grant appends one v5 row carrying its authority (item 1); closed gate: 503 and nothing stored', async () => {
    await gateIs(MODE, 'at_append')
    phase(ATTEMPT_ID, 'append_sent', { key })
    const r = await delegatedPost({ pub, grantHeader: grant, body: op() })
    phase(ATTEMPT_ID, 'append_answered', { status: r.status, error: r.error })
    if (MODE === 'closed') {
      expect(r.status, 'closed gate').toBe(503)
      expect(r.error).toBe('delegated_append_unavailable')
      expect(await keyed(key), 'rows with the attempt key').toBe(0)
      await assertWritten('closed gate', 0)
      return
    }
    expect(r.status, `open gate answered ${r.error}`).toBe(201)
    expect(r.json?.deduplicated === false, 'not a replay').toBe(true)
    written = r.json?.event ?? null
    expect(UUID.test(written?.id ?? ''), 'the response carries an event id').toBe(true)
    phase(ATTEMPT_ID, 'appended', { event_id: written.id })
    const expected = { type: TYPE, contract_id: DEAL, hash_version: 5, credential_id: grantId,
      issuer_kind: 'owner_account', actor_id: owner.userId, idempotency_key: key }
    expect(Object.keys(expected).filter(f => written[f] !== expected[f]), 'response fields that differ').toEqual([])
    await assertWritten('after the append', 1)
    const { rows } = await readDeal(DEAL, COLUMNS)
    const stored = rows.find(x => x.id === written.id)
    expect(Boolean(stored), 'the returned event is stored').toBe(true)
    expect(STORED_FIELDS.filter(f => stored[f] !== written[f]), 'stored fields that differ from the response').toEqual([])
    expect(rows.at(-1).id === written.id, 'the delegated row is the tip').toBe(true)
    expect(stored.prev_event_hash === state.baseline.tip_hash, 'it links to the recorded baseline tip').toBe(true)
  })

  test('replay: the same key and grant return the original event, nothing new (item 4)', async () => {
    test.skip(MODE !== 'open', 'needs the delegated row the open gate writes')
    const r = await delegatedPost({ pub, grantHeader: grant, body: op() })
    expect(r.status).toBe(200)
    expect(r.json?.deduplicated === true, 'a replay').toBe(true)
    expect(r.json?.event?.id === written.id, 'the replay returns the original event').toBe(true)
    expect(await keyed(key), 'rows with the attempt key').toBe(1)
    await assertWritten('after the replay', 1)
  })

  test('the live row is match in all four readers, and the whole trail and its receipts verify (item 1)', async () => {
    test.skip(MODE !== 'open', 'needs the delegated row the open gate writes')
    const { v, overall } = await verdicts(written.id)
    phase(ATTEMPT_ID, 'final_verdicts', { verdicts: overall })
    expect(v.index, 'row found').toBeGreaterThanOrEqual(0)
    expect(v.slice.row, 'strict slice').toEqual(ROW_MATCH)
    expect(v.guest.row, 'guest response v2').toEqual(ROW_MATCH)
    expect(v.guest.credential === grantId, 'guest sees the grant id').toBe(true)
    expect(word(v.guest.label), 'guest credential label').toBe('entry_agent_grant')
    expect(v.audit.row, 'owner export').toEqual(ROW_MATCH)
    expect(v.receipt.act?.credential_id === grantId && v.receipt.act?.issuer_kind === 'owner_account', 'receipt act authority').toBe(true)
    expect(overall, 'every reader verifies the whole trail after the append').toEqual(VERIFIED)

    // The receipt CLI end to end, its child pinned to E2E: make-receipt reads
    // the deal itself (exit 0 = issuer recomputation intact), verify-receipt
    // recomputes the file offline.
    const dir = mkdtempSync(path.join(tmpdir(), 'tf-delegated-cli-'))
    try {
      const out = path.join(dir, 'receipt.json')
      const made = runPinnedNode(['scripts/make-receipt.mjs', DEAL, '--out', out], {
        PATH: process.env.PATH, HOME: process.env.HOME, TF_E2E_ENV_FILE: '/dev/null',
        VITE_SUPABASE_URL: E2E_ORIGIN, VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
        TF_TEST_EARNER_EMAIL: process.env.TF_TEST_EARNER_EMAIL, TF_TEST_EARNER_PASSWORD: process.env.TF_TEST_EARNER_PASSWORD,
        ...(process.env.TF_TEST_EARNER_SESSION ? { TF_TEST_EARNER_SESSION: process.env.TF_TEST_EARNER_SESSION } : {}),
      })
      expect(made.status, 'make-receipt exit').toBe(0)
      expect(verifyReceiptFile(out), 'verify-receipt on the CLI receipt').toEqual({ status: 0, verified: true })
      const act = JSON.parse(readFileSync(out, 'utf8')).acts.find(a => a.canonical?.id === written.id)
      expect(act?.canonical?.credential_id === grantId && act?.canonical?.issuer_kind === 'owner_account',
        'the CLI receipt carries the row with its authority').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('revoke: read back as revoked, then the grant is refused (item 3)', async () => {
    const r = await tf.invoke('manage-entry-agent-credential', { ownerToken: owner.token,
      body: { action: 'revoke', contract_id: DEAL, id: grantId } })
    expect(r.status, `revoke answered ${word(r.reason)}`).toBe(200)
    const g = await listedGrant(tf, owner.token, grantId)
    expect(typeof g?.revoked_at === 'string', 'the grant list shows it revoked').toBe(true)
    phase(ATTEMPT_ID, 'revoked')
    // closed: a fresh key, behind the closed gate, so a broken revoke shows as
    // 503, never a row. open: the written key, which the unique index keeps
    // from adding a row even if the check were broken.
    const k = MODE === 'closed' ? `${key}-after-revoke` : key
    const after = await delegatedPost({ pub, grantHeader: grant, body: op({ idempotency_key: k }) })
    expect(after.status, 'after revoke').toBe(403)
    expect(after.error, 'after revoke').toBe('delegation_refused')
    expect(await keyed(k), 'rows with that key').toBe(MODE === 'closed' ? 0 : 1)
    await assertWritten('after revoke', BUDGET[MODE])
  })
})
