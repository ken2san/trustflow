// src/lib/earnerAuth.js
// Turns the anonymous Earner into a recoverable permanent user by linking an
// email identity to the SAME auth.users id, so contracts they created do not
// become unreachable when this browser's storage is cleared.
//
// A 6-digit OTP is used rather than a confirmation link: the link form would
// send the Earner out to their mail client and back in a new tab, mid-send,
// and the pending contract would have to survive that round trip. The OTP
// keeps them on the page.
//
// Measured against this project on 2026-09-23:
//   signInAnonymously()      -> is_anonymous = true, email = ''
//   updateUser({ email })    -> is_anonymous STAYS true (verified after a
//                               token refresh too); only email_change is set,
//                               email_change_confirm_status = 0, and only the
//                               new-address token exists — an anonymous user
//                               has no current email, so despite the project's
//                               Secure Email Change setting there is just one
//                               OTP to confirm
//   after verifyOtp()        -> is_anonymous = false
// The database's verified_earner_only_insert policy keys off exactly that
// is_anonymous claim, so it stays closed for the whole pending window.

import { supabase } from './supabase.js'

const NOT_CONFIGURED = new Error('Supabase is not configured')

/**
 * Ask Supabase to send a 6-digit code to `email`. Does not change the session.
 * @returns {Promise<{ error: Error|null }>}
 */
export async function requestEarnerVerification(email) {
  if (!supabase) return { error: NOT_CONFIGURED }
  const { error } = await supabase.auth.updateUser({ email })
  return { error: error ?? null }
}

/**
 * Confirm the code. On success the anonymous user becomes permanent, keeping
 * the same id, and the refreshed session carries is_anonymous = false.
 * @returns {Promise<{ user: object|null, error: Error|null }>}
 */
export async function verifyEarnerOtp(email, token) {
  if (!supabase) return { user: null, error: NOT_CONFIGURED }
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: String(token).trim(),
    type: 'email_change',
  })
  return { user: data?.user ?? null, error: error ?? null }
}

/**
 * Whether the current session belongs to a verified (permanent) Earner.
 * Anything else — anonymous, signed out, unconfigured — is false.
 */
export async function isEarnerVerified() {
  if (!supabase) return false
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) return false
  return data.user.is_anonymous === false
}

// ── Returning from a fresh browser ──────────────────────────────────────────
//
// The flow above makes an anonymous user permanent once. It does nothing for
// the same person arriving on a new device, where there is no session to
// upgrade — they were anonymous, so there was never a password, and their
// contracts are reachable only through RLS on the original auth.users.id.
//
// signInWithOtp against that same email returns a session for that same id, so
// the contracts come back. Two properties of it matter:
//
//   shouldCreateUser: false  — this is sign-in, never signup. A typo cannot
//     silently mint a second account that owns nothing, which would look like
//     "my contracts disappeared".
//   Supabase answers an unknown address with the same otp_disabled error it
//     uses elsewhere, so the endpoint does not reveal which emails are
//     registered. We keep that ambiguity in the message we show.
//
// Measured against this project on 2026-09-24: email auth is enabled
// (/auth/v1/settings → external.email true, disable_signup false), and the
// endpoint accepts a known address. The built-in mailer rate-limits sends to a
// handful per hour and returns over_email_send_rate_limit, which is the real
// constraint on this flow until Custom SMTP is configured — it is reported to
// the user as a wait, not as a failure of their address.

/** Remembers who was last signed in, so an expired session can say whose. */
const LAST_EMAIL_KEY = 'tf_last_earner_email'

export function rememberEarnerEmail(email) {
  try { localStorage.setItem(LAST_EMAIL_KEY, email) } catch { /* private mode */ }
}

export function recallEarnerEmail() {
  try { return localStorage.getItem(LAST_EMAIL_KEY) } catch { return null }
}

function forgetEarnerEmail() {
  try { localStorage.removeItem(LAST_EMAIL_KEY) } catch { /* private mode */ }
}

/**
 * Send a sign-in code to an existing Earner's address.
 *
 * @returns {Promise<{ ok: boolean, reason: string|null }>}
 *          reason is 'not_configured' | 'unknown_email' | 'rate_limited'
 *                  | 'invalid_email' | 'error'
 */
