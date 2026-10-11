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
  CLOUD_SAFE_KEYS, CLOUD_SAFE_SHAPE, cloudSafeSubset, mergeRemoteOverLocal,
  saveRuntimeSnapshot, loadRuntimeSnapshot,
} = await import('../../src/lib/runtimeState.js')

// The real UI state object, with every key App.jsx actually saves.
const FULL_STATE = {
  hasOnboarded: true,
  mode: 'earner',
  view: 'home',
  step: 2,
  // The real declared shapes, from src/lib/profileTypes.js. The first version
  // of the allowlist admitted both of these objects whole.
  uiProfile: {
    level: 3, points: 120, trustScore: 90, exp: 500, completedContracts: 2,
    avgRating: 4.5, totalEarned: 100000, totalSpent: 0,
    badges: ['early'], skillEndorsements: { translation: 2 },
    location: 'Toronto, ON', joinDate: '2026-01-01T00:00:00.000Z',
    verified: false, responseSpeed: 'N/A', repeatClients: 1,
    badActorFlags: ['flagged@example.test'],
  },
  internalProfile: {
    joinDate: '2026-01-01T00:00:00.000Z',
    lastActive: '2026-10-11T00:00:00.000Z',
    recentHistory: [{ partnerId: 'partner@example.test', feedback: 'late', value: 50000, rating: 2 }],
    feedbackComments: [{ comment: 'slow to reply', rating: 2, partnerId: 'partner@example.test' }],
    networkGraph: [{ id: 'partner@example.test', type: 'client' }],
    profileChangeLog: [{ field: 'location', oldValue: 'Vancouver', newValue: 'Toronto' }],
  },
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
  // Nested inside the two profile objects.
  'partner@example.test', 'flagged@example.test', 'slow to reply',
  'Toronto, ON', 'Vancouver',
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

// ── depth ───────────────────────────────────────────────────────────────────
// The defect these exist for: the first allowlist named top-level keys, so
// admitting `uiProfile` admitted `uiProfile.badActorFlags`, and admitting
// `internalProfile` admitted `feedbackComments[].partnerId`. Nothing populated
// those fields, so nothing leaked in fact — but the guarantee rested on a
// nested field staying empty, which is not a guarantee.

describe('nested fields', () => {
  it('sends only the declared leaves of an allowlisted object', async () => {
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(Object.keys(sent.uiProfile).sort())
      .toEqual(Object.keys(CLOUD_SAFE_SHAPE.uiProfile).sort())
    // The nine undeclared fields of the same object, named individually so a
    // failure says which one got through.
    for (const key of ['badActorFlags', 'location', 'badges', 'skillEndorsements',
      'joinDate', 'verified', 'responseSpeed', 'repeatClients']) {
      expect(sent.uiProfile, key).not.toHaveProperty(key)
    }
  })

  it('does not send internalProfile at all', async () => {
    // Nothing in the app ever writes it, so syncing it bought nothing in
    // exchange for feedbackComments, recentHistory and networkGraph.
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(sent).not.toHaveProperty('internalProfile')
    expect(CLOUD_SAFE_KEYS).not.toContain('internalProfile')
    expect(JSON.stringify(sent)).not.toContain('feedbackComments')
    expect(JSON.stringify(sent)).not.toContain('networkGraph')
  })

  it('drops a field added to a profile later, at any depth', async () => {
    await saveRuntimeSnapshot({
      ...FULL_STATE,
      uiProfile: {
        ...FULL_STATE.uiProfile,
        // Exactly the shape of the next feature to be written here.
        lastPartner: { email: 'future@example.test', rating: 1 },
        disputeNotes: 'they never replied',
      },
    }, 'actor-1')
    const serialized = JSON.stringify(insert.mock.calls.at(-1)[0].payload)

    expect(serialized).not.toContain('future@example.test')
    expect(serialized).not.toContain('lastPartner')
    expect(serialized).not.toContain('disputeNotes')
  })

  it('refuses a structure smuggled into a scalar slot', async () => {
    // `level` is declared a number. An object or an array arriving in it is
    // dropped, not stringified and not passed through.
    await saveRuntimeSnapshot({
      ...FULL_STATE,
      step: { note: 'leak@example.test' },
      uiProfile: {
        level: { toString: 'leak@example.test', email: 'leak@example.test' },
        points: ['leak@example.test'],
        trustScore: 90,
      },
    }, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(JSON.stringify(sent)).not.toContain('leak@example.test')
    expect(sent).not.toHaveProperty('step')
    expect(sent.uiProfile).toEqual({ trustScore: 90 })
  })

  it('never reads a key the shape does not name, including __proto__', async () => {
    // The shape is iterated, not the input, so a crafted key is unreachable
    // rather than merely unlisted.
    const crafted = JSON.parse(
      '{"mode":"earner","__proto__":{"polluted":"leak@example.test"},' +
      '"constructor":{"x":1},"uiProfile":{"level":1,"__proto__":{"y":2}}}')
    await saveRuntimeSnapshot(crafted, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(JSON.stringify(sent)).not.toContain('leak@example.test')
    expect(sent).not.toHaveProperty('constructor')
    expect(Object.keys(sent).sort()).toEqual(['mode', 'savedAt', 'uiProfile'])
    expect({}.polluted).toBeUndefined()
  })

  it('omits an object that kept nothing, rather than sending an empty one', () => {
    // So a filtered-away branch cannot be mistaken for one that was empty.
    expect(cloudSafeSubset({ uiProfile: { location: 'Toronto, ON' } })).toEqual({})
    expect(cloudSafeSubset({ internalProfile: FULL_STATE.internalProfile })).toEqual({})
  })

  it('rejects a non-finite number rather than coercing it', () => {
    // JSON cannot carry these, but a caller in-process can.
    expect(cloudSafeSubset({ step: NaN })).toEqual({})
    expect(cloudSafeSubset({ step: Infinity })).toEqual({})
    expect(cloudSafeSubset({ step: '3' })).toEqual({})
    expect(cloudSafeSubset({ hasOnboarded: 'yes' })).toEqual({})
  })
})

describe('restoring a legacy row with nested personal data', () => {
  const LEGACY_ROW = {
    hasOnboarded: true,
    mode: 'hirer',
    uiProfile: { level: 7, points: 400, location: 'Toronto, ON', badActorFlags: ['flagged@example.test'] },
    internalProfile: FULL_STATE.internalProfile,
    selectedItem: { id: 'c-9', hirer_email: 'counterparty@example.test' },
  }

  it('does not rehydrate the nested data into the app', async () => {
    limit.mockResolvedValueOnce({ data: [{ payload: LEGACY_ROW, created_at: 'x' }], error: null })
    const restored = await loadRuntimeSnapshot('actor-1')

    expect(restored.internalProfile).toBeUndefined()
    expect(restored.uiProfile).not.toHaveProperty('badActorFlags')
    expect(restored.uiProfile).not.toHaveProperty('location')
    expect(JSON.stringify(restored)).not.toContain('partner@example.test')
    expect(JSON.stringify(restored)).not.toContain('flagged@example.test')
    // What it legitimately restores still arrives.
    expect(restored.uiProfile.level).toBe(7)
    expect(restored.mode).toBe('hirer')
  })

  it('does not resend any of it on the save that follows', async () => {
    limit.mockResolvedValueOnce({ data: [{ payload: LEGACY_ROW, created_at: 'x' }], error: null })
    const restored = await loadRuntimeSnapshot('actor-1')
    await saveRuntimeSnapshot(restored, 'actor-1')
    const serialized = JSON.stringify(insert.mock.calls.at(-1)[0].payload)

    for (const value of ['partner@example.test', 'flagged@example.test',
      'Toronto, ON', 'counterparty@example.test', 'slow to reply']) {
      expect(serialized, value).not.toContain(value)
    }
  })

  it('keeps the local half of a profile the server no longer carries', async () => {
    // The regression a shallow merge would have caused: a cross-device restore
    // deleting the nine local-only fields of uiProfile. Losing user data while
    // claiming to protect it would be the worst available outcome.
    localStore.tf_runtime_snapshot_v1 = JSON.stringify(FULL_STATE)
    limit.mockResolvedValueOnce({
      data: [{ payload: { uiProfile: { level: 9, points: 999 } }, created_at: 'x' }], error: null,
    })

    const restored = await loadRuntimeSnapshot('actor-1')
    expect(restored.uiProfile.level).toBe(9)            // server's value wins
    expect(restored.uiProfile.badges).toEqual(['early']) // local survives
    expect(restored.uiProfile.location).toBe('Toronto, ON')
    expect(restored.byocForm.clientEmail).toBe('about.to.invite@example.test')
  })

  it('merges only declared leaves, so a legacy nested key cannot ride along', () => {
    const merged = mergeRemoteOverLocal(
      { uiProfile: { level: 1, badges: ['early'] } },
      // Already filtered, but assert the merge itself is not a second way in.
      { uiProfile: { level: 2, badActorFlags: ['flagged@example.test'] } })

    expect(merged.uiProfile.level).toBe(2)
    expect(merged.uiProfile).not.toHaveProperty('badActorFlags')
    expect(merged.uiProfile.badges).toEqual(['early'])
  })
})
