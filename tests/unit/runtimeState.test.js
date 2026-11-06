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
  saveRuntimeSnapshot, loadRuntimeSnapshot, RESTORABLE_VIEWS, restorableView,
  filterToShape,
} = await import('../../src/lib/runtimeState.js')

// The live shape has been flat since 2026-11-05: `uiProfile`'s counters and
// `step` lost their last writer when the reputation layer and the five-step
// flow were removed, so the table was being posted constants. The per-leaf
// descent stays in the module — a flat list of top-level names is the exact
// defect this file exists for — and these shapes keep it covered while nothing
// nested is declared. Each is local to a test, never the module's own.
const NESTED_SHAPE = { profile: { level: 'number', note: 'string' } }

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
  it('sends no profile object at all, now that nothing in the app writes one', async () => {
    await saveRuntimeSnapshot(FULL_STATE, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(sent).not.toHaveProperty('uiProfile')
    expect(sent).not.toHaveProperty('internalProfile')
    expect(sent).not.toHaveProperty('step')
    // Including every nested field the first allowlist would have admitted.
    for (const value of ['badActorFlags', 'location', 'feedbackComments',
      'networkGraph', 'recentHistory']) {
      expect(JSON.stringify(sent), value).not.toContain(value)
    }
    expect(CLOUD_SAFE_KEYS).not.toContain('uiProfile')
    expect(CLOUD_SAFE_KEYS).not.toContain('internalProfile')
  })

  it('keeps only the declared leaves of a nested object, when one is declared', () => {
    // The guarantee the module is built on, exercised through the shape
    // parameter because the live shape declares nothing nested today. Without
    // this the descent would be untested and re-adding a nested field would
    // inherit a top-level allowlist by accident.
    const kept = filterToShape(
      { profile: { level: 3, note: 'ok', partnerId: 'partner@example.test',
        nested: { email: 'deeper@example.test' } } },
      NESTED_SHAPE)

    expect(kept).toEqual({ profile: { level: 3, note: 'ok' } })
    expect(JSON.stringify(kept)).not.toContain('partner@example.test')
    expect(JSON.stringify(kept)).not.toContain('deeper@example.test')
  })

  it('drops a field added to a declared object later, at any depth', () => {
    const kept = filterToShape(
      { profile: { level: 1, lastPartner: { email: 'future@example.test', rating: 1 },
        disputeNotes: 'they never replied' } },
      NESTED_SHAPE)

    expect(JSON.stringify(kept)).not.toContain('future@example.test')
    expect(JSON.stringify(kept)).not.toContain('lastPartner')
    expect(JSON.stringify(kept)).not.toContain('disputeNotes')
  })

  it('refuses a structure smuggled into a scalar slot', async () => {
    // `mode` and `hasOnboarded` are declared scalars. An object or an array
    // arriving in one is dropped, not stringified and not passed through.
    await saveRuntimeSnapshot({
      hasOnboarded: ['leak@example.test'],
      mode: { note: 'leak@example.test' },
      view: 'home',
    }, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(JSON.stringify(sent)).not.toContain('leak@example.test')
    expect(sent).not.toHaveProperty('mode')
    expect(sent).not.toHaveProperty('hasOnboarded')
    expect(sent.view).toBe('home')
    // And the same at depth.
    expect(filterToShape({ profile: { level: { x: 1 }, note: ['a'] } }, NESTED_SHAPE))
      .toBeUndefined()
  })

  it('never reads a key the shape does not name, including __proto__', async () => {
    // The shape is iterated, not the input, so a crafted key is unreachable
    // rather than merely unlisted.
    const crafted = JSON.parse(
      '{"mode":"earner","__proto__":{"polluted":"leak@example.test"},' +
      '"constructor":{"x":1}}')
    await saveRuntimeSnapshot(crafted, 'actor-1')
    const sent = insert.mock.calls.at(-1)[0].payload

    expect(JSON.stringify(sent)).not.toContain('leak@example.test')
    expect(sent).not.toHaveProperty('constructor')
    expect(Object.keys(sent).sort()).toEqual(['mode', 'savedAt'])
    expect({}.polluted).toBeUndefined()
    // At depth too, where the declared object is descended into.
    const nested = filterToShape(
      JSON.parse('{"profile":{"level":1,"__proto__":{"y":"leak@example.test"}}}'),
      NESTED_SHAPE)
    expect(nested).toEqual({ profile: { level: 1 } })
  })

  it('omits an object that kept nothing, rather than sending an empty one', () => {
    // So a filtered-away branch cannot be mistaken for one that was empty.
    expect(filterToShape({ profile: { partnerId: 'partner@example.test' } }, NESTED_SHAPE))
      .toBeUndefined()
    expect(cloudSafeSubset({ uiProfile: { location: 'Toronto, ON' } })).toEqual({})
    expect(cloudSafeSubset({ internalProfile: FULL_STATE.internalProfile })).toEqual({})
  })

  it('rejects a value of the wrong type rather than coercing it', () => {
    // JSON cannot carry NaN or Infinity, but a caller in-process can. The
    // number check needs a declared number, and the live shape has none since
    // `step` left — so it is exercised through a shape, not through a key that
    // would be dropped for being undeclared and pass for the wrong reason.
    for (const bad of [NaN, Infinity, '3', null]) {
      expect(filterToShape({ profile: { level: bad, note: 'ok' } }, NESTED_SHAPE))
        .toEqual({ profile: { note: 'ok' } })
    }
    expect(cloudSafeSubset({ hasOnboarded: 'yes' })).toEqual({})
    expect(cloudSafeSubset({ mode: 7 })).toEqual({})
  })
})

