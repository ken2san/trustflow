import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { E2E_ORIGIN } from '../../scripts/lib/pinnedFetch.mjs'
import { runRevoke } from '../../scripts/agents/bootstrap.mjs'
import { budgetedOwner, guestFixture, parseRun, privateAttempt, runFixture, verifyGuestTrail } from '../../scripts/simulators/delegated-two-agent.mjs'

const contractId = '11111111-1111-4111-8111-111111111111'
const acceptanceId = '22222222-2222-4222-8222-222222222222'
const grantId = '33333333-3333-4333-8333-333333333333'
const eventId = '44444444-4444-4444-8444-444444444444'
const fixture = { contractId, acceptanceId, grantId }
const acceptance = { id: acceptanceId, type: 'dod.consent_recorded', canonical: { hash_version: 4 } }
const row = { id: eventId, type: 'performance.asserted', recorded_credential: 'entry_agent_grant',
  canonical: { hash_version: 5, credential_id: grantId, issuer_kind: 'owner_account' },
  integrity: { strict: { hash: 'match', link: 'linked', payload: 'match', agreement: 'match' } } }
const trail = (events, state) => ({ response_version: 2, contract: { id: contractId, state }, events,
  strict_verification: { server: { overall: 'verified', read_boundary: {
    start: 'first_event', tail: 'complete', recorded_count: events.length,
  } } } })
const finalTrail = trail([acceptance, row], 'AWAITING_CONFIRMATION')
const terms = { contract_id: contractId, project_name: 'agent bootstrap row8-001', currency: 'CAD',
  amount_minor: 125050, performed_by: 'creator', invited_hirer_email: 'agent-guest@example.invalid',
  dod: ['Deliver the agreed work'], deadline: '2026-12-05', earner_display_name: 'Bootstrap Owner' }

