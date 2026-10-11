import { describe, it, expect, vi, beforeEach } from 'vitest'

// The table this module writes to has no evidence value, no retention bound
// and one reader. What it did have was 225 production rows carrying a
// counterparty's email address. These tests are the boundary that keeps it out.

const insert = vi.fn(() => ({ error: null }))
const limit = vi.fn()

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    from: () => ({
      insert: (...args) => insert(...args),
      select: () => ({ eq: () => ({ order: () => ({ limit: (...a) => limit(...a) }) }) }),
    }),
  },
}))
vi.mock('../../src/lib/identity.js', () => ({ getDeviceId: () => 'device-1' }))

const {
  CLOUD_SAFE_KEYS, cloudSafeSubset, saveRuntimeSnapshot, loadRuntimeSnapshot,
} = await import('../../src/lib/runtimeState.js')

// The real UI state object, with every key App.jsx actually saves.
const FULL_STATE = {
  hasOnboarded: true,
  mode: 'earner',
  view: 'home',
  step: 2,
  uiProfile: { level: 3, points: 120 },
  internalProfile: { completedContracts: 2 },
  selectedItem: { id: 'c-1', hirer_email: 'counterparty@example.test' },
  byocForm: { clientEmail: 'about.to.invite@example.test', amount: 50000 },
  contractHistory: [{ id: 'c-0', counterparty: 'previous@example.test' }],
  activityLog: [{ timestamp: '2026-10-01T00:00:00.000Z', text: 'accepted' }],
  badActorFlags: ['someone@example.test'],
  acceptanceProtocol: ['read the dod'],
}

const PERSONAL_DATA = [
  'counterparty@example.test', 'about.to.invite@example.test',
  'previous@example.test', 'someone@example.test',
]

const localStore = {}
beforeEach(() => {
  insert.mockClear()
  limit.mockReset()
  for (const k of Object.keys(localStore)) delete localStore[k]
  globalThis.localStorage = {
    getItem: (k) => localStore[k] ?? null,
    setItem: (k, v) => { localStore[k] = v },
  }
})

describe('what may leave the browser', () => {
  it('sends only allowlisted keys', async () => {
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(Object.keys(sent).sort()).toEqual([...CLOUD_SAFE_KEYS].sort())
  })

  it('sends no personal data at all', async () => {
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const serialized = JSON.stringify(insert.mock.calls.at(-1)[0].payload)

    for (const value of PERSONAL_DATA) {
      expect(serialized).not.toContain(value)
    }
    for (const key of ['selectedItem', 'byocForm', 'contractHistory',
      'activityLog', 'badActorFlags', 'acceptanceProtocol']) {
      expect(serialized).not.toContain(key)
    }
  })

  it('drops a key added to the state object later, rather than passing it on', async () => {
    // The allowlist's whole purpose: this state grows, and the next key added
    // must not reach the server because nobody remembered to exclude it.
    await saveRuntimeSnapshot(
      { ...FULL_STATE, somethingNew: { email: 'future@example.test' } }, 'actor-1')
    const serialized = JSON.stringify(insert.mock.calls.at(-1)[0].payload)

    expect(serialized).not.toContain('somethingNew')
    expect(serialized).not.toContain('future@example.test')
  })

  it('still keeps the whole state locally, where it never left the device', async () => {
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const cached = JSON.parse(localStore.tf_runtime_snapshot_v1)

    expect(cached.byocForm.clientEmail).toBe('about.to.invite@example.test')
    expect(cached.selectedItem.id).toBe('c-1')
    expect(cached.savedAt).toBeTruthy()
  })
})

describe('what comes back from the server', () => {
  it('filters a legacy row rather than rehydrating the data in it', async () => {
    // A row written before the allowlist. Returning its personal data would
    // put it back into the app — and back into the table on the next save.
    limit.mockResolvedValueOnce({
      data: [{ payload: { ...FULL_STATE, savedAt: '2026-10-01T00:00:00.000Z' }, created_at: 'x' }],
      error: null,
    })

    const restored = await loadRuntimeSnapshot('actor-1')
    expect(restored.byocForm).toBeUndefined()
    expect(restored.badActorFlags).toBeUndefined()
    expect(JSON.stringify(restored)).not.toContain('about.to.invite@example.test')
    // What it legitimately does restore still arrives.
    expect(restored.mode).toBe('earner')
    expect(restored.hasOnboarded).toBe(true)
  })

  it('does not resend legacy personal data on the save that follows a restore', async () => {
    // The round trip, end to end: this is the property that stripping only on
    // write would have missed.
    limit.mockResolvedValueOnce({
      data: [{ payload: FULL_STATE, created_at: 'x' }], error: null,
    })
    const restored = await loadRuntimeSnapshot('actor-1')
    await saveRuntimeSnapshot(restored, 'actor-1')

    const serialized = JSON.stringify(insert.mock.calls.at(-1)[0].payload)
    for (const value of PERSONAL_DATA) {
      expect(serialized).not.toContain(value)
    }
  })

  it('keeps this device\'s own state for the keys the server no longer holds', async () => {
    // The UX this protects: a reload must not wipe the draft form just because
    // the server is not allowed to know about it.
    localStore.tf_runtime_snapshot_v1 = JSON.stringify(FULL_STATE)
    limit.mockResolvedValueOnce({
      data: [{ payload: { hasOnboarded: true, mode: 'hirer', view: 'home', step: 1 }, created_at: 'x' }],
      error: null,
    })

    const restored = await loadRuntimeSnapshot('actor-1')
    expect(restored.byocForm.clientEmail).toBe('about.to.invite@example.test')
    expect(restored.selectedItem.id).toBe('c-1')
    // The server's value wins for a key it does carry.
    expect(restored.mode).toBe('hirer')
  })

  it('falls back to the local cache when the server has nothing', async () => {
    localStore.tf_runtime_snapshot_v1 = JSON.stringify(FULL_STATE)
    limit.mockResolvedValueOnce({ data: [], error: null })

    expect((await loadRuntimeSnapshot('actor-1')).selectedItem.id).toBe('c-1')
  })

  it('falls back to the local cache when the read fails', async () => {
    localStore.tf_runtime_snapshot_v1 = JSON.stringify(FULL_STATE)
    limit.mockResolvedValueOnce({ data: null, error: { message: 'nope' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await loadRuntimeSnapshot('actor-1')).mode).toBe('earner')
    warn.mockRestore()
  })
})

describe('cloudSafeSubset', () => {
  it('survives a snapshot that is not an object', () => {
    for (const bad of [null, undefined, 'string', 7]) {
      expect(cloudSafeSubset(bad)).toEqual({})
    }
  })

  it('omits an allowlisted key that is absent rather than nulling it', () => {
    expect(cloudSafeSubset({ mode: 'earner' })).toEqual({ mode: 'earner' })
  })

  it('allowlists nothing that names another person', () => {
    // A guard on the list itself, so a future edit has to argue with a test.
    for (const key of CLOUD_SAFE_KEYS) {
      expect(['selectedItem', 'byocForm', 'contractHistory', 'activityLog',
        'badActorFlags']).not.toContain(key)
    }
  })
})
