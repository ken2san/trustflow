// What a grant-holding agent needs to call TrustFlow on hosted E2E, and
// nothing else (Row 7; docs/api/delegated-agent-access.md).
//
// A delegated request carries exactly two credentials:
//   apikey             the project's publishable key (`sb_publishable_…`), a
//                      public project identifier, not an authority;
//   x-trustflow-grant  `<grant-uuid>.<64 lowercase hex>`, the one value an
//                      owner is shown once when issuing a grant.
// No Authorization header: a bearer of any kind makes the request mixed, and
// the server refuses it (supabase/functions/_shared/delegatedAuth.ts).
//
// Every request goes through scripts/lib/pinnedFetch.mjs: E2E origin only,
// redirects refused, time-bounded. Output is allowlisted: status codes and
// error words matching [a-z_]{1,64}, never a response body or a credential.
//
// Used by scripts/agents/owner-delegate-agent.mjs and by the row 4 trial
// (scripts/lib/delegatedTrial.mjs re-exports the grant-file and word helpers).

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { E2E_ORIGIN, isPinned } from './pinnedFetch.mjs'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const GRANT_TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/
// The same one-token grammar as delegatedAuth.ts PUBLISHABLE_TOKEN.
export const PUBLISHABLE_TOKEN = /^sb_publishable_[A-Za-z0-9_-]+$/
export const GRANT_HEADER = 'x-trustflow-grant'
/** A bot run id (scripts/agents/bootstrap.mjs): lowercase, digits, hyphens. */
export const RUN_ID = /^[a-z0-9][a-z0-9-]{2,39}$/

/** An error whose text this code wrote: fixed words, codes and ids only. */
export class ClientError extends Error {}

/** A response's error field, reduced to something safe to print. */
export const word = v => (v === null || v === undefined) ? 'none'
  : (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : 'unexpected')

/**
 * `<grant-uuid>.<64 hex>` from a regular file owned by this user, mode exactly
 * 0600, opened once without following a symlink; every check is on that fd.
 */
export function readGrantFile(file, { envName = 'TF_DELEGATED_GRANT_FILE' } = {}) {
  if (!file) throw new ClientError(`${envName} is not set`)
  let fd
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
    throw new ClientError('the grant file cannot be opened (missing, unreadable or a symlink)')
  }
  let grant
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new ClientError('the grant file is not a regular file')
    if (st.uid !== process.getuid()) throw new ClientError('the grant file is not owned by this user')
    if ((st.mode & 0o7777) !== 0o600) throw new ClientError('the grant file mode must be exactly 0600')
    grant = readFileSync(fd, 'utf8').trim()
  } catch (e) {
    throw e instanceof ClientError ? e : new ClientError('the grant file cannot be read')
  } finally {
    closeSync(fd)
  }
  const m = GRANT_TOKEN.exec(grant)
  if (!m) throw new ClientError('the grant file does not hold "<uuid>.<64 hex>"')
  return { grant, grantId: m[1] }
}

/**
 * One delegated call to an E2E Edge Function. `grantHeader` null omits the
 * header (only refusal tests want that); `extra` adds headers verbatim.
 * Returns { status, error (a word), json }.
 */
export async function delegatedRequest({ fn, pub, grantHeader, body, extra = [], origin = null }) {
  if (!isPinned()) throw new ClientError('delegated request: the pinned fetch is not installed')
  if (!/^[a-z][a-z-]{0,62}$/.test(fn ?? '')) throw new ClientError('delegated request: not a function name')
  const headers = new Headers([['Content-Type', 'application/json'], ['apikey', pub]])
  if (origin) headers.append('Origin', origin)
  if (grantHeader !== null) headers.append(GRANT_HEADER, grantHeader)
  for (const [k, v] of extra) headers.append(k, v)
  const r = await fetch(`${E2E_ORIGIN}/functions/v1/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) })
  let json = null
  try { json = JSON.parse(await r.text()) } catch { /* compared by status only */ }
  return { status: r.status, error: word(json?.error), json }
}

/** The deal's owner projection and receipt, under the grant's `read` scope. */
export const delegatedRead = ({ pub, grant, contractId }) =>
  delegatedRequest({ fn: 'delegated-owner-read', pub, grantHeader: grant, body: { contract_id: contractId } })

/** One owner event, under the grant's scope for `type`. A same-key retry is a replay. */
export const delegatedAppend = ({ pub, grant, contractId, type, payload = {}, idempotencyKey }) =>
  delegatedRequest({ fn: 'log-event', pub, grantHeader: grant,
    body: { type, contract_id: contractId, payload, idempotency_key: idempotencyKey } })
