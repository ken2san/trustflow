// A verified owner creates a draft through the real New contract form, against
// the live E2E backend, with no network stubs.
//
// WHY THIS EXISTS
// Since the C5 cutover (row 2, migration B), the browser creates contracts only
// through rpc/create_entry_contract. Every other suite creates its fixture by
// calling that RPC directly, and new-contract-form.spec.js stubs the network,
// so nothing proved that the actual form reaches the RPC and that what it
// shows is a working invitation.
//
// WHAT IT CHECKS
//   0. It writes only to the authorized E2E project: the configured target is
//      checked before a session is acquired, and the served app's backend
//      before the session is seeded or anything is submitted.
//   1. One Send Invite issues exactly one create request (every matching
//      request is counted, from before the click until the flow has settled)
//      and no legacy direct insert. The answer is 200 "created", owned by the
//      signed-in account, with each sent parameter equal to what was typed.
//   2. Independently of that response, the owner can see exactly one draft
//      carrying this run's unique marker, with the typed terms unchanged and
//      the server-derived fields the server's.
//   3. The invitation URL the form actually displays is the one opened by a
//      separate signed-out browser, and it shows those terms. This is the
//      guest bearer flow only; C3's verified-account matching is a separate
//      path, not exercised here.
//
// The invite token is a bearer credential: it is compared only as booleans and
// never placed in an assertion message, a locator or a navigation diagnostic.
//
// WRITES one ordinary draft on the E2E project, as the other live suites do.

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';
import { assertE2EProject } from '../../scripts/lib/e2eGuard.mjs';

