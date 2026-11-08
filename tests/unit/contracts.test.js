import { describe, it, expect, vi, beforeEach } from 'vitest'

// These tests exist because of a specific failure. The Evidence Core pass
// revoked the client's INSERT grant on contracts.dod_hash — correctly, since a
// party choosing the hash of its own terms defeats the point of pinning them.
// But createContract() kept sending the column, so every real creation started
// returning 403 while the E2E suite stayed green: every test there wrote its
// own insert body by hand instead of calling this function, so the application
// path had no coverage at all.
//
// The lesson is the shape of the test, not the assertion. These call the real
// exported function and inspect what it actually sends.

const insert = vi.fn()
const getUser = vi.fn()

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    auth: { getUser: (...a) => getUser(...a) },
    from: () => ({
      insert: (...a) => {
        insert(...a)
        return { select: () => ({ single: async () => ({ data: { id: 'c1' }, error: null }) }) }
      },
    }),
  },
}))
vi.mock('../../src/lib/guestSession.js', () => ({ getGuestAccessToken: vi.fn(() => null) }))

const { createContract } = await import('../../src/lib/contracts.js')

const base = {
  earnerDisplayName: 'Me',
  projectName: 'Translate a document',
  dod: ['translate the document', 'return a PDF'],
  amountMinor: 20000,
  deadline: '2026-11-30',
  invitedHirerEmail: 'translator@example.test',
}

beforeEach(() => {
  insert.mockReset()
  getUser.mockReset()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
})

const sentRow = () => insert.mock.calls.at(-1)[0]

describe('createContract', () => {
  it('does not send dod_hash — the column the client may not write', async () => {
    // The exact regression: sending it makes the whole insert 403, because the
    // grant was revoked so that terms and terms-hash cannot disagree.
    await createContract(base)
    expect(sentRow()).not.toHaveProperty('dod_hash')
  })

  it('sends only columns the client is granted', async () => {
    await createContract(base)
    // Everything else on contracts is server-owned: state, invite_token and its
    // expiry, the guest credential, hirer_email, and every settlement column.
    expect(Object.keys(sentRow()).sort()).toEqual([
      // amount_jpy is sent as well as amount_minor, and only for JPY: it is
      // the transitional mirror an Edge Function deployed before 2026-11-08
      // still reads, and a database CHECK requires the two to be equal.
      'amount_jpy', 'amount_minor', 'currency', 'deadline', 'dod',
      'earner_display_name', 'earner_user_id', 'invited_hirer_email',
      'performed_by', 'project_name',
    ])
  })

  it('writes the amount in minor units, defaulting to JPY', async () => {
    await createContract(base)
    expect(sentRow().amount_minor).toBe(20000)
    expect(sentRow().currency).toBe('JPY')
    expect(sentRow().amount_jpy).toBe(20000)
  })

  it('omits amount_jpy entirely for a currency that is not yen', async () => {
    // 1250 in a column called amount_jpy would be read as ¥1,250 by anything
    // that trusts the name — a hundredfold error on a CA$12.50 agreement. The
    // database refuses the combination; this is the writer not attempting it.
    await createContract({ ...base, amountMinor: 1250, currency: 'CAD' })
    expect(sentRow()).not.toHaveProperty('amount_jpy')
    expect(sentRow().amount_minor).toBe(1250)
    expect(sentRow().currency).toBe('CAD')
  })

  it('refuses a currency the product does not record, before the database does', async () => {
    const { contract, error } = await createContract({ ...base, currency: 'CHF' })
    expect(contract).toBeNull()
    expect(error?.message).toBe('currency_unsupported')
    expect(insert).not.toHaveBeenCalled()
  })

  it('records who is doing the work', async () => {
    await createContract({ ...base, performedBy: 'counterparty' })
    expect(sentRow().performed_by).toBe('counterparty')
  })

  it('defaults to the creator performing, preserving the original behaviour', async () => {
    await createContract(base)
    expect(sentRow().performed_by).toBe('creator')
  })

  it('never lets a caller invent a third role', async () => {
    // A check constraint rejects anything else server-side; this keeps a typo
    // from reaching it in the first place.
    await createContract({ ...base, performedBy: 'somebody-else' })
    expect(['creator', 'counterparty']).toContain(sentRow().performed_by)
  })

  it('attributes the row to the signed-in account, not to anything passed in', async () => {
    await createContract({ ...base, earnerUserId: 'someone-else' })
    expect(sentRow().earner_user_id).toBe('user-1')
  })

  it('refuses to build a row when nobody is signed in', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const { contract, error } = await createContract(base)
    expect(contract).toBeNull()
    expect(error).toBeTruthy()
    expect(insert).not.toHaveBeenCalled()
  })
})
