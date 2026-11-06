// src/lib/captcha.js
//
// The Cloudflare Turnstile token Supabase asks for when CAPTCHA protection is
// enabled on a project.
//
// WHY THIS FILE EXISTS, AND THE INCIDENT THAT PUT IT HERE
// On 2026-11-06 CAPTCHA protection was switched on in the production
// dashboard, on the strength of a recommendation from this session and from two
// reviewers, all three of which described it as a settings change costing no
// code. It is not. With protection on and no token sent, EVERY auth endpoint
// answers 400 `captcha_failed` — measured directly:
//
//   POST /auth/v1/signup  -> captcha protection: request disallowed (no captcha_token found)
//   POST /auth/v1/otp     -> captcha protection: request disallowed (no captcha_token found)
//
// which locked sign-in for the one account that exists, including the owner's,
// and was reverted within the hour. The lesson is recorded in the code that
// fixes it: a dashboard toggle that silently requires a frontend contract is
// not a configuration change.
//
// WHAT IS AND IS NOT PROTECTED
// Supabase applies CAPTCHA to sign-in, sign-up and password-reset endpoints.
// `updateUser({ email })` — how an anonymous session claims an address and
// becomes a permanent account here (see earnerAuth.js) — goes to
// /auth/v1/user and is NOT covered, so that step needs no token. The two that
// do are `signInWithOtp` and `signInAnonymously`.
//
// NO NEW DEPENDENCY
// The documented path is @marsidev/react-turnstile. Turnstile's own API is
// `window.turnstile.render(el, { sitekey, callback })`, which is all that is
// needed, and AGENTS.md requires approval for a package. A script tag is not
// worth an approval.
//
// DEGRADATION IS THE DEFAULT, DELIBERATELY
// With no site key configured — local dev, the E2E project, any build before
// the key is set — every function here reports "not configured" and the auth
// calls omit the token. That is correct rather than lax: a token sent to a
// project with protection OFF is ignored, and a build that refused to
// authenticate without a key would reproduce the outage above at a different
// layer. The project either requires the token or it does not, and the server
// is the one that decides.

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/**
 * The public site key. Public by design: it is served inside the bundle and
 * identifies the widget, while the secret half lives only in Supabase.
 *
 * NO DEFAULT, deliberately. Cloudflare publishes always-passes test keys
 * (`1x00000000000000000000AA` and friends, under Turnstile → Testing) and
 * using one as a fallback was the first version of this file. It was wrong in
 * the direction this project keeps paying for: an unset variable would have
 * put a widget and the words "test challenge key" on the live site, and a
 * token Supabase's secret cannot verify would have been sent to a protected
 * project. Unset therefore means one thing — this deployment has no CAPTCHA —
 * and a developer who wants the widget sets the test key explicitly in .env,
 * where the choice is visible.
 */
export const CAPTCHA_SITE_KEY = import.meta.env?.VITE_TURNSTILE_SITE_KEY || null

/** Whether this build has a challenge to show at all. */
export function captchaConfigured() {
  return typeof CAPTCHA_SITE_KEY === 'string' && CAPTCHA_SITE_KEY.length > 0
}

/** Cloudflare's always-passes test keys, which must never reach production. */
const TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA', // visible, always passes
  '2x00000000000000000000AB', // visible, always blocks
  '1x00000000000000000000BB', // invisible, always passes
  '3x00000000000000000000FF', // forces an interactive challenge
])

export function captchaIsTestKey() {
  return captchaConfigured() && TEST_SITE_KEYS.has(CAPTCHA_SITE_KEY)
}

let scriptPromise = null

/**
 * Load Turnstile once, and never reject into a caller's auth flow: a blocked
 * CDN, an ad blocker or an offline tab must produce "no token" rather than an
 * exception inside a sign-in handler.
 */
export function loadCaptchaScript() {
  if (typeof document === 'undefined' || !captchaConfigured()) return Promise.resolve(false)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve) => {
    if (window.turnstile) return resolve(true)
    const existing = document.querySelector(`script[src="${SCRIPT_URL}"]`)
    const el = existing ?? document.createElement('script')
    el.addEventListener('load', () => resolve(Boolean(window.turnstile)))
    el.addEventListener('error', () => resolve(false))
    if (!existing) {
      el.src = SCRIPT_URL
      el.async = true
      el.defer = true
      document.head.appendChild(el)
    }
  })
  return scriptPromise
}

/**
 * Render a widget into `container` and report each token it produces.
 *
 * Returns a disposer, or null when the script never arrived. Tokens are
 * single-use and Turnstile expires them after a few minutes, hence `expired`
 * and `error` clearing the caller's copy rather than leaving a stale one that
 * would fail server-side with a message about the agreement instead of about
 * the challenge.
 */
export async function renderCaptcha(container, onToken) {
  if (!captchaConfigured()) return null
  const ready = await loadCaptchaScript()
  if (!ready || !container) return null

  const widgetId = window.turnstile.render(container, {
    sitekey: CAPTCHA_SITE_KEY,
    callback: (token) => onToken(token ?? null),
    'expired-callback': () => onToken(null),
    'error-callback': () => onToken(null),
  })

  return () => {
    try { window.turnstile.remove(widgetId) } catch { /* already gone */ }
  }
}

/**
 * The `options` object to spread into a Supabase auth call.
 *
 * An absent token yields `{}` rather than `{ captchaToken: undefined }`: the
 * second is indistinguishable to this code but travels as an explicit null in
 * some serializations, and the only honest request is one that does not
 * mention a challenge it cannot answer.
 */
export function captchaOptions(token) {
  return typeof token === 'string' && token.length > 0 ? { captchaToken: token } : {}
}
