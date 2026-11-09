// The owner's credential as a KEY, not a login.
//
// WHY THIS EXISTS
// `tfClient.ownerSession()` signs in with `grant_type=password`. That grant is
// a harness-only path: the product's own sign-in is an emailed OTP behind a
// Turnstile challenge, which no agent can complete (.ada/claude-report-13.md
// §4). So every agent run so far has proved the protocol while holding a
// credential no real agent could hold.
//
// This module holds the other half of that finding: an agent handed ONE opaque
// string, once, by a human who signed in, can keep itself authenticated
// indefinitely without an address, a password, a mailbox or a CAPTCHA. The
// string is a Supabase refresh token, and `grant_type=refresh_token` is a token
// refresh rather than a sign-in, so it is outside what CAPTCHA protection
// covers (`src/lib/captcha.js`: sign-in, sign-up and password reset).
//
// WHAT IT IS NOT
// Not a TrustFlow API key. There is no such thing: nothing in this schema
// issues, scopes, lists or revokes a per-agent credential, and a refresh token
// is the whole account — every event written with it says the owner acted, with
// `_auth_method: account_session`, and the record cannot tell an agent from the
// human. Revoking it means revoking every session that account has. See
// .ada/claude-report-15.md §3 for what a real first-party key would need.
//
// ROTATION IS NOT OPTIONAL
// Supabase returns a NEW refresh token on every exchange. An agent that keeps
// using the string it was first handed is relying on a reuse window it does not
// control, so this module writes the replacement back before returning, and
// that write is the part an agent deployment has to get right.
//
// MEASURED, because the first version of this comment guessed and was wrong.
// It said the previous token "stops working after a short reuse window". On the
// E2E project, one token was exchanged five times over about three and a half
// minutes — immediately, then at +30s, +60s and +120s — and every attempt
// returned HTTP 200. So the previous string is NOT promptly revoked here, and
// the upper bound was not found. How long it stays usable is a server setting
// this repository does not configure, and production was not measured.
//
// Two consequences, and the second is the one that matters:
//   - a missed write does not fail immediately, so the bug it causes surfaces
//     later and somewhere else;
//   - a leaked key is not neutralised by the next exchange. Revoking means
//     revoking the account's sessions, because that is all this credential is.

import { readFile, writeFile } from 'node:fs/promises';

/** Where the key lives by default. Gitignored; it is a credential. */
export const DEFAULT_KEY_FILE = 'tests/e2e/.owner-api-key.json';

/**
 * Read the key. Deliberately narrow: one field, so that a file holding an
 * address or a password is a shape error rather than a quiet fallback.
 */
export async function loadOwnerKey(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `no owner key at ${file} (${err.code ?? 'unreadable'}). `
      + 'Mint one from a session a human already signed in to:\n'
      + '  node scripts/agents/mint-owner-key.mjs',
    );
  }
  if (typeof parsed?.refresh_token !== 'string' || !parsed.refresh_token) {
    throw new Error(`${file} carries no refresh_token`);
  }
  return parsed.refresh_token;
}

/**
 * Exchange the key for an access token, and persist the rotated key.
 *
 * Returns the same shape `ownerSession()` does, so a caller can swap one for
 * the other without knowing which credential it is holding — the point being
 * that the SERVER cannot tell either.
 */
export async function ownerSessionFromKey(url, anonKey, file = DEFAULT_KEY_FILE) {
  const refreshToken = await loadOwnerKey(file);

  const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const session = await r.json().catch(() => null);
  // Not echoing the body: a failed grant can carry identifying detail.
  if (r.status !== 200 || !session?.access_token) {
    throw new Error(`owner key exchange failed (${r.status})`);
  }

  // Before returning, not after acting. A crash between the exchange and this
  // write would leave the agent holding a spent key.
  if (session.refresh_token && session.refresh_token !== refreshToken) {
    await writeFile(file, JSON.stringify({
      refresh_token: session.refresh_token,
      rotated_at: new Date().toISOString(),
      note: 'Rotated by scripts/lib/ownerKey.mjs. The previous string is not '
        + 'promptly revoked — see that file. Treat every copy as live.',
    }, null, 2));
  }

  return {
    token: session.access_token,
    userId: session.user?.id ?? null,
    rotated: Boolean(session.refresh_token && session.refresh_token !== refreshToken),
  };
}
