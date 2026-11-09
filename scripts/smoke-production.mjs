#!/usr/bin/env node
// What is actually serving, right now, checked against what should be.
//
//   npm run smoke:prod
//
// WHY THIS EXISTS
// On 2026-11-06 two defects reached production and neither was visible to any
// suite in this repository. 416 unit tests, 142 browser tests and 22 live API
// checks were green through both.
//
//   1. CAPTCHA protection was switched on and the frontend sent no token, so
//      every auth endpoint answered 400 and nobody could sign in. The suite
//      that covers sign-in mocks the auth surface wholesale.
//   2. An upsert shipped without the UPDATE privilege it needs, so every
//      snapshot save after the first answered "permission denied". The
//      container check that verifies the constraints runs as `postgres`,
//      where privileges do not exist.
//
// Both were found by hand, by loading the deployed site and reading what came
// back. This is that, made repeatable. It is deliberately small: it checks
// the handful of things that are true of a healthy deployment and that no
// other check looks at, because they live in the gap between the build and
// the running system.
//
// READ-ONLY, AND IT MUST STAY THAT WAY
// Nothing here creates a user, writes a row, or sends mail. The OTP probe uses
// an address that cannot exist, which Supabase answers without sending
// anything — the one shape of auth probe that costs nothing from a mail quota
// an earlier review found to be drainable. **Do not probe /auth/v1/signup**:
// with CAPTCHA off it creates an anonymous user, measured the hard way.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.TF_PROD_URL ?? 'https://project-trustflow.vercel.app';

/** Read the production credentials the app itself ships with. */
function productionEnv() {
  const text = readFileSync(path.join(REPO, '.env'), 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1 || line.trim().startsWith('#')) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`${ok ? ' ok  ' : 'FAIL '} ${label}${detail ? `  — ${detail}` : ''}`);
}

const env = productionEnv();
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

console.log(`\nTrustFlow production smoke — ${APP}\n`);

// ── 1. The deployed bundle ──────────────────────────────────────────────────
const html = await fetch(APP).then(r => r.text());
const asset = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
check('the site serves an app bundle', Boolean(asset), asset ?? 'no asset reference in the HTML');

let bundle = '';
if (asset) {
  bundle = await fetch(`${APP}${asset}`).then(r => r.text());
  check('the bundle points at the production project',
    bundle.includes(new URL(SUPABASE_URL).hostname),
    new URL(SUPABASE_URL).hostname);
}

// The captcha site key has to survive the build, and must not be a test key.
// An unset variable renders no widget at all, which is indistinguishable from
// a healthy page until someone tries to sign in — which is how the outage
// presented.
const TEST_SITE_KEYS = ['1x00000000000000000000AA', '2x00000000000000000000AB',
  '1x00000000000000000000BB', '3x00000000000000000000FF'];
const siteKey = bundle.match(/"(0x4[A-Za-z0-9_-]{20,})"/)?.[1] ?? null;
const usesTestKey = TEST_SITE_KEYS.some(k => bundle.includes(`sitekey:"${k}"`) || bundle.includes(`="${k}"`));

// ── 2. Auth, as the app actually reaches it ────────────────────────────────
async function authProbe(body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// An address that cannot exist, with create_user false: Supabase answers
// without sending mail either way, so this costs nothing and still tells us
// whether a challenge stands in front of the endpoint.
const probe = await authProbe({
  email: 'smoke-probe@example.invalid', create_user: false,
});
const captchaEnforced = (probe.body.error_code ?? probe.body.code) === 'captcha_failed';

check('the sign-in endpoint answers', probe.status > 0, `HTTP ${probe.status}`);

// The two halves have to agree. A site key with no enforcement is a widget
// nobody checks; enforcement with no site key is the outage.
if (captchaEnforced) {
  check('CAPTCHA is enforced AND the bundle carries a site key', Boolean(siteKey),
    siteKey ? `site key ${siteKey.slice(0, 10)}…` : 'protection is ON and the bundle has no key — sign-in is dead');
  check('the site key is not one of Cloudflare\'s test keys', !usesTestKey);
} else {
  check('CAPTCHA is off and the bundle does not pretend otherwise', true,
    siteKey ? 'a site key is present but unenforced — harmless, and the widget renders' : 'no key, no enforcement');
}

// ── 3. The functions that should be serving, and the ones that should not ──
// Retired 2026-11-06 with the payment surface. A redeploy would be a silent
// return of the only endpoints that could move money or set a terminal state.
const RETIRED = ['create-payment-intent', 'capture-payment', 'cancel-payment',
  'send-acceptance-email', 'timestamp-event'];
const LIVE = ['validate-invite-token', 'log-event', 'guest-contract-events',
  'reissue-guest-access'];

/**
 * Is this slug deployed?
 *
 * NOT by status code. The first version of this check read a 404 as "not
 * deployed" and reported `reissue-guest-access` missing on its first run —
 * that function is serving, and answers 404 `contract_not_found` to a request
 * with no contract in it. A live function and an absent one both return 404,
 * which is precisely the "measuring the wrong signal" failure this script
 * exists to catch, reproduced inside the script within minutes of writing it.
 *
 * The gateway's refusal has its own shape and that is what gets read:
 *
 *   absent:  {"code":"NOT_FOUND","message":"Requested function was not found"}
 *   serving: anything the function itself chose to say
 */
async function deployed(fn) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await r.text();
  const gatewayMiss = r.status === 404 && /"code"\s*:\s*"NOT_FOUND"/.test(body);
  return { deployed: !gatewayMiss, status: r.status, body: body.slice(0, 80) };
}

for (const fn of LIVE) {
  const r = await deployed(fn);
  check(`${fn} is serving`, r.deployed, `HTTP ${r.status} ${r.body}`);
}

for (const fn of RETIRED) {
  const r = await deployed(fn);
  check(`${fn} stays retired`, !r.deployed, `HTTP ${r.status} ${r.body}`);
}

// ── The published agent protocol ────────────────────────────────────────────
//
// An outside agent cannot accept an agreement in any currency but JPY without
// the shown-terms digest, and the only statement of that algorithm is the
// document served here. If it stops being served, a client written against it
// has no way to find out why its acceptances started failing — so this is a
// release check, not a nicety. One fetch each, no retries.
//
// The content check is deliberately thin: the reference digest. It is the one
// string a client must reproduce byte for byte, and the unit tests already
// assert the server agrees with it; here we only care that the file reaching
// the web is the one that was tested.
const REFERENCE_DIGEST =
  '438a61235d399d7dbf60fcc98882eb89065dbc55ad53d5e7b39aef96ab1f9aeb';

for (const [path, mustContain, what] of [
  ['/llms.txt', '/agent-protocol.md', 'points an agent at the protocol'],
  ['/agent-protocol.md', REFERENCE_DIGEST, 'carries the reference digest'],
]) {
  const r = await fetch(`${APP}${path}`);
  const body = r.ok ? await r.text() : '';
  check(`${path} is served and ${what}`,
    r.ok && body.includes(mustContain),
    `HTTP ${r.status}, ${body.length} bytes`);
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length} checks, ${failed.length} failed\n`);
process.exit(failed.length === 0 ? 0 : 1);
