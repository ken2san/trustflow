// src/lib/supabase.js
// Supabase client singleton.
// Falls back to null when env vars are not set (mock/dev mode — app still works).
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null

export const isSupabaseEnabled = Boolean(supabase)

// Which backend this bundle was built against, readable from the page.
//
// The browser-driving E2E suites load the app from the dev server, and that
// server builds VITE_SUPABASE_URL from .env — not from the .env.e2e the test
// process reads. The two can therefore disagree, and when they do the tests write
// their data into whichever project .env happens to name. tests/e2e/00-backend-guard
// asserts this value instead of assuming. No new exposure: the URL is already in
// the bundle and on every request it makes.
if (typeof window !== 'undefined') window.__TF_SUPABASE_URL__ = url ?? null

/**
 * The reason the SERVER gave for refusing an Edge Function call.
 *
 * supabase-js turns any non-2xx into a FunctionsHttpError and sets `data` to
 * null, so the obvious `data?.error` collapses every distinct refusal into one
 * generic string. That has now cost this project twice: `type_not_allowed`
 * hid behind "That could not be recorded" for two weeks while a stale function
 * rejected every payment, and `invalid_guest_token` hid behind "The agreement
 * could not be loaded" the day guest links shipped. Both times the server was
 * saying exactly what was wrong and the client threw it away.
 *
 * The failing Response is carried back on the result, and the library throws
 * before reading its body, so the JSON the function returned is still there.
 * It is cloned rather than consumed, so a caller that wants the response for
 * anything else still can.
 *
 * Returns null when the call succeeded, the function's own `error` string when
 * there is one, and 'error' when the failure carried no readable reason —
 * a network drop, or a body that is not the JSON shape these functions use.
 */
export async function invokeErrorReason({ data, error, response }) {
  if (data?.error) return data.error
  if (!error) return null
  try {
    const body = await (response ?? error.context)?.clone?.()?.json?.()
    if (typeof body?.error === 'string') return body.error
  } catch {
    // Not JSON, already consumed, or not a Response at all (a fetch failure
    // carries the cause here instead). Fall through to the generic reason.
  }
  return 'error'
}
