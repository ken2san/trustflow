import { describe, it, expect, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('../../src/lib/supabase.js', () => ({ supabase: { rpc: (...args) => rpc(...args), auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) } } }))
vi.mock('../../src/lib/guestSession.js', () => ({ getGuestAccessToken: vi.fn(() => null) }))
const { createContract } = await import('../../src/lib/contracts.js')

describe('createContract RPC', () => {
  it('returns the server-created contract and never submits an owner', async () => {
    const contract = { id: 'id', invite_token: 'invite' }
    rpc.mockResolvedValueOnce({ data: { status: 'created', contract }, error: null })
    const result = await createContract({ projectName: 'Work', dod: ['Done'], amountMinor: 1, invitedHirerEmail: 'a@example.test' })
    expect(result).toEqual({ contract, error: null })
    expect(rpc).toHaveBeenCalledWith('create_entry_contract', expect.not.objectContaining({ earner_user_id: expect.anything() }))
  })
})
