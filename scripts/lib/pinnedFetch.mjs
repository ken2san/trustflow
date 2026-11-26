// Every HTTP request this process makes goes to hosted E2E, or nowhere.
//
// scripts/lib/e2eGuard.mjs checks a configured URL once. That does not cover a
// request whose URL is built elsewhere, nor a 3xx that moves a credential-
// bearing request to another host after the check (Codex T213 must-fix 2).
// This wraps the global fetch so that, from the moment it is installed:
//
//   * any destination whose origin is not the E2E project is refused before a
//     byte is sent, whatever module built the URL;
//   * redirects are errors, never followed, so the origin checked is the one
//     that answers;
//   * every request is time-bounded unless the caller gave its own signal.
//
// The origin is built from E2E_PROJECT_REF, which is in source control, never
// from the environment the run is trying to validate. A child process gets the
// same guard through ./pinnedFetchPreload.mjs.

import { E2E_PROJECT_REF } from './e2eGuard.mjs'

export const E2E_ORIGIN = `https://${E2E_PROJECT_REF}.supabase.co`
const PINNED = Symbol.for('trustflow.pinnedFetch')
const TIMEOUT_MS = 30_000

export function installPinnedFetch() {
  if (globalThis.fetch?.[PINNED]) return
  const base = globalThis.fetch
  const pinned = (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    let origin
    try { origin = new URL(url).origin } catch { origin = null }
    // Fixed text: the URL may carry a query worth not printing.
    if (origin !== E2E_ORIGIN) return Promise.reject(new Error('pinned fetch: refused a destination other than E2E'))
    return base(input, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) })
  }
  pinned[PINNED] = true
  globalThis.fetch = pinned
}

export function isPinned() {
  return globalThis.fetch?.[PINNED] === true
}
