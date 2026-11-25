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
async function receiptOf(rows, read = COMPLETE_READ, contract = CONTRACT_V2) {
  return buildReceiptV2({ contract, rows, read, source: SOURCE, issuedAt: '2026-04-01T00:00:00.000Z' })
}
// The same deal with its terms changed after acceptance.
const CONTRACT_B = { ...CONTRACT_V2, amount_minor: 9999 }
function runReceipt(label, ...receipts) {
  const files = receipts.map((receipt, index) => {
    const file = path.join(dir, `v2-${label.replace(/\W+/g, '-')}-${index}.json`)
    writeFileSync(file, JSON.stringify(receipt, null, 2))
    return file
  })
  try {
    return { status: 0, out: execFileSync('node', [VERIFIER, ...files], { encoding: 'utf8', timeout: SPAWN_MS }) }
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
    expect(out).toContain('current terms match the accepted agreement')
    expect(out).toMatch(/issuer's asserted read boundary/)
    expect(out).not.toMatch(/pre-acceptance chain only/)
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
    expect(out).toContain('RECEIPT VERIFIED — pre-acceptance chain only (agreement: no_acceptance)')
    expect(out).toMatch(/proves nothing about accepted terms/)
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

// ── T205: Codex T174's must-fix items for c51de66 ───────────────────────────
describe('T205: the agreement baseline is the accepted digest, never current terms', { timeout: TEST_MS }, () => {
  it('a later valid v4 act citing changed terms fails even when current terms equal them', async () => {
    const snapshot = buildAgreementSnapshot(CONTRACT_V2)
    const accepted = await sha256Hex(stableStringify(snapshot))
    const changed = await deriveAgreementHash(CONTRACT_B)
    const a = await v4Row(8, 'GENESIS', { type: 'dod.consent_recorded', payload: { _agreement: snapshot }, agreement: accepted })
    const b = await v5Row(9, a.event_hash, { agreement: accepted })
    const c = await v4Row(5, b.event_hash, { agreement: changed })
    const { status, out } = runReceipt('baseline-attack', await receiptOf([a, b, c], COMPLETE_READ, CONTRACT_B))
    expect(out).toMatch(/FAIL \[2\] legacy .*agreement=mismatch/)
    expect(out).not.toContain('RECEIPT VERIFIED')
    expect(status).toBe(1)
  })

  it('terms changed after acceptance are reported as drift, not as a failure of the record', async () => {
    const { status, out } = runReceipt('drift', await receiptOf(await mixedRows(), COMPLETE_READ, CONTRACT_B))
    expect(out).toContain('current terms differ from the accepted agreement (drift since acceptance; not a failure of the record)')
    expect(out).toContain('RECEIPT VERIFIED')
    expect(status).toBe(0)
  })

  it('an acceptance act with its accepted block removed fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.agreement.accepted = null
    const { status, out } = runReceipt('accepted-removed', receipt)
    expect(out).toMatch(/FAIL an acceptance act is present, so the receipt carries its validated accepted agreement/)
    expect(status).toBe(1)
  })

  it('a v4 draft with no acceptance has no baseline: incomplete, never verified against today\'s terms', async () => {
    const d = await v4Row(14, 'GENESIS', { type: 'contract.initiated', agreement: await deriveAgreementHash(CONTRACT_V2) })
    const { status, out } = runReceipt('v4-draft', await receiptOf([d]))
    expect(out).toContain('RECEIPT NOT VERIFIED — incomplete')
    expect(status).toBe(3)
  })
})

describe('T205: a receipt is bound to one deal', { timeout: TEST_MS }, () => {
  it('relabelling the envelope deal id fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.agreement.contract_id = ruid(9)
    const { status, out } = runReceipt('relabel', receipt)
    expect(out).toMatch(/FAIL \[0\] .* belongs to the deal this receipt names/)
    expect(status).toBe(1)
  })

  it('a missing deal id fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    delete receipt.agreement.contract_id
    const { status, out } = runReceipt('no-deal', receipt)
    expect(out).toMatch(/FAIL the receipt names the deal it is for/)
    expect(status).toBe(1)
  })

  it('an act from another deal fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.acts[2].canonical.contract_id = ruid(9)
    const { status, out } = runReceipt('foreign-act', receipt)
    expect(out).toMatch(/FAIL \[2\] .* belongs to the deal this receipt names/)
    expect(status).toBe(1)
  })

  it('a duplicate snapshot_version that disagrees with the snapshot fails', async () => {
    const receipt = await receiptOf(await mixedRows())
    receipt.agreement.accepted.snapshot_version = 2
    const { status, out } = runReceipt('snapshot-version', receipt)
    expect(out).toMatch(/FAIL the accepted snapshot_version matches the snapshot it describes/)
    expect(status).toBe(1)
  })

  it('compare refuses when a receipt did not verify on its own', async () => {
    const good = await receiptOf(await mixedRows())
    const relabelled = JSON.parse(JSON.stringify(good))
    relabelled.agreement.contract_id = ruid(9)
    const a = path.join(dir, 'v2-cmp-label-a.json')
    const b = path.join(dir, 'v2-cmp-label-b.json')
    writeFileSync(a, JSON.stringify(good)); writeFileSync(b, JSON.stringify(relabelled))
    let out = ''
    try { out = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8', timeout: SPAWN_MS }) }
    catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    expect(out).toMatch(/FAIL both receipts verified on their own before comparing/)
    expect(out).not.toContain('same acts, in the same order')
  })

  it('skips comparison of unequal incomplete prefixes and preserves exit 3', async () => {
    const rows = await mixedRows()
    const read = { ...COMPLETE_READ, tail_complete: false }
    const shorter = await receiptOf(rows.slice(0, 1), read)
    const longer = await receiptOf(rows.slice(0, 2), read)

    const { status, out } = runReceipt('incomplete-compare', shorter, longer)
    expect(status).toBe(3)
    expect(out).toContain('Comparison skipped: both receipts must verify individually.')
    expect(out).not.toContain('same acts, in the same order')
    expect(out).toContain('0 failed checks')
    expect(out).toContain('RECEIPT NOT VERIFIED — incomplete')
  })
})