test.skip(LIVE_SKIPPED, 'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

const STORAGE_KEY = `sb-${new URL(SUPABASE_URL ?? 'https://unset.invalid').hostname.split('.')[0]}-auth-token`;
const LAST_EMAIL_KEY = 'tf_last_earner_email';
const CREATE_PATH = '/rest/v1/rpc/create_entry_contract';

/** Navigate without letting a failure echo a URL that carries a bearer token. */
async function gotoRedacted(page, url) {
  try {
    return await page.goto(url);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- the cause would carry the token-bearing URL
    throw new Error(`navigation to the invitation failed: ${String(error?.message ?? error).replace(/token=[^&\s"']+/g, 'token=<redacted>')}`);
  }
}

test('a verified owner creates exactly one draft through the real form and its shown invite works', async ({ page, request, browser }) => {
  // 0a. The configured target must be the authorized E2E project before any session exists.
  assertE2EProject(SUPABASE_URL);
  const backendOrigin = new URL(SUPABASE_URL).origin;

  // 0b. The served app must call that same backend before it gets a session or a submit.
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto('/');
  const appBackend = await page.evaluate(() => window.__TF_SUPABASE_URL__ ?? null);
  expect(appBackend, 'the served app must call the E2E backend the tests use').toBe(SUPABASE_URL);
  assertE2EProject(appBackend);

  const { session, token, userId } = await getEarnerSession(request);
  const marker = `Live form create ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const terms = {
    earnerName: 'Live Form Owner',
    clientEmail: 'live.form.guest@example.test',
    amount: '4321',
    dod: ['First live deliverable', 'Second live deliverable'],
  };

  await page.addInitScript(({ key, value, emailKey, email }) => {
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem(emailKey, email);
  }, { key: STORAGE_KEY, value: session, emailKey: LAST_EMAIL_KEY, email: session.user.email });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /New contract/ }).first().click();
  await page.getByPlaceholder('Shown to your client').fill(terms.earnerName);
  await page.getByPlaceholder('We send you a code to confirm it').fill(session.user.email);
  await page.getByPlaceholder('Where this invite is addressed').fill(terms.clientEmail);
  await page.getByPlaceholder(/Mobile app redesign/).fill(marker);
  await page.getByLabel('Amount').fill(terms.amount);
  await page.getByLabel('What counts as complete').fill(terms.dod.join('\n'));

  // 1. Count every create-shaped request from before the click until the flow settles.
  const createRequests = [];
  const legacyInserts = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    let u;
    try { u = new URL(r.url()); } catch { return; }
    if (u.origin === backendOrigin && u.pathname === CREATE_PATH) createRequests.push(r);
    if (u.origin === backendOrigin && u.pathname === '/rest/v1/contracts') legacyInserts.push(r);
  });
  const firstResponse = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return r.request().method() === 'POST' && u.origin === backendOrigin && u.pathname === CREATE_PATH;
  }, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Send Invite' }).click();
  const response = await firstResponse;

  // The flow is complete when the form shows its invitation, and settled when the network is quiet.
  const shownLink = page.locator('p.font-mono').filter({ hasText: '?token=' }).first();
  await expect(shownLink).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');

  expect(createRequests.length, 'create requests issued by one Send Invite').toBe(1);
  expect(legacyInserts.length, 'legacy direct inserts into contracts').toBe(0);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body?.status).toBe('created');
  const contract = body?.contract;
  expect(contract?.id).toBeTruthy();
  expect(contract?.earner_user_id).toBe(userId);
  expect(Boolean(contract?.invite_token), 'the response carries an invite token').toBe(true);

  const sent = response.request().postDataJSON();
  expect(Object.keys(sent).sort()).toEqual(['p_amount_minor', 'p_currency', 'p_deadline', 'p_dod',
    'p_earner_display_name', 'p_invited_hirer_email', 'p_performed_by', 'p_project_name']);
  expect(sent).toEqual({
    p_project_name: marker, p_dod: terms.dod, p_amount_minor: Number(terms.amount), p_currency: 'JPY',
    p_deadline: null, p_invited_hirer_email: terms.clientEmail, p_performed_by: 'creator',
    p_earner_display_name: terms.earnerName,
  });

  // 2. Independently: exactly one owner-visible draft carries this run's marker.
  const read = await request.get(
    `${SUPABASE_URL}/rest/v1/contracts?project_name=eq.${encodeURIComponent(marker)}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  expect(read.status()).toBe(200);
  const rows = await read.json();
  expect(rows.length, 'owner-visible drafts carrying this run\'s marker').toBe(1);
  const [row] = rows;
  expect(row.id).toBe(contract.id);
  expect(row.earner_user_id).toBe(userId);
  expect(row.project_name).toBe(marker);
  expect(row.earner_display_name).toBe(terms.earnerName);
  expect(row.invited_hirer_email).toBe(terms.clientEmail);
  expect(row.dod).toEqual(terms.dod);
  expect(row.amount_minor).toBe(Number(terms.amount));
  expect(row.currency).toBe('JPY');
  expect(row.deadline).toBeNull();
  expect(row.performed_by).toBe('creator');
  expect(row.state).toBe('AWAITING_ACCEPTANCE');
  expect(row.invite_token === contract.invite_token, 'stored invite token equals the returned one').toBe(true);
  expect(row.invite_token_used_at).toBeNull();
  expect(row.hirer_user_id).toBeNull();
  expect(row.hirer_email).toBeNull();
  expect(row.counterpart_account_id).toBeNull();
  expect(row.dod_hash).toBeNull();

  // 3. The invitation URL as displayed: right origin and route, and carrying exactly this token.
  const displayed = (await shownLink.innerText()).trim();
  let shown;
  try { shown = new URL(displayed); } catch { shown = null; }
  expect(shown !== null, 'the displayed invitation is a URL').toBe(true);
  expect(shown.origin, 'the displayed invitation points at the served app').toBe(new URL(page.url()).origin);
  expect(shown.pathname, 'the displayed invitation route').toBe('/');
  expect(shown.searchParams.get('token') === contract.invite_token,
    'the displayed invitation carries the created invite token').toBe(true);

  const guest = await browser.newContext();
  try {
    const guestPage = await guest.newPage();
    await guestPage.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
    await gotoRedacted(guestPage, displayed);
    await expect(guestPage.getByText(marker).first()).toBeVisible({ timeout: 15_000 });
    await expect(guestPage.getByText(terms.earnerName).first()).toBeVisible();
    await expect(guestPage.getByText('¥4,321').first()).toBeVisible();
    for (const item of terms.dod) await expect(guestPage.getByText(item)).toBeVisible();
  } finally {
    await guest.close();
  }
});
