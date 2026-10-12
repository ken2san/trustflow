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
//   1. Nothing the shape does not declare is sent, AT ANY DEPTH, however the
//      caller assembles the snapshot. An allowlist, not a denylist: this state
//      object grows, and a denylist leaks whatever is added to it next. The
//      first attempt at this allowlisted top-level keys only, which admitted
//      two whole profile objects whose nested fields describe other people —
//      see CLOUD_SAFE_SHAPE for what that would have cost.
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
 * The ONLY values that may be written to, or read from, the server — declared
 * all the way down to the leaf.
 *
 * WHY A SHAPE AND NOT A LIST OF KEYS
 * The first version of this was a flat list of top-level key names, and it was
 * wrong in a way worth recording. `uiProfile` and `internalProfile` were on it,
 * described in a comment as "mock gamification counters, no personal data" —
 * which was a claim about the names, not about the objects. Their declared
 * shapes (src/lib/profileTypes.js) are:
 *
 *   internalProfile.feedbackComments[] — { comment, rating, partnerId }
 *   internalProfile.recentHistory[]    — { partnerId, feedback, value, … }
 *   internalProfile.networkGraph[]     — { id, type, connectedAt }
 *   uiProfile.badActorFlags[]          — flags raised about other people
 *   uiProfile.location                 — free text, entered by the user
 *
 * so a top-level allowlist that admitted the container admitted all of that
 * with it. Nothing in the app populates those fields today, so no such data has
 * in fact been sent — but an allowlist whose guarantee depends on a nested
 * field happening to stay empty is not a guarantee, and the next feature to
 * write a `partnerId` into a profile would have shipped it to the server with
 * no code change here and nothing to notice.
 *
 * So the unit of permission is a declared leaf with a declared type. Anything
 * not named here is dropped at whatever depth it appears; anything named but
 * of the wrong type is dropped rather than coerced. `internalProfile` is gone
 * entirely: nothing in the app ever writes it, so syncing it bought nothing in
 * exchange for carrying every one of those fields.
 *
 * The eight `uiProfile` numbers that remain are exactly the ones the app
 * actually updates (App.jsx:656, :687, :793 and ContractView.jsx:141, :188).
 * Everything else in that object is a static initial value, so dropping it
 * costs no behaviour at all. They are also mock Trust Ladder counters, not
 * evidence of anything — see Roadmap.md.
 */
export const CLOUD_SAFE_SHAPE = {
  hasOnboarded: 'boolean',
  mode: 'string',
  view: 'string',
  step: 'number',
  savedAt: 'string',
  uiProfile: {
    level: 'number',
    exp: 'number',
    points: 'number',
    trustScore: 'number',
    completedContracts: 'number',
    avgRating: 'number',
    totalEarned: 'number',
    totalSpent: 'number',
  },
}

/** Whether a value is of the declared primitive type. No coercion. */
function isOfType(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string') return typeof value === 'string'
  return false
}

/**
 * Keep only what the shape declares, at every depth. Used on the way out AND
 * on the way back.
 *
 * Iterates the SHAPE, never the input, which is what makes a field nobody
 * declared unreachable rather than merely unlisted — including one added to a
 * nested object later, and including `__proto__` or any other key a crafted
 * payload might carry, since such a key is never read at all.
 *
 * An object is only descended into when the shape says it is an object. A
 * declared leaf whose value arrives as an object or an array is dropped, so a
 * scalar slot cannot be used to smuggle a structure through.
 */
function filterToShape(value, shape) {
  if (typeof shape === 'string') return isOfType(value, shape) ? value : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const out = {}
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const kept = filterToShape(value[key], shape[key])
    if (kept !== undefined) out[key] = kept
  }
  // An object that kept nothing is not worth sending, and sending `{}` would
  // make a filtered-away branch look like one that was genuinely empty.
  return Object.keys(out).length > 0 ? out : undefined
}

export function cloudSafeSubset(snapshot) {
  return filterToShape(snapshot, CLOUD_SAFE_SHAPE) ?? {}
}

/**
 * The only views a restored snapshot may put the user back on.
 *
 * WHY AN ALLOWLIST, FOR THE SECOND TIME IN THIS FILE
 * `view` is in CLOUD_SAFE_SHAPE, so it crosses devices. Almost nothing the
 * views need crosses with it: `selectedItem`, `projectDetail` and the fetched
 * agreement are local-cache-only or not persisted at all. Restoring a view
 * whose backing state did not come along renders an empty screen or a spinner
 * that never resolves — already hit live on 2026-09-28 with 'agreement', and
 * fixed then by excluding that one name.
 *
 * A denylist of the known-bad names was the wrong shape for the same reason it
 * was wrong for the payload above: the next view added to App.jsx is restorable
 * by default and nobody has to notice. So this names what MAY be restored:
 *
 *   home   — re-fetches its own contracts from the server.
 *   wallet — reads only the local ledger and the profile counters, both of
 *            which the snapshot carries or the app recomputes.
 *
 * Everything else falls back to 'home', which is also where the legacy
 * Marketplace / five-step ContractView surface stops being somewhere a reload
 * can strand you. Those screens run on local mock state and are reachable on
 * purpose from the command palette's "(legacy)" entries; being returned to one
 * by a restore is not the same thing as choosing it.
 */
export const RESTORABLE_VIEWS = new Set(['home', 'wallet'])

/** The view to open after a restore: the snapshot's, if it is one we may trust. */
export function restorableView(view) {
  return typeof view === 'string' && RESTORABLE_VIEWS.has(view) ? view : 'home'
}

/**
 * Kept as the flat list of top-level names the server may hold, since the
 * merge in loadRuntimeSnapshot and a couple of tests read it. Derived from the
 * shape rather than maintained beside it: two lists that must agree are one
 * list and a bug waiting.
 */
export const CLOUD_SAFE_KEYS = Object.keys(CLOUD_SAFE_SHAPE)

/**
 * Lay a filtered remote snapshot over the local one, following the same shape.
 *
 * A plain `{ ...local, ...remote }` would be wrong now that the shape reaches
 * inside objects: the server's `uiProfile` holds eight of that object's
 * seventeen fields, so a shallow spread would REPLACE the local one and wipe
 * the nine the server is no longer allowed to carry. The user would watch a
 * cross-device restore delete data the privacy change was supposed to leave
 * alone. Merging per declared leaf keeps both halves.
 */
export function mergeRemoteOverLocal(local, remote, shape = CLOUD_SAFE_SHAPE) {
  if (!remote || typeof remote !== 'object') return local
  if (!local || typeof local !== 'object') return remote

  const out = { ...local }
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(remote, key)) continue
    out[key] = typeof shape[key] === 'string'
      ? remote[key]
      : mergeRemoteOverLocal(local[key], remote[key], shape[key])
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

  // Local first for everything the server no longer carries, remote on top for
  // the declared leaves it does: a second device gets what the server can
  // legitimately give it, and this device keeps the rest of its own state —
  // including the parts of a profile object the server no longer holds.
  return mergeRemoteOverLocal(local, remote)
}
