// tests/e2e/delegatedReaders.js
//
// The four row 3 readers, run in-process over one deal's stored rows, reduced
// to the verdicts the delegated-append trial asserts on (plan
// docs/plans/row4-owner-append.md, "What counts as done" item 1):
//
//   slice    supabase/functions/_shared/eventVerifyV5.ts verifyEvidenceSlice,
//            with the options scripts/make-receipt.mjs uses
//   guest    supabase/functions/_shared/guestResponse.ts, response version 2
//   audit    src/lib/auditExport.js buildAuditDocument (the owner export)
//   receipt  supabase/functions/_shared/receiptV2.ts buildReceiptV2, checked by
//            scripts/verify-receipt.mjs (the receipt CLI's offline half)
//
// No network and no credentials in the readers: the caller fetches the rows.
// That keeps them testable against a locally built trail (tests/unit/
// delegatedReaders.test.js), the only dry run possible without a hosted
// project. runPinnedNode is the one networked runner, and its child is pinned
// to E2E by scripts/lib/pinnedFetchPreload.mjs.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyEvidenceSlice } from '../../supabase/functions/_shared/eventVerifyV5.ts'
import { guestResponse } from '../../supabase/functions/_shared/guestResponse.ts'
import { acceptedAgreementHashOf } from '../../supabase/functions/_shared/guestEventView.ts'
import { buildReceiptV2 } from '../../supabase/functions/_shared/receiptV2.ts'
import { buildAuditDocument } from '../../src/lib/auditExport.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const VERIFY_RECEIPT = path.join(REPO_ROOT, 'scripts/verify-receipt.mjs')
const PINNED_PRELOAD = pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/pinnedFetchPreload.mjs')).href
// The verifier's line for a full (post-acceptance) recomputation. Its
// pre-acceptance variant is not a pass for an accepted deal.
const VERIFIED_LINE = 'RECEIPT VERIFIED — recomputed offline'

/** The four per-row checks every reader reports for a v5 row, all passing. */
export const ROW_MATCH = Object.freeze({ hash: 'match', link: 'linked', payload: 'match', agreement: 'match' })
const pick = r => (r ? { hash: r.hash, link: r.link, payload: r.payload, agreement: r.agreement } : null)

/**
 * Every reader's verdict on the trail and on the row `eventId`.
 * `read` is the boundary the rows were read under ({ start, tail_complete, ... },
 * as scripts/lib/pagedEvents.mjs returns it).
 */
export async function readerVerdicts({ contract, rows, read, eventId }) {
  const accepted = await acceptedAgreementHashOf(rows)
  const index = rows.findIndex(r => r.id === eventId)

  const slice = await verifyEvidenceSlice(rows, {
    startsAtChainStart: read.start === 'first_event',
    tailComplete: read.tail_complete,
    acceptance: read.start === 'first_event' && read.tail_complete
      && !rows.some(r => r.type === 'dod.consent_recorded') ? 'none' : 'unknown',
    acceptedAgreementHash: accepted.hash,
    legacyAgreementHash: accepted.hash,
  })

  const { body: guest } = await guestResponse(rows, contract, { version: 2, maxEvents: 10_000, count: rows.length })
  const guestRow = guest.events.find(e => e.id === eventId) ?? null

  const { trustflow_audit_trail: audit } = await buildAuditDocument({
    contractId: contract.id, dodHash: rows[0]?.dod_hash ?? null, events: rows,
    evidence: { start: read.start, tailComplete: read.tail_complete === true },
  })
  const auditRow = audit.events.find(e => e.id === eventId) ?? null

  const receipt = await buildReceiptV2({
    contract, rows, read, source: { project_ref: 'trial', api: 'trial', issued_for_role: 'owner' },
  })
  const act = receipt.acts.find(a => a.canonical?.id === eventId) ?? null

  return {
    index,
    slice: { overall: slice.overall, row: pick(index < 0 ? null : slice.rows[index]) },
    guest: {
      overall: guest.strict_verification?.server?.overall ?? null,
      row: pick(guestRow?.integrity?.strict),
      // The grant id the guest sees in the row's canonical inputs, and the
      // credential label derived from the server-recorded assurance fields.
      credential: guestRow?.canonical?.credential_id ?? null,
      label: guestRow?.recorded_credential ?? null,
    },
    audit: { overall: audit.integrity_status, row: pick(auditRow?._export_verification?.strict_v5) },
    receipt: {
      document: receipt,
      act: act ? { credential_id: act.canonical.credential_id ?? null, issuer_kind: act.canonical.issuer_kind ?? null } : null,
    },
  }
}

/**
 * The receipt CLI's offline verifier on a file: { status, verified }, where
 * verified needs exit 0 and the full recomputation line. Its output is never
 * returned, so nothing from the receipt can reach a test message.
 */
export function verifyReceiptFile(file) {
  const { status, out } = runNode([VERIFY_RECEIPT, file])
  return { status, verified: status === 0 && out.includes(VERIFIED_LINE) }
}

/** The same, on a receipt object; its temporary directory is removed after. */
export function verifyReceipt(receipt) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-delegated-receipt-'))
  try {
    const file = path.join(dir, 'receipt.json')
    writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 })
    return verifyReceiptFile(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A networked repository script in a child whose fetch is pinned to E2E
 * before its first module runs (scripts/lib/pinnedFetchPreload.mjs), with
 * exactly the environment the caller passes. Exit status only.
 */
export function runPinnedNode(args, env) {
  return { status: runNode(['--import', PINNED_PRELOAD, ...args], { env }).status }
}

function runNode(args, { env = { PATH: process.env.PATH }, timeout = 120_000 } = {}) {
  try {
    return { status: 0, out: execFileSync('node', args, { cwd: REPO_ROOT, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : -1, out: '' }
  }
}
