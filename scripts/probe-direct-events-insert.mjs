#!/usr/bin/env node
// E2E-only, zero-write-budget probe for Row 8 W2b: direct `POST /rest/v1/events`
// denial under the delegated bot's HTTP transport (`apikey: sb_publishable_...`,
// no `Authorization` header, no live grant secret).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT PROVE
// - Proves: a bot holding only the project publishable key cannot bypass
//   `log-event` by inserting directly into `public.events` via PostgREST
//   (refused at the gateway 401/403 or DB ACL 42501).
// - Does NOT prove: DB-layer write-ticket enforcement (`TF011`) against
//   privileged (`service_role` / `authenticated`) writers; that is proven
//   separately by T240 (rolled-back hosted E2E probe) and `tests/sql/drop_v5_check.sh`.
//
// Usage (E2E only, explicit guard, single request, no retries):
//   VITE_SUPABASE_URL=https://yqjtawffpesplqyurlpj.supabase.co \
//   TF_E2E_PUBLISHABLE_KEY=sb_publishable_... \
//     node scripts/probe-direct-events-insert.mjs --deal <contract-uuid> --approve-zero-write-probe

import { pathToFileURL } from 'node:url'
import { E2E_ORIGIN, installPinnedFetch, isPinned } from './lib/pinnedFetch.mjs'
import { ClientError, PUBLISHABLE_TOKEN, UUID } from './lib/delegatedClient.mjs'

const USAGE = 'usage: probe-direct-events-insert.mjs --deal <contract-uuid> --approve-zero-write-probe'
const SAFE_CODE = /^[0-9A-Z]{5}$/
const BYPASS_SQLSTATES = new Set(['23502', '23503', '23505', '23514'])

export function parseProbeArgs(args, env = process.env) {
  if (env.VITE_SUPABASE_URL !== E2E_ORIGIN) {
    throw new ClientError('direct events insert probe requires the exact E2E origin')
  }
  if (args.length !== 3 || args[0] !== '--deal' || !UUID.test(args[1] ?? '')
      || args[2] !== '--approve-zero-write-probe') {
    throw new ClientError(USAGE)
  }
  const pub = env.TF_E2E_PUBLISHABLE_KEY
  if (!PUBLISHABLE_TOKEN.test(pub ?? '')) {
    throw new ClientError('TF_E2E_PUBLISHABLE_KEY must be a valid sb_publishable_ token')
  }
  return { dealId: args[1], pub }
}

/**
 * Classify one `POST /rest/v1/events` refusal probe response.
 *
 *   db_refused        42501 on non-2xx: DB privilege refusal           PASS
 *   http_refused      401/403 without trigger/constraint code          PASS (HTTP boundary; DB ACL not shown)
 *   privilege_bypass  TF### trigger or 235xx constraint reached        FAIL + STOP (privileges did not refuse)
 *   reached_2xx       2xx response                                     FAIL + STOP (write may have landed)
 *   inconclusive      any other non-2xx or transport error             FAIL + STOP
 */
export function classifyEventsInsertRefusal(status, body) {
  const obj = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const rawCode = typeof obj.code === 'string' ? obj.code : ''
  const code = SAFE_CODE.test(rawCode) ? rawCode : ''

  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { outcome: 'inconclusive', pass: false, stop: true, code: '', detail: 'no HTTP status' }
  }
  if (status >= 200 && status < 300) {
    return { outcome: 'reached_2xx', pass: false, stop: true, code, detail: `unexpected HTTP ${status}` }
  }
  if (code === '42501') {
    return { outcome: 'db_refused', pass: true, stop: false, code, detail: 'database privilege refusal (42501)' }
  }
  if (/^TF\d{3}$/.test(code) || BYPASS_SQLSTATES.has(code)) {
    return {
      outcome: 'privilege_bypass',
      pass: false,
      stop: true,
      code,
      detail: `privileges did not refuse; reached trigger/constraint (${code})`,
    }
  }
  if (status === 401 || status === 403) {
    return {
      outcome: 'http_refused',
      pass: true,
      stop: false,
      code,
      detail: `refused at HTTP/gateway boundary (HTTP ${status}); DB ACL not separately shown`,
    }
  }
  return {
    outcome: 'inconclusive',
    pass: false,
    stop: true,
    code,
    detail: `HTTP ${status}${code ? ` (${code})` : ''}`,
  }
}

export function buildProbeRow(dealId) {
  if (!UUID.test(dealId ?? '')) throw new ClientError('invalid deal id')
  return {
    contract_id: dealId,
    type: 'performance.asserted',
    actor_id: 'probe-anon-direct-insert',
    payload: {},
    dod_hash: '0'.repeat(64),
    event_hash: '0'.repeat(64),
    prev_event_hash: '0'.repeat(64),
    hash_version: 5,
  }
}

/** Execute exactly one pinned `POST /rest/v1/events` call. Never retries. */
export async function runDirectInsertProbe({ dealId, pub, fetchImpl = globalThis.fetch }) {
  if (!isPinned() && fetchImpl === globalThis.fetch) {
    throw new ClientError('direct insert probe: pinned fetch is not installed')
  }
  if (!PUBLISHABLE_TOKEN.test(pub ?? '')) {
    throw new ClientError('TF_E2E_PUBLISHABLE_KEY must be a valid sb_publishable_ token')
  }
  const headers = new Headers([
    ['Content-Type', 'application/json'],
    ['apikey', pub],
    ['Prefer', 'return=minimal'],
  ])
  let res
  try {
    res = await fetchImpl(`${E2E_ORIGIN}/rest/v1/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildProbeRow(dealId)),
    })
  } catch {
    return {
      status: null,
      classification: { outcome: 'inconclusive', pass: false, stop: true, code: '', detail: 'transport error (no retry)' },
    }
  }
  let body = null
  try { body = JSON.parse(await res.text()) } catch { /* non-JSON body ignored */ }
  return { status: res.status, classification: classifyEventsInsertRefusal(res.status, body) }
}

async function main() {
  const { dealId, pub } = parseProbeArgs(process.argv.slice(2))
  installPinnedFetch()
  const { status, classification } = await runDirectInsertProbe({ dealId, pub })
  console.log(`W2b direct POST /rest/v1/events probe on ${dealId}: ${classification.outcome} (HTTP ${status ?? 'none'}) — ${classification.detail}`)
  console.log(`Zero-row readback required: verify owner-session event count on ${dealId} is unchanged (2) via \`node scripts/verify-chain.mjs ${dealId}\`.`)
  if (!classification.pass || classification.stop) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof ClientError ? err.message : 'direct events insert probe failed')
    process.exit(1)
  })
}