// ── T247: a declared withheld input is unavailable (exit 3), never a pass ────
// Codex T202 option (a), Kenji 2026-11-25. The delegated owner read withholds a
// legacy guest actor (guest:<address>) and declares it in canonical_withheld.
import { OWNER_READ_SOURCE } from '../../supabase/functions/_shared/ownerReadResponse.ts'
import { WITHHELD_LIMIT } from '../../supabase/functions/_shared/receiptV2.ts'

async function withheldReceipt({ source = OWNER_READ_SOURCE, read = COMPLETE_READ } = {}) {
  const snapshot = buildAgreementSnapshot(CONTRACT_V2)
  const accepted = await sha256Hex(stableStringify(snapshot))
  const a = await v4Row(1, 'GENESIS', { type: 'dod.consent_recorded', payload: { _agreement: snapshot }, agreement: accepted })
  // The acceptance as a guest wrote it, hashed over its real actor ...
  a.actor_id = 'guest:withheld-canary'
  a.event_hash = await sha256Hex(eventCanonical(a, 4))
  const b = await v5Row(2, a.event_hash, { agreement: accepted })
  const c = await v4Row(3, b.event_hash, { agreement: accepted })
  // ... and as the owner read projects it: actor absent, declared withheld.
  delete a.actor_id
  a.withheld = ['actor_id']
  return buildReceiptV2({ contract: CONTRACT_V2, rows: [a, b, c], read, source, issuedAt: '2026-04-01T00:00:00.000Z', carriesIdempotencyKey: false })
}
const failLines = out => out.split('\n').filter(l => l.startsWith('FAIL'))

