import { describe, it, expect } from 'vitest'
import { readerVerdicts, verifyReceipt, ROW_MATCH } from '../../tests/e2e/delegatedReaders.js'
import {
  eventCanonical, payloadHash, sha256Hex, buildAgreementSnapshot, stableStringify,
} from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildEventCanonicalV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import { assuranceForRecord, grantAssurance } from '../../supabase/functions/_shared/authAssurance.ts'

// The reader helper of tests/e2e/delegated-append.spec.js, over a locally built
// trail shaped like the live fixture: a v4 acceptance, older v4 acts, then one
// delegated v5 act. This is the spec's only dry run that needs no hosted
// project: a helper that cannot tell `match` from a tampered row would make
// the live trial's reader assertions meaningless.

const CID = '33333333-3333-4333-8333-333333333333'
const uid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const OWNER = uid(6)
const GRANT = uid(7)
const CONTRACT = { id: CID, project_name: 'Delegated trial', dod: ['Translate'], amount_jpy: null, amount_minor: 1250,
  currency: 'CAD', deadline: null, performed_by: 'creator', earner_display_name: 'Example', earner_user_id: OWNER,
  state: 'TERMS_ACCEPTED', hirer_email: 'guest@example.test' }
const READ = { start: 'first_event', tail_complete: true, pages: 1, row_cap: 10000 }
let clock = Date.parse('2026-05-01T00:00:00.000Z')
const at = () => new Date((clock += 1000)).toISOString()

async function v4(n, prev, { type = 'performance.asserted', payload = { note: `v4-${n}` }, agreement, actor = OWNER } = {}) {
  const row = { id: uid(n), type, contract_id: CID, actor_id: actor, dod_hash: 'd'.repeat(64), created_at: at(),
    prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement, hash_version: 4,
    idempotency_key: null, tsa_token: null, credential_id: null, issuer_kind: null }
  row.event_hash = await sha256Hex(eventCanonical(row, 4))
  return row
}
async function v5(n, prev, agreement) {
  // The server-recorded assurance fields a delegated write carries.
  const payload = { note: 'delegated', _auth_method: 'entry_agent_grant', _authentication: assuranceForRecord(grantAssurance()) }
  const row = { id: uid(n), type: 'performance.asserted', contract_id: CID, actor_id: OWNER, dod_hash: 'd'.repeat(64),
    created_at: at(), prev_event_hash: prev, payload, payload_hash: await payloadHash(payload), agreement_hash: agreement,
    hash_version: 5, idempotency_key: 'k', tsa_token: null, credential_id: GRANT, issuer_kind: 'owner_account' }
  const built = buildEventCanonicalV5(row)
  if (!built.ok) throw new Error(built.field)
  row.event_hash = await sha256Hex(built.canonical)
  return row
}
async function trail() {
  const snapshot = buildAgreementSnapshot(CONTRACT)
  const accepted = await sha256Hex(stableStringify(snapshot))
  const a = await v4(1, 'GENESIS', { type: 'dod.consent_recorded', actor: 'guest:guest@example.test',
    payload: { _agreement: snapshot, _invited_recipient: 'guest@example.test', counterparty_name: 'G' }, agreement: accepted })
  const b = await v4(2, a.event_hash, { agreement: accepted })
  const c = await v5(3, b.event_hash, accepted)
  return [a, b, c]
}

describe('delegated trial readers (dry run of the live spec helper)', () => {
  it('the untouched delegated v5 row is match in all four readers, and the receipt CLI verifies', async () => {
    const rows = await trail()
    const v = await readerVerdicts({ contract: CONTRACT, rows, read: READ, eventId: uid(3) })
    expect(v.index).toBe(2)
    expect(v.slice).toEqual({ overall: 'verified', row: ROW_MATCH })
    expect(v.guest.row).toEqual(ROW_MATCH)
    expect(v.guest.overall).toBe('verified')
    expect(v.guest.credential).toBe(GRANT)
    expect(v.guest.label).toBe('entry_agent_grant')
    expect(v.audit).toEqual({ overall: 'VERIFIED', row: ROW_MATCH })
    expect(v.receipt.act).toEqual({ credential_id: GRANT, issuer_kind: 'owner_account' })
    expect(verifyReceipt(v.receipt.document)).toEqual({ status: 0, verified: true })
  }, 60_000)

  it('a tampered authority field is a hash mismatch in every reader, and the receipt CLI refuses it', async () => {
    for (const field of ['credential_id', 'issuer_kind']) {
      const rows = await trail()
      rows[2] = { ...rows[2], [field]: field === 'credential_id' ? uid(8) : 'counterpart_account' }
      const v = await readerVerdicts({ contract: CONTRACT, rows, read: READ, eventId: uid(3) })
      expect(v.slice.row.hash, field).toBe('mismatch')
      expect(v.guest.row.hash, field).toBe('mismatch')
      expect(v.audit.row.hash, field).toBe('mismatch')
      expect(v.slice.overall, field).toBe('failed')
      const { status, verified } = verifyReceipt(v.receipt.document)
      expect(verified, field).toBe(false)
      expect(status, field).not.toBe(0)
    }
  }, 60_000)

  it('a missing row is reported as absent, never as a pass', async () => {
    const rows = await trail()
    const v = await readerVerdicts({ contract: CONTRACT, rows, read: READ, eventId: uid(9) })
    expect(v.index).toBe(-1)
    expect(v.slice.row).toBeNull()
    expect(v.guest.row).toBeNull()
    expect(v.audit.row).toBeNull()
    expect(v.receipt.act).toBeNull()
  })
})