describe('delegated two-agent simulator', () => {
  it('requires an exact E2E origin, one fresh run and acknowledgement of the write budget', () => {
    const args = ['--run', 'row8-001', '--approve-budget=1/1/2', '--gate-open-confirmed']
    expect(parseRun(args, E2E_ORIGIN)).toBe('row8-001')
    for (const bad of [undefined, `${E2E_ORIGIN}/extra`, 'http://localhost:54321', 'https://production.supabase.co']) {
      expect(() => parseRun(args, bad)).toThrow('E2E')
    }
    expect(() => parseRun(args.slice(0, -1), E2E_ORIGIN)).toThrow('budget')
  })

  it('orders the guest acceptance, grant-only owner, and guest read and always revokes', async () => {
    const calls = []
    const step = name => async () => { calls.push(name) }
    await runFixture({ bootstrap: step('bootstrap'), accept: step('accept'), owner: step('owner'),
      read: step('read'), stopGuest: step('stop'), revoke: step('revoke') })
    expect(calls).toEqual(['bootstrap', 'accept', 'owner', 'read', 'stop', 'revoke'])
  })

  it('does not rerun an ambiguous accept or start the owner, and surfaces cleanup failure', async () => {
    const owner = vi.fn(), read = vi.fn(), stopGuest = vi.fn()
    const accept = vi.fn().mockRejectedValue(new Error('network body must stay private'))
    const revoke = vi.fn().mockRejectedValue(new Error('private cleanup diagnostic'))
    await expect(runFixture({ bootstrap: vi.fn(), accept, owner, read, stopGuest, revoke }))
      .rejects.toThrow('accept failed; revocation unverified')
    expect(accept).toHaveBeenCalledTimes(1)
    expect(owner).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(stopGuest).toHaveBeenCalledBefore(revoke)
  })

  it('requires a complete trail with precisely the accepted invitation and one bound v5 event', () => {
    expect(verifyGuestTrail(finalTrail, fixture)).toBe(eventId)
    expect(() => verifyGuestTrail({ ...finalTrail, events: [...finalTrail.events, row] }, fixture)).toThrow('write budget')
    expect(() => verifyGuestTrail({ ...finalTrail, events: [acceptance, { ...row, canonical: { ...row.canonical, credential_id: acceptanceId } }] }, fixture)).toThrow('authority')
  })

  it('keeps an exclusive reservation for the approved run ID', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tf-sim-test-'))
    try {
      expect(privateAttempt('row8-001', root)).toBe(path.join(root, 'row8-001'))
      expect(() => privateAttempt('row8-001', root)).toThrow('fresh simulator run directory')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('makes one digest-bound guest acceptance and reads v2 under the issued guest capability', async () => {
    const call = vi.fn().mockResolvedValueOnce({ status: 200, data: terms })
      .mockResolvedValueOnce({ status: 200, data: { contract_id: contractId, acceptance_event_id: acceptanceId, guest_access_token: eventId } })
      .mockResolvedValueOnce({ status: 200, data: trail([acceptance], 'TERMS_ACCEPTED') })
      .mockResolvedValueOnce({ status: 200, data: finalTrail })
    const accepted = vi.fn().mockResolvedValue(grantId)
    await expect(guestFixture({ run: 'row8-001', expectedDeal: contractId, inviteToken: acceptanceId, call, accepted })).resolves.toBe(eventId)
    expect(call).toHaveBeenCalledTimes(4)
    expect(call.mock.calls[0]).toEqual(['validate-invite-token', { body: { invite_token: acceptanceId } }])
    expect(call.mock.calls[1][1].body).toMatchObject({ accept: true, shown_terms_version: 2, shown_terms_digest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(call.mock.calls.slice(2)).toEqual(Array(2).fill(['guest-contract-events?response_version=2', { guestToken: eventId }]))
    expect(accepted).toHaveBeenCalledExactlyOnceWith({ contractId })
  })

  it('refuses a substituted invite before sending acceptance', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, data: { ...terms, contract_id: eventId } })
    const accepted = vi.fn()
    await expect(guestFixture({ run: 'row8-001', expectedDeal: contractId, inviteToken: acceptanceId, call, accepted }))
      .rejects.toThrow('not for this fresh fixture')
    expect(call).toHaveBeenCalledTimes(1)
    expect(accepted).not.toHaveBeenCalled()
  })

  it('permits one fresh owner append and one matching replay only after the delegated read', async () => {
    const transport = { read: vi.fn().mockResolvedValue({ status: 200 }), append: vi.fn()
      .mockResolvedValueOnce({ status: 201, json: { event: { id: eventId }, deduplicated: false } })
      .mockResolvedValueOnce({ status: 200, json: { event: { id: eventId }, deduplicated: true } }) }
    const op = { contractId, type: 'performance.asserted', idempotencyKey: 'bot-row8-001-performance-asserted', payload: {} }
    const bounded = budgetedOwner(transport, contractId, op.idempotencyKey)
    await expect(bounded.append(op)).rejects.toThrow('owner write budget')
    await bounded.read({ contractId })
    await bounded.append(op)
    await expect(bounded.append({ ...op, idempotencyKey: 'other' })).rejects.toThrow('owner write budget')
    await bounded.append({ ...op })
    await expect(bounded.append(op)).rejects.toThrow('owner write budget')
    expect(transport.append).toHaveBeenCalledTimes(2)
  })

  it('stops before append on failed read and permits no replay after an unconfirmed append', async () => {
    const op = { contractId, type: 'performance.asserted', idempotencyKey: 'bot-row8-001-performance-asserted', payload: {} }
    const transport = { read: vi.fn().mockResolvedValueOnce({ status: 403 }).mockResolvedValueOnce({ status: 200 }),
      append: vi.fn().mockRejectedValue(new Error('missing response')) }
    const failed = budgetedOwner(transport, contractId, op.idempotencyKey)
    await expect(failed.read({ contractId })).rejects.toThrow('owner read failed')
    await expect(failed.append(op)).rejects.toThrow('owner write budget')
    const ambiguous = budgetedOwner(transport, contractId, op.idempotencyKey)
    await ambiguous.read({ contractId })
    await expect(ambiguous.append(op)).rejects.toThrow('missing response')
    await expect(ambiguous.append(op)).rejects.toThrow('owner write budget')
    expect(transport.append).toHaveBeenCalledTimes(1)
  })

  it('never treats ambiguous bootstrap cleanup (unknown issuance with empty grant list) as success', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tf-sim-ambig-'))
    chmodSync(dir, 0o700)
    try {
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        run: 'row8-ambig',
        phases: {
          created: { contract_id: contractId },
          issue_sent: { at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
          issue_unknown: { at: new Date().toISOString() },
        },
      }), { mode: 0o600 })
      const tf = {
        ownerSession: async () => ({ token: 'tok', userId: 'u' }),
        invoke: vi.fn().mockResolvedValue({ status: 200, data: { grants: [] } }),
      }
      await expect(runFixture({
        bootstrap: vi.fn().mockRejectedValue(new Error('operator step failed')),
        accept: vi.fn(),
        owner: vi.fn(),
        read: vi.fn(),
        stopGuest: vi.fn(),
        async revoke() {
          const r = await runRevoke({ run: 'row8-ambig', dir, deps: { tf } })
          if (r.problems.length) throw new Error('operator step failed')
        },
      })).rejects.toThrow('bootstrap failed; revocation unverified')
      expect(tf.invoke).toHaveBeenCalledTimes(1)
      expect(tf.invoke.mock.calls[0][1].body.action).toBe('list')

      // Gateway 503 (http_503) persisted as issue_refused must also remain unverified.
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        run: 'row8-ambig',
        phases: {
          created: { contract_id: contractId },
          issue_sent: { at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
          issue_refused: { status: 503, error: 'http_503' },
        },
      }), { mode: 0o600 })
      await expect(runFixture({
        bootstrap: vi.fn().mockRejectedValue(new Error('operator step failed')),
        accept: vi.fn(),
        owner: vi.fn(),
        read: vi.fn(),
        stopGuest: vi.fn(),
        async revoke() {
          const r = await runRevoke({ run: 'row8-ambig', dir, deps: { tf } })
          if (r.problems.length) throw new Error('operator step failed')
        },
      })).rejects.toThrow('bootstrap failed; revocation unverified')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
