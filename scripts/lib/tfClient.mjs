// The two credentials a TrustFlow transaction actually uses, over plain HTTP.
//
// There is no browser here and no supabase-js: just fetch, the anon key, and
// whichever of the two authorities the acting party holds.
//
//   owner  — a verified Earner's JWT in `Authorization`. An account.
//   guest  — a `guest_access_token` in `x-guest-access-token`. NOT an account:
//            a bearer capability the owner delivered out of band, which says
//            the holder may act on one agreement and nothing about who they
//            are. The counterparty has no user row at all (hirer_user_id is
//            null on every accepted contract).
//
// Keeping them as two separate objects in this file, rather than one "client"
// with a mode flag, is deliberate: every call site has to name which authority
// it is acting under, and a test that accidentally acts as the wrong party
// fails to compile its own intent rather than quietly passing.
//
// WHAT IS NOT HERE, ON PURPOSE
// service_role. Not for a transaction step, not for a shortcut, not for
// fixture setup. A harness holding service_role would bypass RLS, the column
// grants and the party checks — which are the things under test — and would
// prove only that the database can write rows. The whole point is that these
// requests are refused exactly where a real caller would be refused.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL, EARNER_PASSWORD,
} from '../../tests/e2e/liveEnv.js';
import { assertE2EProject } from './e2eGuard.mjs';

// Before anything else. liveEnv has already loaded .env.e2e by the time this
// module body runs, so this is the first moment the destination is knowable —
// and it is still before any request.
export const PROJECT_REF = assertE2EProject(SUPABASE_URL);
export { SUPABASE_URL };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The same cache the Playwright suites use. Sharing it is the point: a run of
// each costs one token grant between them rather than one apiece, and auth
// rate limits have taken this project offline before (2026-09-24).
const SESSION_CACHE = process.env.TF_TEST_EARNER_SESSION
  ?? path.join(REPO_ROOT, 'tests/e2e/.earner-session.json');

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function unexpired(session) {
  return Boolean(session?.access_token && session?.expires_at)
    && session.expires_at * 1000 - Date.now() > REFRESH_MARGIN_MS;
}

async function stillLive(session) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
  });
  return r.status === 200;
}

let inFlight = null;

/**
 * The owner's session, by password grant.
 *
 * Password and not the product's own sign-in: that is an 8-digit emailed OTP,
 * which cannot be automated without a live mailbox. Password and not an
 * anonymous sign-in: three full suite runs saturating the anonymous cap is
 * what took the project down. This grant creates no user and consumes no
 * signup quota — the account already exists.
 */
export async function ownerSession() {
  inFlight ??= (async () => {
    try {
      const cached = JSON.parse(await readFile(SESSION_CACHE, 'utf8'));
      if (unexpired(cached) && await stillLive(cached)) return cached;
    } catch { /* absent, unreadable or unreachable — grant a fresh one */ }

    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EARNER_EMAIL, password: EARNER_PASSWORD }),
    });
    const session = await r.json();
    // Deliberately not echoing the body: a failed grant can carry the address.
    if (r.status !== 200) throw new Error(`owner sign-in failed (${r.status})`);
    await writeFile(SESSION_CACHE, JSON.stringify(session, null, 2));
    return session;
  })();

  const session = await inFlight;
  return { token: session.access_token, userId: session.user.id };
}

/** PostgREST, as the owner. The same path the app's own reads and writes take. */
export async function rest(ownerToken, pathAndQuery, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

/**
 * An Edge Function, under whichever authority the caller names.
 *
 * `reason` reproduces what src/lib/supabase.js's invokeErrorReason does for the
 * browser: read the function's own `{error}` off a non-2xx rather than
 * flattening every refusal into one word. These functions say precisely what
 * was wrong — a client that discards that is how `type_not_allowed` read as a
 * transient failure for two weeks.
 */
export async function invoke(name, { ownerToken = null, guestToken = null, body = null } = {}) {
  // The gateway rejects a function call with no bearer at all, so the anon key
  // stands in when the caller has no account — which is what supabase-js does
  // in the browser for a signed-out visitor, and what an invitee holding only
  // a link really is. It is not an authority: validate-invite-token still
  // decides everything from the invite token in the body.
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${ownerToken ?? SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (guestToken) headers['x-guest-access-token'] = guestToken;

  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

  return {
    status: r.status,
    data: r.ok ? parsed : null,
    reason: r.ok ? (parsed?.error ?? null) : (parsed?.error ?? `http_${r.status}`),
  };
}