describe('T247: canonical_withheld on the delegated owner read', { timeout: TEST_MS }, () => {
  it('the declared legacy guest actor: exit 3, no failure, its hash unavailable, everything else checked', async () => {
    const receipt = await withheldReceipt()
    expect(receipt.acts[0].canonical_withheld).toEqual(['actor_id'])
    expect('actor_id' in receipt.acts[0].canonical).toBe(false)
    expect(receipt.not_verifiable_here).toContain(WITHHELD_LIMIT)
    expect(JSON.stringify(receipt)).not.toContain('withheld-canary')
    const { status, out } = runReceipt('withheld-ok', receipt)
    expect(failLines(out)).toEqual([])
    expect(out).toContain(' ok  [0] dod.consent_recorded declares a supported withheld input')
    expect(out).toContain('withheld by the reader: actor_id')
    expect(out).toMatch(/\[0\] legacy hash=unavailable link=linked agreement=match/)
    expect(out).toMatch(/\[1\] v5 hash=match link=linked/)
    expect(out).toContain(' ok  the accepted agreement follows from its snapshot and the acceptance act')
    expect(out).toContain('RECEIPT NOT VERIFIED — incomplete')
    expect(out).not.toContain('RECEIPT VERIFIED')
    expect(status).toBe(3)
  })

  it('two such receipts are never compared as a match', async () => {
    const r = await withheldReceipt()
    const { status, out } = runReceipt('withheld-compare', r, r)
    expect(out).toContain('Comparison skipped')
    expect(out).not.toContain('same acts, in the same order')
    expect(status).toBe(3)
  })

  const misdeclared = [
    ['outside the delegated owner read', r => { r.source = SOURCE }, 'only the delegated owner read may declare'],
    ['undeclared omission', r => { delete r.acts[0].canonical_withheld }, 'missing: actor_id'],
    ['declared but present', r => { r.acts[0].canonical.actor_id = 'guest:x' }, 'declared but present: actor_id'],
    ['duplicate entries', r => { r.acts[0].canonical_withheld = ['actor_id', 'actor_id'] }, 'duplicate entries'],
    ['empty declaration', r => { r.acts[0].canonical_withheld = [] }, 'not a non-empty list'],
    ['not a list', r => { r.acts[0].canonical_withheld = 'actor_id' }, 'not a non-empty list'],
    ['an unknown key', r => { delete r.acts[0].canonical.dod_hash; r.acts[0].canonical_withheld = ['actor_id', 'dod_hash'] }, 'not a withholdable input: dod_hash'],
    ['an absent input left out of the declaration', r => { delete r.acts[0].canonical.dod_hash }, 'absent but undeclared: dod_hash'],
    ['on a v5 act', r => { delete r.acts[1].canonical.actor_id; r.acts[1].canonical_withheld = ['actor_id'] }, 'only a legacy act may withhold an input (this act is v5)'],
    ['a v5 authority omission', r => { delete r.acts[1].canonical.credential_id; r.acts[1].canonical_withheld = ['credential_id'] }, 'not a withholdable input: credential_id'],
  ]
  for (const [label, mutate, reason] of misdeclared) {
    it(`misdeclared (${label}): exit 1`, async () => {
      const receipt = await withheldReceipt()
      mutate(receipt)
      const { status, out } = runReceipt(`withheld-${label}`, receipt)
      expect(out, label).toContain(reason)
      expect(failLines(out).length, label).toBeGreaterThan(0)
      expect(status, label).toBe(1)
    })
  }

  it('a malformed stored hash on the withheld act still fails', async () => {
    const receipt = await withheldReceipt()
    receipt.acts[0].event_hash = 'not-a-digest'
    const { status, out } = runReceipt('withheld-malformed-hash', receipt)
    expect(out).toMatch(/FAIL \[0\] legacy hash=invalid_input/)
    expect(status).toBe(1)
  })

  it('a substituted stored hash on the withheld act breaks the next link', async () => {
    const receipt = await withheldReceipt()
    receipt.acts[0].event_hash = 'e'.repeat(64)
    const { status, out } = runReceipt('withheld-broken-link', receipt)
    expect(out).toMatch(/\[0\] legacy hash=unavailable/)
    expect(out).toMatch(/FAIL \[1\] v5 hash=match link=broken/)
    expect(status).toBe(1)
  })

  it('tampering in the later, fully supplied v5 act still fails', async () => {
    const receipt = await withheldReceipt()
    receipt.acts[1].canonical.dod_hash = 'f'.repeat(64)
    const { status, out } = runReceipt('withheld-v5-tamper', receipt)
    expect(out).toMatch(/FAIL \[1\] v5 hash=mismatch/)
    expect(status).toBe(1)
  })

  it('a tampered accepted snapshot still fails beside the unavailable hash', async () => {
    const receipt = await withheldReceipt()
    receipt.agreement.accepted.snapshot.amount = 1
    const { status, out } = runReceipt('withheld-snapshot', receipt)
    expect(out).toContain('FAIL the accepted agreement follows from its snapshot and the acceptance act')
    expect(status).toBe(1)
  })

  it('CLI receipts are unchanged: no declaration, no extra limit, the idempotency key field kept', async () => {
    const receipt = await receiptOf(await mixedRows())
    expect(receipt.acts.every(a => !('canonical_withheld' in a) && 'idempotency_key' in a)).toBe(true)
    expect(receipt.not_verifiable_here).not.toContain(WITHHELD_LIMIT)
    expect(runReceipt('cli-unchanged', receipt).status).toBe(0)
  })
})

