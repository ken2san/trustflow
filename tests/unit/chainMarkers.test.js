import { describe, it, expect, vi } from 'vitest'

// Why this file exists, separately from contracts.test.js: the home screen's
// "since when" is only as good as the wiring that fetches the stamps, and the
// pure derivation tests in contractStatus.test.js cannot see that wiring at
// all. Codex pointed out (2026-11-08) that dropping `dod.consent_recorded`
// from the events filter, or mis-keying the acceptance Map, would leave every
// one of those tests green while every accepted agreement lost its date.
//
// So these call the real listContracts() and inspect what it asks the server
// for and what it returns — the same shape of test, and for the same reason,
// as contracts.test.js.

const calls = { contractsSelect: null, eventTypes: null }

function eventsQuery(rows) {
  const q = {
    select: () => q,
    in: (column, values) => {
      if (column === 'type') calls.eventTypes = values
      return q
    },
    order: () => Promise.resolve({ data: rows, error: null }),
  }
  return q
}

let EVENTS = []
let CONTRACTS = []

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: table => (table === 'events' ? eventsQuery(EVENTS) : {
      select: columns => {
        calls.contractsSelect = columns
        return { order: () => Promise.resolve({ data: CONTRACTS, error: null }) }
      },
    }),
  },
  invokeErrorReason: async () => null,
}))
vi.mock('../../src/lib/guestSession.js', () => ({ getGuestAccessToken: vi.fn(() => null) }))

const { listContracts } = await import('../../src/lib/contracts.js')

describe('listContracts loads the stamps the home screen needs', () => {
  it('asks for the counterparty access expiry, which nothing used to request', () => {
    CONTRACTS = [{ id: 'c1' }]
    EVENTS = []
    return listContracts().then(() => {
      expect(calls.contractsSelect).toContain('guest_access_token_expires_at')
      // And still the ones it always needed, so this is additive.
      expect(calls.contractsSelect).toContain('created_at')
      expect(calls.contractsSelect).toContain('invite_token_expires_at')
    })
  })

  it('asks for the acceptance event as well as the performance ones', async () => {
    CONTRACTS = [{ id: 'c1' }]
    EVENTS = []
    await listContracts()
    expect(calls.eventTypes).toEqual([
      'performance.asserted', 'performance.accepted', 'performance.rejected',
      'dod.consent_recorded',
    ])
  })

  it('keeps the acceptance stamp out of last_performance_*', async () => {
    CONTRACTS = [{ id: 'c1' }]
    // Newest first, the order the query asks for.
    EVENTS = [
      { contract_id: 'c1', type: 'performance.asserted', created_at: '2026-09-20T00:00:00Z' },
      { contract_id: 'c1', type: 'dod.consent_recorded', created_at: '2026-09-10T00:00:00Z' },
    ]
    const { contracts } = await listContracts()
    expect(contracts[0]).toMatchObject({
      last_performance_type: 'performance.asserted',
      last_performance_at: '2026-09-20T00:00:00Z',
      accepted_at: '2026-09-10T00:00:00Z',
    })
  })

  it('does not let an acceptance masquerade as the latest performance statement', async () => {
    CONTRACTS = [{ id: 'c1' }]
    // An agreement accepted and not yet delivered: the only event is the
    // acceptance. Folding the two fields together would make this read as a
    // performance statement, and the home screen decides what to say from it.
    EVENTS = [{ contract_id: 'c1', type: 'dod.consent_recorded', created_at: '2026-09-10T00:00:00Z' }]
    const { contracts } = await listContracts()
    expect(contracts[0].last_performance_type).toBeNull()
    expect(contracts[0].last_performance_at).toBeNull()
    expect(contracts[0].accepted_at).toBe('2026-09-10T00:00:00Z')
  })

  it('leaves every stamp null when there are no events, rather than guessing', async () => {
    CONTRACTS = [{ id: 'c1' }]
    EVENTS = []
    const { contracts } = await listContracts()
    expect(contracts[0]).toMatchObject({
      last_performance_type: null, last_performance_at: null, accepted_at: null,
    })
  })

  it('keeps each agreement’s stamps to itself', async () => {
    CONTRACTS = [{ id: 'c1' }, { id: 'c2' }]
    EVENTS = [{ contract_id: 'c2', type: 'dod.consent_recorded', created_at: '2026-09-11T00:00:00Z' }]
    const { contracts } = await listContracts()
    expect(contracts.find(c => c.id === 'c1').accepted_at).toBeNull()
    expect(contracts.find(c => c.id === 'c2').accepted_at).toBe('2026-09-11T00:00:00Z')
  })
})