export async function requestSignInCode(email) {
  if (!supabase) return { ok: false, reason: 'not_configured' }

  const address = String(email ?? '').trim()
  if (!address) return { ok: false, reason: 'invalid_email' }

  const { error } = await supabase.auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: false },
  })

  if (!error) return { ok: true, reason: null }

  const code = error.code ?? ''
  if (code === 'otp_disabled') return { ok: false, reason: 'unknown_email' }
  if (code === 'over_email_send_rate_limit') return { ok: false, reason: 'rate_limited' }
  if (code === 'email_address_invalid') return { ok: false, reason: 'invalid_email' }
  return { ok: false, reason: 'error' }
}

/**
 * Exchange the emailed code for a session on the original account.
 *
 * type 'email' is the sign-in code, distinct from the 'email_change' type used
 * when an anonymous user first claims an address — same six digits, different
 * verification path, and using the wrong one fails with a confusing error.
 *
 * @returns {Promise<{ user: object|null, reason: string|null }>}
 *          reason is 'not_configured' | 'invalid_code' | 'expired_code' | 'error'
 */
export async function verifySignInCode(email, token) {
  if (!supabase) return { user: null, reason: 'not_configured' }

  const { data, error } = await supabase.auth.verifyOtp({
    email: String(email ?? '').trim(),
    token: String(token ?? '').trim(),
    type: 'email',
  })

  if (error) {
    const message = (error.message ?? '').toLowerCase()
    if (message.includes('expired')) return { user: null, reason: 'expired_code' }
    if (error.status === 403 || message.includes('invalid')) return { user: null, reason: 'invalid_code' }
    return { user: null, reason: 'error' }
  }

  if (data?.user?.email) rememberEarnerEmail(data.user.email)
  return { user: data?.user ?? null, reason: null }
}

/**
 * Who, if anyone, this browser is currently acting as.
 *
 * `status` is:
 *   'signed_in'  a verified Earner — their contracts are readable
 *   'anonymous'  a throwaway identity, or none at all
 *   'expired'    anonymous now, but this browser was signed in before, so the
 *                session lapsed rather than never existing. The difference
 *                matters: one is a new user, the other is someone who will
 *                otherwise think their contracts vanished.
 *
 * @returns {Promise<{ status: 'signed_in'|'anonymous'|'expired', email: string|null, userId: string|null }>}
 */
export async function getAuthState() {
  const remembered = recallEarnerEmail()
  if (!supabase) return { status: 'anonymous', email: remembered, userId: null }

  const { data, error } = await supabase.auth.getUser()
  const user = error ? null : data?.user

  if (user && user.is_anonymous === false) {
    if (user.email) rememberEarnerEmail(user.email)
    return { status: 'signed_in', email: user.email ?? remembered, userId: user.id }
  }

  return {
    status: remembered ? 'expired' : 'anonymous',
    email: remembered,
    userId: user?.id ?? null,
  }
}

/**
 * End the session on this device and stop claiming to know who this was.
 *
 * Scoped to 'local' deliberately. supabase-js defaults to 'global', which
 * revokes every refresh token the account holds — signing out of a borrowed
 * laptop would also sign the Earner out of their own phone, mid-contract, with
 * no explanation. Signing out here means this browser.
 */
export async function signOutEarner() {
  forgetEarnerEmail()
  if (!supabase) return
  await supabase.auth.signOut({ scope: 'local' })
}

// ── Google, as an alternative to the email code ─────────────────────────────
//
// A Google-authenticated session is never anonymous, so it satisfies
// verified_earner_only_insert the same way a claimed email does — nothing
// server-side treats one differently from the other. This is a full-page
// redirect (Supabase's hosted OAuth flow), not a popup: the browser leaves and
// comes back to `redirectTo`, so there is no promise to await here beyond the
// redirect itself starting. getAuthState() on the next mount is what reports
// the resulting session, exactly as it already does after any other sign-in.
//
// Requires the Google provider to be configured in the Supabase dashboard
// (Authentication → Providers → Google, with a Google Cloud OAuth client) —
// this call does nothing useful until that exists.
export async function signInWithGoogle() {
  if (!supabase) return { error: NOT_CONFIGURED }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  return { error: error ?? null }
}