// ── T248 (Codex T203): a declaration is honoured only over well-formed evidence ─
// The withheld act is the receipt's ONLY act, so no later link can fail in its
// place: whatever fails here is the withheld act's own check.
async function withheldOnly({ type = 'dod.consent_recorded' } = {}) {
  const snapshot = buildAgreementSnapshot(CONTRACT_V2)
  const accepted = await sha256Hex(stableStringify(snapshot))
  const acceptance = type === 'dod.consent_recorded'
  const a = await v4Row(1, 'GENESIS', { type, payload: acceptance ? { _agreement: snapshot } : { note: 'n' }, agreement: acceptance ? accepted : null })
  a.actor_id = 'guest:withheld-canary'
  a.event_hash = await sha256Hex(eventCanonical(a, 4))
  delete a.actor_id
  a.withheld = ['actor_id']
  return buildReceiptV2({ contract: CONTRACT_V2, rows: [a], read: COMPLETE_READ, source: OWNER_READ_SOURCE, issuedAt: '2026-04-01T00:00:00.000Z', carriesIdempotencyKey: false })
}

describe('T248: the withheld act must otherwise be well formed', { timeout: TEST_MS }, () => {
  it('control: the single declared act is incomplete (exit 3) with no failure', async () => {
    const { status, out } = runReceipt('t248-control', await withheldOnly())
    expect(failLines(out)).toEqual([])
    expect(out).toMatch(/ ok {2}\[0\] legacy hash=unavailable link=linked agreement=match/)
    expect(status).toBe(3)
  })

  for (const [label, mutate] of [
    ['a null stored hash', r => { r.acts[0].event_hash = null }],
    ['an absent stored hash', r => { delete r.acts[0].event_hash }],
  ]) {
    it(`${label} under a declaration fails (exit 1), not missing proof`, async () => {
      const receipt = await withheldOnly()
      mutate(receipt)
      const { status, out } = runReceipt(`t248-${label}`, receipt)
      expect(out).toMatch(/FAIL \[0\] legacy hash=invalid_input .*event_hash: not a recorded digest/)
      expect(failLines(out)).toHaveLength(1)
      expect(status).toBe(1)
    })
  }

  // A complete key set, a valid declaration, one malformed remaining input.
  for (const [field, value, reason] of [
    ['payload_hash', 'not-a-digest', 'payload_hash: not a digest or null for this version'],
    ['dod_hash', 'D'.repeat(64), 'dod_hash: not a digest or null'],
    ['created_at', '2026-04-01 00:00:01', 'created_at: not a zoned timestamp'],
    ['created_at', '2026-13-45T99:99:99Z', 'created_at: not a zoned timestamp'],
    ['id', 'not-a-uuid', 'id: not a UUID'],
    ['type', '', 'type: not a recorded event type'],
    ['prev_event_hash', 'zz', 'prev_event_hash: not a digest, GENESIS or null for this version'],
    ['agreement_hash', 42, 'agreement_hash: not a digest or null for this version'],
  ]) {
    it(`a malformed ${field} (${JSON.stringify(value)}) on the withheld act fails (exit 1)`, async () => {
      const receipt = await withheldOnly()
      receipt.acts[0].canonical[field] = value
      expect(Object.keys(receipt.acts[0].canonical).sort()).toEqual(
        ['agreement_hash', 'contract_id', 'created_at', 'dod_hash', 'hash_version', 'id', 'payload_hash', 'prev_event_hash', 'type'])
      expect(receipt.acts[0].canonical_withheld).toEqual(['actor_id'])
      const { status, out } = runReceipt(`t248-${field}-${String(value).slice(0, 8)}`, receipt)
      // The declaration itself is valid; the failure is the malformed input.
      expect(out).toMatch(/ ok {2}\[0\] .*declares a supported withheld input/)
      expect(out).toMatch(new RegExp(`FAIL \\[0\\] legacy hash=invalid_input .*${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      expect(status).toBe(1)
    })
  }

  it('permitted legacy nulls stay permitted: null payload, DoD and agreement digests are incomplete, not failed', async () => {
    const receipt = await withheldOnly({ type: 'performance.asserted' })
    Object.assign(receipt.acts[0].canonical, { payload_hash: null, dod_hash: null, agreement_hash: null })
    const { status, out } = runReceipt('t248-nulls', receipt)
    expect(failLines(out)).toEqual([])
    expect(out).toMatch(/\[0\] legacy hash=unavailable/)
    expect(status).toBe(3)
  })

  it('a non-UTC zoned timestamp, as the RPC can emit it, is well formed', async () => {
    const receipt = await withheldOnly()
    receipt.acts[0].canonical.created_at = receipt.acts[0].canonical.created_at.replace(/\.\d{3}Z$/, '.123456-05:00')
    const { status, out } = runReceipt('t248-zone', receipt)
    expect(out).toMatch(/\[0\] legacy hash=unavailable/)
    expect(failLines(out)).toEqual([])
    expect(status).toBe(3)
  })
})

// ── T249 (Codex T204): the calendar day itself, never a Date rollover ───────
describe('T249: withheld-act timestamps are checked against the calendar', { timeout: TEST_MS }, () => {
  const at = async (created_at) => {
    const receipt = await withheldOnly()
    receipt.acts[0].canonical.created_at = created_at
    return runReceipt(`t249-${created_at}`, receipt)
  }
  for (const bad of [
    '2026-02-29T00:00:01.000Z',       // not a leap year: Date would roll it to 1 March
    '1900-02-29T00:00:01.000Z',       // century, not a leap year
    '2026-04-31T00:00:01.000Z',       // April has 30 days
    '2026-04-01T24:00:00.000Z',       // PostgreSQL never emits 24:00
    '2026-04-01T00:00:01.000+24:00',  // no such offset
  ]) {
    it(`${bad} fails (exit 1)`, async () => {
      const { status, out } = await at(bad)
      expect(out).toMatch(/FAIL \[0\] legacy hash=invalid_input .*created_at: not a zoned timestamp/)
      expect(status).toBe(1)
    })
  }
  for (const good of ['2028-02-29T00:00:01.000Z', '2000-02-29T00:00:01.000Z', '2026-04-01T00:00:01.123456-05:00']) {
    it(`${good} is well formed (exit 3)`, async () => {
      const { status, out } = await at(good)
      expect(out).toMatch(/\[0\] legacy hash=unavailable/)
      expect(failLines(out)).toEqual([])
      expect(status).toBe(3)
    })
  }
})
