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
 * EXACT origins only. No pattern — and the reason is the whole lesson of this
 * module's first version.
 *
 * That version matched
 * `^https://project-trustflow-[a-z0-9]+(?:-team-kenji)?\.vercel\.app$`, which
 * looked like "this project's previews" and was not. Codex's review found both
 * halves wrong:
 *
 *   - it REJECTED the real branch alias, because Vercel's documented form is
 *     `<project>-git-<branch>-<scope>.vercel.app` and `git-main` contains a
 *     hyphen that `[a-z0-9]+` cannot match. So the one preview URL a developer
 *     actually keeps open was the one it refused;
 *   - and it ACCEPTED `https://project-trustflow-attacker.vercel.app`, because
 *     the team suffix was optional. That is also the shape of the ROOT alias of
 *     a separate project named `project-trustflow-attacker`, and
 *     `<name>.vercel.app` is claimed globally, first come first served.
 *
 * The second is the part worth remembering: **a name prefix is not ownership.**
 * Requiring `-team-kenji` does not fix it either, because anyone may create a
 * project called `project-trustflow-x-team-kenji` in their own account and get
 * that exact root alias. No pattern over `vercel.app` can establish that a
 * hostname belongs to this project, so this module stops trying.
 *
 * WHAT WAS VERIFIED, AND WHAT WAS NOT. The five `vercel.app` entries below
 * were read back from the Vercel API for project
 * `prj_T6yXoI5wDvJKNfzlmgWAyF4tErAm` on 2026-11-09: `list_aliases` returned
 * exactly those five as aliases of this project, and `list_project_domains`
 * confirmed there is no custom domain. That is a readback at one moment, not a
 * standing guarantee — an alias can be moved or released later, and nothing
 * here rechecks.
 *
 * The two loopback entries were verified against nothing of the sort. They are
 * `playwright.config.js`'s `baseURL` and the dev server, and what makes them
 * safe is that they resolve only on the machine doing the asking, not any claim
 * about this project.
 *
 * And `TF_ALLOWED_ORIGINS` (below) is **not verified at all** — see its own
 * note. Codex's re-review found this paragraph claiming "every entry was
 * verified to belong to this project", which was true of five of them.
 */
const ALLOWED_ORIGINS = new Set([
  // Production.
  'https://project-trustflow.vercel.app',
  'https://project-trustflow-team-kenji.vercel.app',
  // The stable branch alias for main — the preview URL that does not change
  // per deploy, and the one Codex's finding 1 was about.
  'https://project-trustflow-git-main-team-kenji.vercel.app',
  // Older aliases, still owned by this project and still resolving.
  'https://trustflow-team-kenji.vercel.app',
  'https://trustflow-git-main-team-kenji.vercel.app',
  // The dev server and the Playwright `baseURL` (`playwright.config.js`).
  // Both forms, because a browser sends whichever host was typed.
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

/**
 * Extra exact origins, for the per-commit preview URLs this cannot predict.
 *
 * A deployment URL like `https://project-trustflow-p8zf16a6m-team-kenji.vercel.app`
 * changes on every push, so the only way to match it by shape is to accept a
 * namespace — which is the defect above. The opt-in is therefore explicit: set
 * `TF_ALLOWED_ORIGINS` on the function to a comma-separated list of exact
 * origins when one is actually needed.
 *
 * **This is a deliberate trade, not an oversight.** A developer opening a
 * per-commit preview against the live backend has to either use the branch
 * alias above, run the dev server, or add that one origin.
 *
 * **NOTHING HERE VALIDATES OWNERSHIP OF WHAT IS SET.** Whatever this variable
 * names is allowed, including an origin belonging to someone else: the check is
 * exact string membership, not a claim about who controls the hostname. That
 * makes the variable's value part of the security configuration, to be reviewed
 * when it is set and removed when the preview it was for is gone. The hardcoded
 * list above is the part with a verification behind it; this is the part with an
 * operator behind it.
 *
 * Read per call rather than once at module load, so the unit tests can exercise
 * the opt-in without module isolation. A module-load read would still be
 * testable with `vi.resetModules()` and the environment set first — the earlier
 * version of this note said it would be untestable, which Codex corrected. The
 * honest reason is that per-call needs no test harness machinery at all, and an
 * untested security branch is the one that is wrong.
 *
 * Read through `globalThis` because this module is imported by Deno Edge
 * Functions and by the Node test runner. A bare `Deno.env` reference would
 * throw at import time under vitest, which is how the first version of this
 * broke.
 */
function extraOrigins(): Set<string> {
  const g = globalThis as {
    Deno?: { env?: { get?: (k: string) => string | undefined } }
    process?: { env?: Record<string, string | undefined> }
  }
  const raw = g.Deno?.env?.get?.('TF_ALLOWED_ORIGINS')
    ?? g.process?.env?.TF_ALLOWED_ORIGINS
    ?? ''
  return new Set(
    raw.split(',').map(value => value.trim()).filter(value => value.length > 0),
  )
}

function originAllowed(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || extraOrigins().has(origin)
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
