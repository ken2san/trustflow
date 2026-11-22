import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// A real receipt, produced by scripts/make-receipt.mjs against the E2E project.
// Its only address is a synthetic example.invalid one from the API harness.
const SAMPLE = path.resolve('tests/fixtures/receipt-sample.json')
const VERIFIER = path.resolve('scripts/verify-receipt.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'tf-receipt-'))

// Every test here starts a fresh Node process (about 0.2 s alone). Inside the
// full parallel suite, CPU contention pushed one past vitest's 5 s default
// (5357 ms; T158, T182). execFileSync blocks, so vitest cannot interrupt a hung
// verifier: SPAWN_MS kills it instead, and the test budget sits above that.
// Scoped to this file; the global testTimeout is unchanged.
const SPAWN_MS = 15_000
const TEST_MS = 20_000

/** Run the verifier on a file. Returns { ok, out }. */
function runVerifier(file) {
  try {
    const out = execFileSync('node', [VERIFIER, file], { encoding: 'utf8', timeout: SPAWN_MS })
    return { ok: true, out, diagnostic: `exit=0\nstdout:\n${out}` }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { ok: false, out, diagnostic: `exit=${e.status ?? 'unknown'} signal=${e.signal ?? 'none'} code=${e.code ?? 'none'}\nerror: ${e.message}\nstdout:\n${e.stdout ?? ''}\nstderr:\n${e.stderr ?? ''}` }
  }
}

/** Write a mutated copy of the sample and verify it. */
function runTampered(label, mutate) {
  const receipt = JSON.parse(readFileSync(SAMPLE, 'utf8'))
  mutate(receipt)
  const file = path.join(dir, `${label.replace(/\W+/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(receipt, null, 2))
  return runVerifier(file)
}

describe('an untampered receipt verifies offline', { timeout: TEST_MS }, () => {
  it('passes, and needs no network or credentials', () => {
    const { ok, out } = runVerifier(SAMPLE)
    expect(out).toContain('RECEIPT VERIFIED')
    expect(out).toContain('0 failed checks')
    expect(ok).toBe(true)
  })

  it('says plainly what it does not prove', () => {
    const { out } = runVerifier(SAMPLE)
    for (const claim of ['identity', 'performance', 'payment', 'intent']) {
      expect(out.toLowerCase()).toContain(claim)
    }
  })
})

// Each of these must go red. A verifier whose rejections have never been
// observed is not a verifier — this project's invoke-error test passed for two
// weeks while the path it covered was broken.
describe('tampering is detected', { timeout: TEST_MS }, () => {
  const cases = [
    ['the agreed amount is changed', r => { r.agreement.snapshot.amount = 999999 }],
    ['the deadline is changed', r => { r.agreement.snapshot.deadline = '2099-01-01' }],
    ['the definition of done is edited', r => { r.agreement.snapshot.dod = ['something else'] }],
    ['who performs is flipped', r => { r.agreement.snapshot.performed_by = 'counterparty' }],
    ['an act is deleted from the middle', r => { r.acts.splice(1, 1) }],
    ['two acts are reordered', r => { [r.acts[1], r.acts[2]] = [r.acts[2], r.acts[1]] }],
    ['an act timestamp is back-dated', r => { r.acts[1].canonical.created_at = '2020-01-01T00:00:00.000Z' }],
    ['an act is attributed to someone else', r => { r.acts[1].canonical.actor_id = 'guest:someone@example.invalid' }],
    ['an act type is relabelled', r => { r.acts[1].canonical.type = 'performance.accepted' }],
    ['a payload digest is swapped', r => { r.acts[1].canonical.payload_hash = 'f'.repeat(64) }],
    ['a chain link is repointed', r => { r.acts[2].canonical.prev_event_hash = r.acts[0].event_hash }],
    ['an act cites a different agreement', r => { r.acts[1].canonical.agreement_hash = 'a'.repeat(64) }],
    ['a stored event_hash is replaced', r => { r.acts[1].event_hash = 'b'.repeat(64) }],
    ['the canonical version is downgraded to dodge a check', r => { r.acts[1].canonical.hash_version = 2 }],
  ]

  for (const [label, mutate] of cases) {
    it(`rejects: ${label}`, () => {
      const { ok, out, diagnostic } = runTampered(label, mutate)
      expect(out, diagnostic).toContain('FAIL')
      expect(out, diagnostic).not.toContain('RECEIPT VERIFIED')
      expect(ok, diagnostic).toBe(false)
    })
  }
})

describe('a receipt that cannot be checked is not accepted as valid', { timeout: TEST_MS }, () => {
  it('rejects an act missing its canonical inputs', () => {
    // The shape the first version of make-receipt.mjs emitted: a digest with
    // nothing to recompute it from.
    const { ok, out } = runTampered('no-canonical', r => { delete r.acts[1].canonical })
    expect(out).toMatch(/carries every canonical input/)
    expect(out).toContain('FAIL')
    expect(ok).toBe(false)
  })

  it('rejects an act missing even one canonical field', () => {
    const { ok, out } = runTampered('partial', r => { delete r.acts[1].canonical.actor_id })
    expect(out).toMatch(/missing: actor_id/)
    expect(ok).toBe(false)
  })

  it('rejects a receipt that asserts its own verdict', () => {
    const { ok, out } = runTampered('self-verdict',
      r => { r.verified_here = { chain_intact: true } })
    expect(out).toMatch(/no self-assessed verdict/)
    expect(ok).toBe(false)
  })

  it('rejects a receipt that strips its own stated limits', () => {
    const { ok, out } = runTampered('no-limits', r => { r.not_verifiable_here = [] })
    expect(out).toMatch(/states its own limits/)
    expect(ok).toBe(false)
  })
})

describe('two receipts for one agreement are compared, which is the only equivocation check', { timeout: TEST_MS }, () => {
  it('passes when both parties were shown the same acts', () => {
    const a = path.join(dir, 'same-a.json')
    const b = path.join(dir, 'same-b.json')
    const r = readFileSync(SAMPLE, 'utf8')
    writeFileSync(a, r); writeFileSync(b, r)
    const { ok, out } = runVerifier(`${a}`) // single-file path still works
    expect(ok).toBe(true)
    const both = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8', timeout: SPAWN_MS })
    expect(both).toContain('same acts, in the same order')
    expect(both).toContain('0 failed checks')
    expect(out).toContain('RECEIPT VERIFIED')
  })

  it('detects an operator showing the two parties different histories', () => {
    const a = path.join(dir, 'equiv-a.json')
    const b = path.join(dir, 'equiv-b.json')
    const base = JSON.parse(readFileSync(SAMPLE, 'utf8'))
    writeFileSync(a, JSON.stringify(base))
    // A second, internally consistent history that simply omits the last act.
    const other = JSON.parse(readFileSync(SAMPLE, 'utf8'))
    other.acts.pop()
    writeFileSync(b, JSON.stringify(other))

    let out = ''
    try { out = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8', timeout: SPAWN_MS }) }
    catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    // Both files verify on their own; only the comparison reveals it.
    expect(out).toMatch(/both parties were shown the same acts[\s\S]*?/)
    expect(out).toContain('FAIL')
  })
})

// ── Receipt v2 (3C-CLI): written by buildReceiptV2, checked by the executable ─
import { buildReceiptV2 } from '../../scripts/lib/receiptV2.mjs'
import {
  eventCanonical, payloadHash, sha256Hex, buildAgreementSnapshot, deriveAgreementHash, stableStringify,
} from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildEventCanonicalV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'

const RCID = '22222222-2222-4222-8222-222222222222'
const ruid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const CONTRACT_V2 = { id: RCID, project_name: 'Receipt v2', dod: ['Translate'], amount_minor: 1250, currency: 'CAD',
  deadline: null, performed_by: 'creator', earner_display_name: 'Example', state: 'TERMS_ACCEPTED' }
let rclock = Date.parse('2026-04-01T00:00:00.000Z')
const rat = () => new Date((rclock += 1000)).toISOString()
const COMPLETE_READ = { start: 'first_event', tail_complete: true, pages: 1, row_cap: 10000 }
const SOURCE = { project_ref: 'test', api: 'test', issued_for_role: 'owner' }

async function v4Row(n, prev, { type = 'performance.asserted', payload = { note: `v4-${n}` }, agreement } = {}) {
  const row = { id: ruid(n), type, contract_id: RCID, actor_id: 'owner', dod_hash: 'd'.repeat(64), created_at: rat(),
    prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement, hash_version: 4,
    credential_id: null, issuer_kind: null }
  row.event_hash = await sha256Hex(eventCanonical(row, 4))
  return row
}
async function v5Row(n, prev, { agreement } = {}) {
  const payload = { note: `v5-${n}` }
  const row = { id: ruid(n), type: 'payment.reported', contract_id: RCID, actor_id: ruid(6), dod_hash: 'd'.repeat(64),
    created_at: rat(), prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement,
    hash_version: 5, credential_id: ruid(7), issuer_kind: 'owner_account' }
  const built = buildEventCanonicalV5(row)
  if (!built.ok) throw new Error(built.field)
  row.event_hash = await sha256Hex(built.canonical)
  return row
}
async function mixedRows(snapshot = buildAgreementSnapshot(CONTRACT_V2)) {
  const accepted = await sha256Hex(stableStringify(snapshot))
  const current = await deriveAgreementHash(CONTRACT_V2)
  const a = await v4Row(1, 'GENESIS', { type: 'dod.consent_recorded', payload: { _agreement: snapshot }, agreement: accepted })
  const b = await v5Row(2, a.event_hash, { agreement: accepted })
  const c = await v4Row(3, b.event_hash, { agreement: current })
  return [a, b, c]
}
async function receiptOf(rows, read = COMPLETE_READ) {
  return buildReceiptV2({ contract: CONTRACT_V2, rows, read, source: SOURCE, issuedAt: '2026-04-01T00:00:00.000Z' })
}
function runReceipt(label, receipt) {
  const file = path.join(dir, `v2-${label.replace(/\W+/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(receipt, null, 2))
  try {
    return { status: 0, out: execFileSync('node', [VERIFIER, file], { encoding: 'utf8', timeout: SPAWN_MS }) }
  } catch (e) {
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('receipt v2 round trip', { timeout: TEST_MS }, () => {
  it('a complete mixed v4 → v5 → v4 receipt verifies', async () => {
    const receipt = await receiptOf(await mixedRows())
    expect(receipt.agreement.accepted_status).toBe('ok')
    expect(Object.keys(receipt.acts[1].canonical)).toContain('credential_id')
    expect(Object.keys(receipt.acts[0].canonical)).not.toContain('credential_id')
    const { status, out } = runReceipt('mixed', receipt)
    expect(out).toContain('RECEIPT VERIFIED')
    expect(status).toBe(0)
  })

  it('a legacy-only v2 receipt verifies', async () => {
    const rows = (await mixedRows()).filter(r => r.hash_version === 4).slice(0, 1)
    const { status, out } = runReceipt('legacy-only', await receiptOf(rows))
    expect(out).toContain('RECEIPT VERIFIED')
    expect(status).toBe(0)
  })

  it('an incomplete read or unknown start is never verified (exit 3), and says so', async () => {
    for (const read of [{ ...COMPLETE_READ, tail_complete: false }, { ...COMPLETE_READ, start: 'unknown' }]) {
      const { status, out } = runReceipt(`read-${read.start}-${read.tail_complete}`, await receiptOf(await mixedRows(), read))
      expect(out).toContain('RECEIPT NOT VERIFIED — incomplete')
      expect(out).not.toContain('RECEIPT VERIFIED —')
      expect(status).toBe(3)
    }
  })

  it('a tampered credential_id or issuer_kind fails', async () => {
    for (const [k, v] of [['credential_id', ruid(8)], ['issuer_kind', 'counterpart_account']]) {
      const receipt = await receiptOf(await mixedRows())
      receipt.acts[1].canonical[k] = v
      const { status, out } = runReceipt(`tamper-${k}`, receipt)
      expect(out).toContain('FAIL')
      expect(status).toBe(1)
    }
  })

  it('a v5 act missing any canonical input fails', async () => {
    for (const k of ['credential_id', 'issuer_kind', 'hash_version', 'agreement_hash', 'prev_event_hash']) {
      const receipt = await receiptOf(await mixedRows())
      delete receipt.acts[1].canonical[k]
      const { status, out } = runReceipt(`missing-${k}`, receipt)
      expect(out, k).toContain('FAIL')
      expect(status, k).toBe(1)
    }
  })

  it('a prev_hash alias fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.acts[1].canonical.prev_hash = receipt.acts[1].canonical.prev_event_hash
    const { status, out } = runReceipt('alias', receipt)
    expect(out).toMatch(/uses only prev_event_hash/)
    expect(status).toBe(1)
  })

  it('a v5 act inside a v1 receipt fails rather than verifying as legacy', async () => {
    const v2 = await receiptOf(await mixedRows())
    const v1 = { ...v2, receipt_version: 1,
      agreement: { contract_id: RCID, snapshot: v2.agreement.accepted.snapshot, agreement_hash: v2.agreement.accepted.agreement_hash } }
    const { status, out } = runReceipt('v5-in-v1', v1)
    expect(out).toMatch(/not a legacy act/)
    expect(status).toBe(1)
  })

  it('a draft-only receipt has no accepted agreement and verifies as pre-acceptance', async () => {
    const d = await v5Row(4, 'GENESIS', { agreement: null })
    const receipt = await receiptOf([d])
    expect(receipt.agreement.accepted).toBe(null)
    expect(receipt.agreement.accepted_status).toBe('no_acceptance')
    const { status, out } = runReceipt('draft', receipt)
    expect(out).toMatch(/no accepted agreement in this receipt/)
    expect(status).toBe(0)
  })

  it('a self-consistently hashed wrong-type accepted snapshot is not accepted, so the receipt is not verified', async () => {
    const bad = { ...buildAgreementSnapshot(CONTRACT_V2), amount: '1250' }
    const receipt = await receiptOf(await mixedRows(bad))
    expect(receipt.agreement.accepted).toBe(null)
    expect(receipt.agreement.accepted_status).toBe('invalid_snapshot_values')
    const { status, out } = runReceipt('bad-snapshot', receipt)
    expect(out).not.toContain('RECEIPT VERIFIED —')
    expect(status).not.toBe(0)
  })

  it('an accepted block that does not match its acceptance act fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.agreement.accepted.acceptance_event_id = ruid(9)
    const { status, out } = runReceipt('accepted-id', receipt)
    expect(out).toMatch(/FAIL the accepted agreement follows/)
    expect(status).toBe(1)
  })

  it('two v2 receipts are compared on the accepted agreement too', async () => {
    const rows = await mixedRows()
    const a = path.join(dir, 'v2-cmp-a.json')
    const b = path.join(dir, 'v2-cmp-b.json')
    const ra = await receiptOf(rows)
    writeFileSync(a, JSON.stringify(ra)); writeFileSync(b, JSON.stringify(ra))
    const same = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8', timeout: SPAWN_MS })
    expect(same).toContain('both receipts describe the same agreement')
    expect(same).toContain('same acts, in the same order')
  })
})
