// A verified owner creates a draft through the real New contract form, against
// the live E2E backend, with no network stubs.
//
// WHY THIS EXISTS
// Since the C5 cutover (row 2, migration B), the browser creates contracts only
// through rpc/create_entry_contract. Every other suite creates its fixture by
// calling that RPC directly, and new-contract-form.spec.js stubs the network,
// so nothing proved that the actual form reaches the RPC and that what it
// returns is a working invitation.
//
// WHAT IT CHECKS
//   1. Send Invite issues one POST to rpc/create_entry_contract, answered 200
//      with status "created" and a contract owned by the signed-in account.
//   2. The stored row (read back with the owner's token) carries the typed
//      terms unchanged, and the server-derived fields are the server's.
//   3. The invite link the form shows opens the guest invitation with those
//      terms. This is the bearer flow only: opening the link proves nothing
//      about the counterpart's account, and C3's verified-account matching is
//      a separate path, not exercised here.
//
// WRITES one ordinary draft on the E2E project, as the other live suites do.

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';

test.skip(LIVE_SKIPPED, 'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const LAST_EMAIL_KEY = 'tf_last_earner_email';

test('a verified owner creates a draft through the real form and gets a working invite', async ({ page, request, browser }) => {
  const { session, token, userId } = await getEarnerSession(request);
  const marker = `Live form create ${Date.now()}`;
  const terms = {
    earnerName: 'Live Form Owner',
    clientEmail: 'live.form.guest@example.test',
    amount: '4321',
    dod: ['First live deliverable', 'Second live deliverable'],
  };

  await page.addInitScript(({ key, value, emailKey, email }) => {
    localStorage.setItem('tf_onboarded', '1');
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

  const rpc = page.waitForResponse(r => r.url().includes('/rest/v1/rpc/create_entry_contract')
    && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Send Invite' }).click();
  const response = await rpc;

  // 1. The real server response.
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body?.status).toBe('created');
  const contract = body?.contract;
  expect(contract?.id).toBeTruthy();
  expect(contract?.earner_user_id).toBe(userId);
  expect(contract?.invite_token).toBeTruthy();
  const sent = response.request().postDataJSON();
  expect(Object.keys(sent).sort()).toEqual(['p_amount_minor', 'p_currency', 'p_deadline', 'p_dod',
    'p_earner_display_name', 'p_invited_hirer_email', 'p_performed_by', 'p_project_name']);

  // 2. The stored row, read back as the owner.
  const read = await request.get(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${contract.id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  expect(read.status()).toBe(200);
  const [row] = await read.json();
  expect(row).toBeTruthy();
  expect(row.earner_user_id).toBe(userId);
  expect(row.project_name).toBe(marker);
  expect(row.earner_display_name).toBe(terms.earnerName);
  expect(row.invited_hirer_email).toBe(terms.clientEmail);
  expect(row.dod).toEqual(terms.dod);
  expect(row.amount_minor).toBe(Number(terms.amount));
  expect(row.currency).toBe('JPY');
  expect(row.state).toBe('AWAITING_ACCEPTANCE');
  expect(row.invite_token).toBe(contract.invite_token);
  expect(row.invite_token_used_at).toBeNull();
  expect(row.hirer_user_id).toBeNull();
  expect(row.hirer_email).toBeNull();
  expect(row.counterpart_account_id).toBeNull();
  expect(row.dod_hash).toBeNull();

  // The form shows the invite link for exactly that token.
  await expect(page.getByText(new RegExp(`token=${contract.invite_token}`))).toBeVisible({ timeout: 15_000 });

  // 3. A separate, signed-out browser opens the invite: the guest bearer flow.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await guestPage.goto(`/?token=${contract.invite_token}`);
  await expect(guestPage.getByText(marker).first()).toBeVisible({ timeout: 15_000 });
  await expect(guestPage.getByText(terms.earnerName).first()).toBeVisible();
  await expect(guestPage.getByText('¥4,321').first()).toBeVisible();
  for (const item of terms.dod) await expect(guestPage.getByText(item)).toBeVisible();
  await guest.close();
});
