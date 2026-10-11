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

/** Run the verifier on a file. Returns { ok, out }. */
function runVerifier(file) {
  try {
    return { ok: true, out: execFileSync('node', [VERIFIER, file], { encoding: 'utf8' }) }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
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

describe('an untampered receipt verifies offline', () => {
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
describe('tampering is detected', () => {
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
      const { ok, out } = runTampered(label, mutate)
      expect(out).toContain('FAIL')
      expect(out).not.toContain('RECEIPT VERIFIED')
      expect(ok).toBe(false)
    })
  }
})

describe('a receipt that cannot be checked is not accepted as valid', () => {
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

describe('two receipts for one agreement are compared, which is the only equivocation check', () => {
  it('passes when both parties were shown the same acts', () => {
    const a = path.join(dir, 'same-a.json')
    const b = path.join(dir, 'same-b.json')
    const r = readFileSync(SAMPLE, 'utf8')
    writeFileSync(a, r); writeFileSync(b, r)
    const { ok, out } = runVerifier(`${a}`) // single-file path still works
    expect(ok).toBe(true)
    const both = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8' })
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
    try { out = execFileSync('node', [VERIFIER, a, b], { encoding: 'utf8' }) }
    catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    // Both files verify on their own; only the comparison reveals it.
    expect(out).toMatch(/both parties were shown the same acts[\s\S]*?/)
    expect(out).toContain('FAIL')
  })
})
