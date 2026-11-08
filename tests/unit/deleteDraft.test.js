import { describe, it, expect, vi } from 'vitest'

// One branch, and it is the one nobody will see by hand: a draft that was
// deletable when the button was drawn, and carries evidence by the time the
// delete reaches the row. The database refuses it under a lock
// (20261108130000, TF004); what is tested here is that the client reads that
// refusal as "it has evidence now" rather than as a fault to retry — because
// retrying it will rightly fail forever.

let response = { error: null, count: 1 }

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    from: () => ({
      delete: () => ({ eq: async () => response }),
    }),
  },
}))
vi.mock('../../src/lib/guestSession.js', () => ({ getGuestAccessToken: vi.fn(() => null) }))

const { deleteDraftContract } = await import('../../src/lib/contracts.js')

describe('deleteDraftContract', () => {
  it('reports the evidence refusal as a reason, not an error', async () => {
    response = { error: { code: 'TF004', message: 'contract … carries evidence' }, count: null }
    expect(await deleteDraftContract('c1')).toEqual({
      deleted: false, error: null, reason: 'has_evidence',
    })
  })

  it('still reports anything else as an error', async () => {
    const error = { code: '42501', message: 'permission denied' }
    response = { error, count: null }
    expect(await deleteDraftContract('c1')).toEqual({ deleted: false, error })
  })

  it('tells a refused delete from one that had nothing to remove', async () => {
    response = { error: null, count: 0 }
    expect(await deleteDraftContract('c1')).toEqual({ deleted: false, error: null, reason: null })
    response = { error: null, count: 1 }
    expect(await deleteDraftContract('c1')).toEqual({ deleted: true, error: null, reason: null })
  })
})