describe('restoring a legacy row', () => {
  // Every row in the table predates the flat shape, so this is the live case
  // and not a historical one.
  const LEGACY_ROW = {
    hasOnboarded: true,
    mode: 'hirer',
    step: 4,
    uiProfile: { level: 7, points: 400, location: 'Toronto, ON', badActorFlags: ['flagged@example.test'] },
    internalProfile: FULL_STATE.internalProfile,
    selectedItem: { id: 'c-9', hirer_email: 'counterparty@example.test' },
  }

  it('does not rehydrate anything the shape no longer declares', async () => {
    limit.mockResolvedValueOnce({ data: [{ payload: LEGACY_ROW, created_at: 'x' }], error: null })
    const restored = await loadRuntimeSnapshot('actor-1')

    expect(restored.internalProfile).toBeUndefined()
    expect(restored.uiProfile).toBeUndefined()
    expect(restored.step).toBeUndefined()
    expect(JSON.stringify(restored)).not.toContain('partner@example.test')
    expect(JSON.stringify(restored)).not.toContain('flagged@example.test')
    expect(JSON.stringify(restored)).not.toContain('Toronto, ON')
    // What it legitimately restores still arrives.
    expect(restored.mode).toBe('hirer')
    expect(restored.hasOnboarded).toBe(true)
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

  it('leaves this device\'s own state alone, including a profile object', async () => {
    // The regression a shallow merge would have caused when the shape was
    // nested: a cross-device restore deleting local-only fields. Losing user
    // data while claiming to protect it would be the worst available outcome.
    localStore.tf_runtime_snapshot_v1 = JSON.stringify(FULL_STATE)
    limit.mockResolvedValueOnce({
      data: [{ payload: { mode: 'hirer', view: 'home' }, created_at: 'x' }], error: null,
    })

    const restored = await loadRuntimeSnapshot('actor-1')
    expect(restored.uiProfile).toEqual(FULL_STATE.uiProfile)   // untouched locally
    expect(restored.byocForm.clientEmail).toBe('about.to.invite@example.test')
    expect(restored.mode).toBe('hirer')                        // server's value wins
  })

  it('merges only declared leaves, so a legacy nested key cannot ride along', () => {
    // Asserted through the shape parameter: the merge must not become a second
    // way in when a nested field is declared again.
    const merged = mergeRemoteOverLocal(
      { profile: { level: 1, badges: ['early'] } },
      { profile: { level: 2, badActorFlags: ['flagged@example.test'] } },
      NESTED_SHAPE)

    expect(merged.profile.level).toBe(2)
    expect(merged.profile).not.toHaveProperty('badActorFlags')
    expect(merged.profile.badges).toEqual(['early'])
  })
})

describe('which view a restored snapshot may land on', () => {
  it('restores the home screen', () => {
    expect(restorableView('home')).toBe('home')
  })

  it('no longer restores the wallet, the one legacy screen a reload could land on', () => {
    // 'wallet' was restorable until 2026-11-05 because it needed nothing the
    // snapshot did not carry. That made it an entry into the reputation layer
    // that removing a button could not close: a stored snapshot would keep
    // reopening it. The layer is being removed (Decisions.md), so it is out.
    expect(restorableView('wallet')).toBe('home')
  })

  it('does not return the user to the legacy marketplace or command center', () => {
    expect(restorableView('marketplace')).toBe('home')
    expect(restorableView('command-center')).toBe('home')
  })

  it('does not restore a view whose backing state the snapshot never carries', () => {
    // 'agreement' showed "Loading the agreement…" for ever when restored
    // (2026-09-28, live). 'scoping' and 'contract' need selectedItem, which is
    // local-cache-only; 'project-detail' needs projectDetail, which is not
    // persisted at all — so a second device restores a blank screen.
    for (const view of ['agreement', 'guest-evidence', 'scoping', 'contract',
      'project-detail', 'negotiation-chat']) {
      expect(restorableView(view)).toBe('home')
    }
  })

  it('falls back to home for a missing, malformed or unknown view', () => {
    expect(restorableView(undefined)).toBe('home')
    expect(restorableView(null)).toBe('home')
    expect(restorableView(42)).toBe('home')
    expect(restorableView('a-view-added-after-this-test-was-written')).toBe('home')
  })

  it('allowlists, so a view added to App.jsx is not restorable by default', () => {
    // The point of the shape above, applied to the view name: a denylist would
    // admit whatever is added next without anyone having to decide.
    expect([...RESTORABLE_VIEWS].sort()).toEqual(['home'])
  })

  it('keeps view in the cloud-safe shape — this is about which values, not whether', () => {
    expect(CLOUD_SAFE_SHAPE.view).toBe('string')
    expect(cloudSafeSubset({ view: 'marketplace' })).toEqual({ view: 'marketplace' })
  })
})
