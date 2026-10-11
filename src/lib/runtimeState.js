// src/lib/runtimeState.js
// Per-actor application state, cached in localStorage and — for a deliberately
// small subset of it — mirrored to the runtime_snapshots table for cross-device
// restore.
//
// These snapshots used to live in `events` as type 'runtime.snapshot' — 94% of
// that table — with contract_id set to the literal 'runtime'. They are
// application state, not contractual evidence: no dod_hash, no event_hash, no
// TSA token, and actor_id is often a localStorage device UUID rather than an
// authenticated identity. Keeping them there forced the events read policy to
// carve out a type exception. They now have their own table with a plain
// owner-only policy (20260924000000).
//
// WHAT THIS TABLE WAS BEING SENT, AND WHY IT STOPPED
// The snapshot was the whole UI state object, posted on a 900ms debounce every
// time any of it changed. That included the selected agreement (with the
// counterparty's address in it), the draft agreement form, the local contract
// history, and a list of flags one user had raised about other people.
// Measured on production: 1157 rows across 168 actors, 225 of them carrying a
// counterparty email — in a table with no evidence value, no retention bound,
// and no reader beyond "restore the view you were on".
//
// That is a bad trade in both directions. The personal data earns nothing, and
// what it buys — resuming mid-wizard on a second device — nobody has asked
// for. So an allowlist now decides what may leave the browser; everything else
// stays in localStorage, where it already was.
//
// Three properties this has to hold, each with a test:
//   1. Nothing outside CLOUD_SAFE_KEYS is sent, however the caller assembles
//      the snapshot. An allowlist, not a denylist: this state object grows,
//      and a denylist leaks whatever is added to it next.
//   2. A snapshot read back from the server is filtered on the way IN as well.
//      Rows written before this change still hold the old keys, and
//      rehydrating them would put that data back into the app — and, on the
//      next debounce, back into the table. Stripping only on write would not
//      have stopped the resend, it would have made it slower.
//   3. Stored rows are left exactly as they are. Deleting them is a separate
//      decision with its own approval, and nothing here touches one.

import { supabase } from './supabase.js'
import { getDeviceId } from './identity.js'

const LOCAL_SNAPSHOT_KEY = 'tf_runtime_snapshot_v1'

/**
 * The only keys that may be written to, or read from, the server.
 *
 * The test applied to each: does restoring it on a second device do something
 * useful, AND does it describe nobody but the account holder? Everything that
 * failed either half stayed local.
 *
 * Deliberately excluded, with the reason:
 *   selectedItem      — the open agreement, counterparty address included.
 *                       Restoring it cross-device is also pointless: the views
 *                       that render an agreement are refused by the hydrate
 *                       path anyway, because the data behind them is fetched,
 *                       not stored here.
 *   byocForm          — a draft agreement, including the address being invited.
 *   contractHistory   — past counterparties.
 *   activityLog       — a timeline of who did what, and when.
 *   badActorFlags     — one user's assertions about other people. This is the
 *                       single worst thing in the list to sync and keep
 *                       indefinitely, and it was in there.
 *   acceptanceProtocol — local workflow preferences; harmless and useless to
 *                       sync, so it stays out by the same rule.
 */
export const CLOUD_SAFE_KEYS = [
  'hasOnboarded',
  'mode',
  'view',
  'step',
  // Mock gamification counters. No personal data, and not evidence of
  // anything — see the Trust Ladder note in Roadmap.md.
  'uiProfile',
  'internalProfile',
  'savedAt',
]

/** Keep only the allowlisted keys. Used on the way out AND on the way back. */
export function cloudSafeSubset(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {}
  const out = {}
  for (const key of CLOUD_SAFE_KEYS) {
    if (key in snapshot) out[key] = snapshot[key]
  }
  return out
}

function readLocalSnapshot() {
  try {
    const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeLocalSnapshot(snapshot) {
  try {
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore quota/storage errors in prototype mode.
  }
}

/**
 * Save runtime snapshot to Supabase (and local cache).
 * @param {object} snapshot - app state to persist
 * @param {string} [actorId] - auth uid or device id; falls back to getDeviceId()
 */
export async function saveRuntimeSnapshot(snapshot, actorId) {
  const resolvedActorId = actorId || getDeviceId()
  const enriched = {
    ...snapshot,
    savedAt: new Date().toISOString(),
  }

  // The local cache keeps everything: it never leaves the device, and it is
  // what actually makes a reload instant.
  writeLocalSnapshot(enriched)

  if (!supabase) return { source: 'local' }

  const { error } = await supabase.from('runtime_snapshots').insert({
    actor_id: resolvedActorId,
    payload: cloudSafeSubset(enriched),
  })

  if (error) {
    console.warn('[TrustFlow] runtime snapshot persist failed:', error.message)
    return { source: 'local', error }
  }

  return { source: 'supabase' }
}

/**
 * Load latest runtime snapshot from Supabase (or local cache).
 * @param {string} [actorId] - auth uid or device id; falls back to getDeviceId()
 */
export async function loadRuntimeSnapshot(actorId) {
  const local = readLocalSnapshot()
  if (!supabase) return local

  const resolvedActorId = actorId || getDeviceId()
  const { data, error } = await supabase
    .from('runtime_snapshots')
    .select('payload,created_at')
    .eq('actor_id', resolvedActorId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    console.warn('[TrustFlow] runtime snapshot load failed:', error.message)
    return local
  }

  // Filtered on the way in too. Rows written before the allowlist still carry
  // the old keys, and rehydrating them would reintroduce the data into the app
  // — and send it straight back on the next save. Anything the server is no
  // longer trusted to hold comes from the local cache instead.
  const remote = data && data.length > 0 ? cloudSafeSubset(data[0].payload) : null
  if (!remote) return local
  if (!local) return remote

  // Local first for the keys the server no longer carries, remote on top for
  // the ones it does: a second device gets what the server can legitimately
  // give it, and this device keeps the rest of its own state.
  return { ...local, ...remote }
}
