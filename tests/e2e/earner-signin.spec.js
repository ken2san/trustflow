// Returning Earner sign-in.
//
// WHAT IS AND IS NOT AUTOMATED
// The code itself arrives by email, and nothing here can read an inbox — the
// same limitation the anonymous→permanent flow has. So the two halves of
// "a returning Earner gets their contracts back" are proved separately:
//
//   · that a restored session lists that Earner's contracts through RLS, by
//     seeding a real session into a fresh browser exactly as supabase-js
//     stores it. This is the half that actually matters: it is what happens
//     after the code is accepted.
//   · that the request leg refuses to create accounts and rejects unknown
//     addresses, against the live auth API.
//
// Typing a real emailed code stays a manual step.
//
// Requires a verified Earner:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import {
  SUPABASE_URL,
  SUPABASE_KEY,
  EARNER_EMAIL,
  EARNER_PASSWORD,
  CONFIGURED,
  LIVE_SKIPPED,
} from './liveEnv.js';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

/** supabase-js keys its stored session by the project ref in the URL. */
const STORAGE_KEY = CONFIGURED
  ? `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  : 'sb-unknown-auth-token';

const LAST_EMAIL_KEY = 'tf_last_earner_email';

async function api(request, path, { method = 'POST', token, body, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  // Always present a bearer: a user's token when there is one, otherwise the anon
  // key — which is what supabase-js does, and what these tests' own comments mean
  // by "anon key only". Sending `apikey` alone worked on the older project but is
  // refused at the gateway by a newer one (UNAUTHORIZED_NO_AUTH_HEADER), which
  // would turn every negative-auth assertion into a pass for the wrong reason.
  headers.Authorization = `Bearer ${token ?? SUPABASE_KEY}`;
  if (prefer) headers.Prefer = prefer;
  const response = await request.fetch(`${SUPABASE_URL}${path}`, { method, headers, data: body });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status(), body: parsed };
}

// The header's "Sign in" and the panel's submit button share a name, so both
// are addressed by region rather than by text alone.
const headerSignIn = page => page.getByRole('navigation').getByRole('button', { name: /^Sign in$/i });
const submitSignIn = page => page.getByRole('main').getByRole('button', { name: /^Sign in$/i });

/** A real session for the QA Earner, in the shape supabase-js persists.
 *  Shared and disk-cached across suites — see earnerSession.js. */
async function earnerSession(request) {
  const { session } = await getEarnerSession(request);
  return session;
}

/** Start the browser already holding that session, as a returning visit would. */
async function seedSession(page, session) {
  await page.addInitScript(
    ({ key, value, emailKey, email }) => {
      localStorage.setItem('tf_onboarded', '1');
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(emailKey, email);
    },
    { key: STORAGE_KEY, value: session, emailKey: LAST_EMAIL_KEY, email: session.user.email },
  );
}

// ── The regression that matters ─────────────────────────────────────────────

test('a returning Earner with a restored session sees their existing contracts', async ({ page, request }) => {
  const session = await earnerSession(request);

  // A contract that definitely belongs to this Earner and is easy to find
  // among the others.
  const marker = `Returning Earner Probe ${Date.now()}`;
  const created = await api(request, '/rest/v1/contracts', {
    token: session.access_token,
    prefer: 'return=representation',
    body: {
      earner_user_id: session.user.id,
      earner_display_name: 'Returning Earner',
      project_name: marker,
      dod: ['deliverable'],
      amount_jpy: 12345,
      amount_minor: 12345,
      currency: 'JPY',
      invited_hirer_email: 'returning.client@example.test',
    },
  });
  expect(created.status).toBe(201);

  // A completely fresh browser context that happens to hold the session.
  await seedSession(page, session);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(marker)).toBeVisible({ timeout: 20_000 });
  // Signed in, so the header offers the way out rather than the way in.
  await expect(page.getByRole('button', { name: /Sign out/i })).toBeVisible();
  await expect(page.getByText('No contracts yet.')).toHaveCount(0);
});

test('signing out clears the list and offers the way back in', async ({ page, request }) => {
  // A session of its own, not the shared cached one. Signing out revokes the
  // session server-side — correctly, since signing out of a device should end
  // that device's session — and revoking the shared one would break every
  // suite that runs afterwards.
  const { status, body: session } = await api(request, '/auth/v1/token?grant_type=password', {
    body: { email: EARNER_EMAIL, password: EARNER_PASSWORD },
  });
  expect(status, `earner sign-in failed: ${JSON.stringify(session)}`).toBe(200);
  await seedSession(page, session);
  await page.goto('/');

  await expect(page.getByRole('button', { name: /Sign out/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /Sign out/i }).click();

  await expect(headerSignIn(page)).toBeVisible({ timeout: 15_000 });
});

// ── The three states an empty list can mean ─────────────────────────────────

test('a first-time visitor is invited to create, not told to sign in again', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.route('**/rest/v1/contracts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]',
    });
  });
  await page.goto('/');

  await expect(page.getByText('No contracts yet.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('You are signed out.')).toHaveCount(0);
});

test('a lapsed session says the contracts are still there, and whose they are', async ({ page }) => {
  // The browser remembers who it was, but holds no usable session — which is
  // what an expired refresh token looks like after supabase-js gives up on it.
  await page.addInitScript(({ emailKey }) => {
    localStorage.setItem('tf_onboarded', '1');
    localStorage.setItem(emailKey, 'returning@example.test');
  }, { emailKey: LAST_EMAIL_KEY });
  await page.route('**/rest/v1/contracts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]',
    });
  });
  await page.goto('/');

  await expect(page.getByText('You are signed out.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('returning@example.test')).toBeVisible();
  // Never "no contracts yet" — that would tell someone their work is gone.
  await expect(page.getByText('No contracts yet.')).toHaveCount(0);
});

// ── The sign-in screen ──────────────────────────────────────────────────────

test('the sign-in screen prefills the remembered address after a lapse', async ({ page }) => {
  await page.addInitScript(({ emailKey }) => {
    localStorage.setItem('tf_onboarded', '1');
    localStorage.setItem(emailKey, 'returning@example.test');
  }, { emailKey: LAST_EMAIL_KEY });
  await page.goto('/');

  await headerSignIn(page).click();

  await expect(page.getByRole('heading', { name: /Sign in again/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Email address')).toHaveValue('returning@example.test');
});

test('a rejected code is reported without losing the entered address', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));

  await page.route('**/auth/v1/otp*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({}),
    });
  });
  await page.route('**/auth/v1/verify*', async (route) => {
    await route.fulfill({
      status: 403, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 403, error_code: 'otp_expired', msg: 'Invalid token' }),
    });
  });

  await page.goto('/');
  await headerSignIn(page).click();
  await page.getByLabel('Email address').fill('returning@example.test');
  await page.getByRole('button', { name: /Send me a code/i }).click();

  await expect(page.getByLabel('Sign-in code')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Sign-in code').fill('000000');
  await submitSignIn(page).click();

  await expect(page.getByRole('alert')).toContainText(/not correct/i, { timeout: 15_000 });
  // Still on the code step, address intact — the code is retryable.
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  await expect(page.getByText('returning@example.test')).toBeVisible();
});

test('an unknown address is refused without confirming whether it exists', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.route('**/auth/v1/otp*', async (route) => {
    await route.fulfill({
      status: 422, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }),
    });
  });

  await page.goto('/');
  await headerSignIn(page).click();
  await page.getByLabel('Email address').fill('nobody@example.test');
  await page.getByRole('button', { name: /Send me a code/i }).click();

  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  // No code step: nothing was sent.
  await expect(page.getByLabel('Sign-in code')).toHaveCount(0);
});

// ── The request leg, against the live auth API ──────────────────────────────

test('sign-in cannot create an account', async ({ request }) => {
  // shouldCreateUser: false is what stops a typo minting a second, empty
  // account that owns nothing — which would look like vanished contracts.
  const { status, body } = await api(request, '/auth/v1/otp', {
    body: { email: 'no-such-earner-4c1f@example.test', create_user: false },
  });

  expect(status).toBeGreaterThanOrEqual(400);
  expect(['otp_disabled', 'email_address_invalid']).toContain(body.error_code);

  // And no account was created for it.
  const check = await api(request, '/auth/v1/otp', {
    body: { email: 'no-such-earner-4c1f@example.test', create_user: false },
  });
  expect(check.status).toBeGreaterThanOrEqual(400);
});
