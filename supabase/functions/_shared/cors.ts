// supabase/functions/_shared/cors.ts
//
// One CORS policy for the four live functions, replacing
// `Access-Control-Allow-Origin: '*'` in each of them.
//
// WHAT A WILDCARD COSTS HERE, AND WHAT IT DOES NOT
// It does not hand anyone a credential. Every one of these functions
// authenticates the caller itself — an owner's JWT, a guest capability, or a
// single-use invitation — and a browser on another origin cannot read this
// project's localStorage to obtain one. What `*` does cost is that any page
// anywhere can make a *credentialed-by-the-caller* request and read the
// response: a page that has somehow obtained a guest token (forwarded link,
// shared screenshot, a token pasted into a form) can call these endpoints from
// its own origin and show the agreement to its author. An allowlist makes that
// one step harder without protecting anything the authentication already does.
// Reviewer finding M3; recorded at this size so nobody reads the change as
// closing a hole it does not close.
//
// AGENTS MUST KEEP WORKING, AND THAT DECIDES THE SHAPE
// CORS is a browser mechanism. A server-side caller — the harnesses, an MCP
// server, anyone following `/agent-protocol.md` — sends no `Origin` and never
// preflights, so it must not be affected at all. So:
//
//   no Origin header          -> no Access-Control-Allow-Origin in the reply.
//                                The request is served normally; nothing about
//                                a non-browser call changes.
//   Origin on the allowlist   -> that exact origin is echoed back.
//   Origin not on the list    -> no Access-Control-Allow-Origin. The function
//                                still runs and still answers; the BROWSER is
//                                what refuses to hand the response to the page.
//
// Deliberately NOT a 403 for a disallowed origin: refusing the request would
// change behaviour for anything that sends an Origin header without being a
// browser, and the response is already unreadable to the page that cannot see
// it. Omitting the header is the mechanism CORS actually defines.
//
// NO Access-Control-Allow-Methods, measured rather than assumed. The deployed
// preflight does not send one today and the web app works, because POST is a
// CORS-safelisted method and the method check passes without it. All four
// functions are POST-only. Adding one would be a second change to behaviour
// this commit cannot deploy-test.

/**
 * The one header list, for all four functions.
 *
 * Deliberately the union rather than per-function: `x-guest-access-token` is
 * only read by two of them, and advertising it on the others costs nothing —
 * while a function that reads a header it forgot to advertise fails the
 * preflight in a browser and nowhere else. `log-event`'s own comment records
 * that exact bug reaching production, invisible to every API-level test. One
 * list cannot drift into it.
 */
export const ALLOW_HEADERS =
  'authorization, x-client-info, apikey, content-type, x-guest-access-token'

/**
 * Origins the web app is actually served from.
 *
 * `project-trustflow.vercel.app` is the only domain attached to the Vercel
 * project (verified against the Vercel API, 2026-11-09 — there is no custom
 * domain). The two loopback entries are the dev server and the Playwright
 * `baseURL` (`playwright.config.js`: `http://localhost:5173`); both are kept
 * because a browser sends whichever host the developer typed.
 */
const ALLOWED_ORIGINS = new Set([
  'https://project-trustflow.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

/**
 * This project's own Vercel preview deployments, e.g.
 * `https://project-trustflow-p8zf16a6m-team-kenji.vercel.app`.
 *
 * Every push to main creates one and they point at the production Supabase
 * project, so refusing them would break looking at a deploy before it is the
 * live one. Anchored at both ends and tied to this project's name and team, so
 * it admits this project's previews and not `vercel.app` in general.
 */
const PREVIEW_ORIGIN =
  /^https:\/\/project-trustflow-[a-z0-9]+(?:-team-kenji)?\.vercel\.app$/

function originAllowed(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin)
}

/**
 * The CORS headers for one request. Call it per request — the value depends on
 * who asked, which is the whole difference from the constant it replaces.
 *
 * `Vary: Origin` because the reply now differs by origin: without it a cache
 * in front of this function could serve one origin's allowance to another, and
 * the fix would look like the policy failing rather than a cache doing its job.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    Vary: 'Origin',
  }
  const origin = req.headers.get('Origin')
  if (origin && originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}
