// tests/e2e/publishableKey.js
//
// The transport key for delegated (agent grant) requests on hosted E2E: an
// active `sb_publishable_` key, sent as `apikey` with no Authorization header
// (supabase/functions/_shared/delegatedAuth.ts). `.env.e2e` holds only the
// legacy anon JWT, which delegated admission refuses, and nothing is added to
// it: the key is read from the Supabase CLI in-process.
//
// NEVER PRINT IT. The value is returned to the caller only. CLI output goes to
// a pipe, its stderr is discarded, and every error message here is fixed text.

import { execFileSync } from 'node:child_process'

// The same one-token grammar as supabase/functions/_shared/delegatedAuth.ts
// (PUBLISHABLE_TOKEN), kept literal here because this file runs under Node
// without the Deno function modules.
const PUBLISHABLE_TOKEN = /^sb_publishable_[A-Za-z0-9_-]+$/
// Key aliases this helper may select. Fixed so no caller-supplied text can
// reach an error message.
const ALIASES = new Set(['default'])

/**
 * The publishable key named `name` from `supabase projects api-keys -o json`
 * output. Refuses anything that is not exactly one well-formed publishable key.
 */
export function selectPublishableKey(json, name = 'default') {
  if (!ALIASES.has(name)) throw new Error('unsupported publishable key alias')
  let rows
  try { rows = JSON.parse(json) } catch { throw new Error('api-keys output is not JSON') }
  if (!Array.isArray(rows)) throw new Error('api-keys output is not a list')
  const hits = rows.filter(r => r && r.type === 'publishable' && r.name === name)
  if (hits.length !== 1) throw new Error('expected exactly one publishable key with the selected alias')
  const key = hits[0].api_key
  if (typeof key !== 'string' || !PUBLISHABLE_TOKEN.test(key)) {
    throw new Error('the selected key is not a publishable key')
  }
  return key
}

/** The project ref of a `https://<ref>.supabase.co` URL. */
export function projectRef(supabaseUrl) {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(supabaseUrl ?? '')
  if (!m) throw new Error('SUPABASE_URL is not a hosted project URL')
  return m[1]
}

/**
 * Read the project's publishable key through the logged-in Supabase CLI.
 *
 * Measured against the installed CLI 2.105.0 (T257, T259): the explicit target
 * flag is `--project-ref` (the newer `--remote`/`--reveal` flags do not exist
 * there), and `-o json` yields rows of { name, type: legacy|publishable|secret,
 * api_key }. No reveal flag is passed. This helper does not pin E2E: the caller
 * keeps its exact target guard.
 */
export function readPublishableKey(supabaseUrl, name = 'default') {
  const ref = projectRef(supabaseUrl)
  let out
  try {
    out = execFileSync('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
    })
  } catch {
    throw new Error('supabase projects api-keys failed')
  }
  return selectPublishableKey(out, name)
}
