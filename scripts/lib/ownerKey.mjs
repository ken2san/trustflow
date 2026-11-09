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
// without an address, a password, a mailbox or a CAPTCHA. The string is a
// Supabase refresh token, and `grant_type=refresh_token` is a token refresh
// rather than a sign-in, so it is outside what CAPTCHA protection covers
// (`src/lib/captcha.js`: sign-in, sign-up and password reset).
//
// "Without re-authenticating", not "indefinitely". How long it keeps working
// is a session policy — inactivity and absolute timeouts, and revocation — none
// of which this repository configures or has measured. An earlier version of
// this comment said indefinitely, which was a guarantee nobody here can give.
//
// WHAT IT IS NOT
// Not a TrustFlow API key. There is no such thing: nothing in this schema
// issues, scopes, lists or revokes a per-agent credential, and this credential
// carries the account's authority — every event written with it says the owner
// acted, with `_auth_method: account_session`, and the record cannot tell an
// agent from the human.
//
// WHAT REVOKING IT ACTUALLY MEANS, corrected by Codex's review. An earlier
// version said revoking required revoking every session the account has, and
// that is wrong: Supabase supports a session-scoped sign-out as well as a
// global one. But the indivisible unit here is not this agent — minting COPIED
// a refresh token out of a session, so the agent and the client it was copied
// from share one session family. Revoking that session logs out both; it does
// not touch the account's other sessions. And an access token already issued
// stays usable until it expires either way. What there is no way to do is
// revoke the agent alone, which is the gap a per-agent key would close.
// See .ada/claude-report-15.md §3.
//
// ROTATION IS NOT OPTIONAL
// An exchange can come back with a DIFFERENT refresh token, and when it does,
// an agent that keeps using the string it was first handed is relying on a
// reuse window it does not control. So this module writes the replacement back
// before returning, and that write is the part an agent deployment has to get
// right. It does not assume a new token every time: `rotated` below reports
// only whether the response differed from what was sent.
//
// MEASURED, because the first version of this comment guessed and was wrong.
// It said the previous token "stops working after a short reuse window". On the
// E2E project, one token was exchanged five times over about three and a half
// minutes — immediately, then at +30s, +60s and +120s — and every attempt
// returned HTTP 200.
//
// What that observation does NOT establish, per Codex: it is not proof of a
// long configured reuse interval. Supabase's documented behaviour includes
// returning the still-active token when its parent is presented, which can
// produce the same five successes without a long window. Either way the local
// consequence is the same, and neither reading licenses a revocation model:
//
//   - the previous string was not promptly rejected, so a missed write does not
//     fail immediately — the bug surfaces later and somewhere else, which is
//     why the write happens before returning;
//   - do not count on the next exchange neutralising a leaked copy. Treat every
//     copy as live until the session is revoked.

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';

/** Where the key lives by default. Gitignored; it is a credential. */
export const DEFAULT_KEY_FILE = 'tests/e2e/.owner-api-key.json';

/** Fields this file may carry. Anything else is refused — see loadOwnerKey. */
const ALLOWED_KEY_FIELDS = new Set(['refresh_token', 'minted_at', 'rotated_at', 'note']);

/**
 * Make sure only the owning user can read the credential, before reading it.
 *
 * Codex's review found the P1 here: the first version wrote this file with
 * plain `writeFile`, so under the usual umask 022 it landed as 0644 — the
 * account's whole authority, readable by group and other. Gitignoring a
 * credential keeps it out of a commit and does nothing about the filesystem.
 *
 * Narrowed rather than refused, deliberately: refusing would leave the
 * over-permissive file sitting there while the operator reads an error, and
 * there is nothing to decide — 0600 is the only correct mode for this file.
 * The narrowing is reported, because a credential that was world-readable for
 * a while is a fact about the past that a chmod does not undo.
 */
async function requireOwnerOnly(file) {
  const mode = (await stat(file)).mode & 0o777;
  if (mode & 0o077) {
    await chmod(file, 0o600);
    console.warn(`[owner-key] ${file} was mode ${mode.toString(8)} — narrowed to 600.`);
    console.warn('[owner-key] It was readable beyond its owner until now. '
      + 'If this machine has other users, treat the key as disclosed and mint a new one.');
  }
}

/**
 * Read the key.
 *
 * Deliberately narrow: `refresh_token` is required and any other field is
 * refused, so a file that also carries an address or a password is a shape
 * error rather than a quiet fallback. An earlier comment promised exactly that
 * and the code checked only the one field, which Codex caught by handing it a
 * file with all three — the comment was the documentation of a check that did
 * not exist.
 */
export async function loadOwnerKey(file) {
  await requireOwnerOnly(file).catch((err) => {
    throw new Error(
      `no owner key at ${file} (${err.code ?? 'unreadable'}). `
      + 'Mint one from a session a human already signed in to:\n'
      + '  node scripts/agents/mint-owner-key.mjs',
    );
  });

  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    // The reason is named, never the content. A JSON parse error can carry an
    // excerpt of its input, and the input here is a credential.
    throw new Error(
      `${file} is not readable as JSON (${err.code ?? err.name ?? 'parse error'}). `
      + 'Not printing it: this file is a credential.',
    );
  }
  if (typeof parsed?.refresh_token !== 'string' || !parsed.refresh_token) {
    throw new Error(`${file} carries no refresh_token`);
  }
  const unexpected = Object.keys(parsed).filter(k => !ALLOWED_KEY_FIELDS.has(k));
  if (unexpected.length) {
    throw new Error(
      `${file} carries unexpected fields: ${unexpected.join(', ')}. `
      + 'This file holds one credential and its provenance, nothing else — '
      + 'an address or a password here would mean the wrong file.',
    );
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
// NOT SAFE FOR TWO AGENTS SHARING ONE KEY FILE. There is no lock: two
// processes exchanging the same key concurrently both write, and the one that
// renames last wins while the other holds a token the file no longer names.
// The harness runs the owner once per run, so this does not arise here; a
// deployment running several agents off one key needs a lock, or a key each —
// and a key each is the argument for real per-agent keys in
// .ada/claude-report-15.md §3.
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

  // Before returning, not after acting, and atomically.
  //
  // Writing straight to `file` truncates it first, so a crash mid-write leaves
  // a zero-length or half-written key file — the agent's only copy of its
  // credential, gone, and the failure appears at the NEXT run rather than this
  // one. Write beside it and rename, which is atomic within a filesystem: the
  // file is either the old key or the new one, never a fragment. Found by
  // Codex reviewing this module.
  //
  // Considered and rejected: also keeping the previous token in the file as a
  // fallback. The measurement above says the previous string stays usable, so
  // that would persist a second live copy of the credential to buy recovery
  // from a case the rename already prevents.
  if (session.refresh_token && session.refresh_token !== refreshToken) {
    const staging = `${file}.next`;
    await writeFile(staging, JSON.stringify({
      refresh_token: session.refresh_token,
      rotated_at: new Date().toISOString(),
      note: 'Rotated by scripts/lib/ownerKey.mjs. The previous string is not '
        + 'promptly revoked — see that file. Treat every copy as live.',
    }, null, 2), { mode: 0o600 });
    await rename(staging, file);
  }

  return {
    token: session.access_token,
    userId: session.user?.id ?? null,
    rotated: Boolean(session.refresh_token && session.refresh_token !== refreshToken),
  };
}
