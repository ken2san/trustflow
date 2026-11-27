// Offline browser regression harness for Row 6 owner credential UI lifecycle.
//
// Runs strictly offline against local Vite servers + mocked Supabase auth,
// REST, and Edge Function routes. Any unmocked request to the dummy Supabase
// origin (`http://127.0.0.1:54399`) is aborted and recorded as a test failure.
//
// SCOPE BOUNDARY
// - Covers real Chromium React effects, unmount cleanup, ModalDialog dismiss,
//   deal-switch keyed remount (`${contract.id}:${ownerUserId}`), default-off
//   gating, cross-tab sign-out via shared localStorage/BroadcastChannel, late
//   issue response discard, and mid-view refresh-failure -> expired home UX.
// - Does NOT replace live E2E verification of real Supabase GoTrue token
//   rotation, real RLS / Edge Function enforcement, or Vercel env parity.
// - Any live browser or expiry fixture writes are OUTSIDE the simulator 1/1/2
//   budget and require a separate approved budget.

import { test, expect } from '@playwright/test';

const SUPABASE_ORIGIN = 'http://127.0.0.1:54399';
const STORAGE_KEY = 'sb-127-auth-token';
const LAST_EMAIL_KEY = 'tf_last_earner_email';

const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_EMAIL = 'owner-offline@example.invalid';
const OTHER_OWNER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_OWNER_EMAIL = 'other-owner@example.invalid';
const DEAL_1_ID = '11111111-1111-4111-8111-111111111111';
const DEAL_2_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_1_ID = '33333333-3333-4333-8333-333333333333';
const GRANT_2_ID = '55555555-5555-4555-8555-555555555555';
const SECRET_1 = 'a'.repeat(64);
const SECRET_2 = 'b'.repeat(64);
const TOKEN_1 = `${GRANT_1_ID}.${SECRET_1}`;

const futureIso = (hours = 24) => new Date(Date.now() + hours * 3_600_000).toISOString();

const DEALS = [
  {
    id: DEAL_1_ID,
    earner_user_id: OWNER_ID,
    project_name: 'Row 6 Offline Deal One',
    dod: ['Deliver milestone one'],
    amount_jpy: null,
    amount_minor: 50000,
    currency: 'CAD',
    deadline: '2026-12-20',
    state: 'TERMS_ACCEPTED',
    performed_by: 'creator',
    earner_display_name: 'Offline Owner',
    invited_hirer_email: 'guest@example.invalid',
    hirer_email: 'guest@example.invalid',
    invite_token: null,
    invite_token_expires_at: null,
    invite_token_used_at: '2026-11-26T12:00:00.000Z',
    guest_access_token_expires_at: futureIso(24 * 60),
    created_at: '2026-11-25T12:00:00.000Z',
  },
  {
    id: DEAL_2_ID,
    earner_user_id: OWNER_ID,
    project_name: 'Row 6 Offline Deal Two',
    dod: ['Deliver milestone two'],
    amount_jpy: null,
    amount_minor: 75000,
    currency: 'CAD',
    deadline: '2026-12-25',
    state: 'TERMS_ACCEPTED',
    performed_by: 'creator',
    earner_display_name: 'Offline Owner',
    invited_hirer_email: 'guest2@example.invalid',
    hirer_email: 'guest2@example.invalid',
    invite_token: null,
    invite_token_expires_at: null,
    invite_token_used_at: '2026-11-26T13:00:00.000Z',
    guest_access_token_expires_at: futureIso(24 * 60),
    created_at: '2026-11-25T13:00:00.000Z',
  },
];

function makeSession({ expiresInSec = 3600, userId = OWNER_ID, email = OWNER_EMAIL } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: `offline-access-token-${userId}`,
    refresh_token: `offline-refresh-token-${userId}`,
    token_type: 'bearer',
    expires_in: expiresInSec,
    expires_at: nowSec + expiresInSec,
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      is_anonymous: false,
    },
  };
}

function fulfillJson(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
    body: JSON.stringify(body),
  });
}

async function seedOwnerSession(context, { expiresInSec = 3600 } = {}) {
  const session = makeSession({ expiresInSec });
  await context.addInitScript(({ key, value, emailKey, email }) => {
    localStorage.setItem('tf_onboarded', '1');
    // Seed only once per context so an explicit sign-out in one tab is not
    // re-seeded if another navigation occurs.
    if (!localStorage.getItem('tf_row6_seeded')) {
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(emailKey, email);
      localStorage.setItem('tf_row6_seeded', '1');
    }
  }, { key: STORAGE_KEY, value: session, emailKey: LAST_EMAIL_KEY, email: OWNER_EMAIL });
  return session;
}

/**
 * Install closed offline mocks on the BrowserContext (covering all tabs).
 * Any request to `SUPABASE_ORIGIN` not matched by a specific mock is aborted.
 */
async function installOfflineBackend(context, {
  initialGrantsByDeal = {},
  refreshOutcome = 'ok',
  onIssue = null,
} = {}) {
  const grantsByDeal = new Map([
    [DEAL_1_ID, [...(initialGrantsByDeal[DEAL_1_ID] ?? [])]],
    [DEAL_2_ID, [...(initialGrantsByDeal[DEAL_2_ID] ?? [])]],
  ]);
  const calls = { credentialActions: [], unexpected: [] };
  let signedOut = false;

  let failRefresh = refreshOutcome === 'fail';
  let refreshSessionOverride = null;

  await context.route(`${SUPABASE_ORIGIN}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        },
      });
    }

    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === '/auth/v1/user') {
      if (signedOut) return fulfillJson(route, { message: 'Invalid JWT' }, 401);
      return fulfillJson(route, makeSession().user, 200);
    }

    if (pathname === '/auth/v1/logout') {
      signedOut = true;
      return fulfillJson(route, {}, 204);
    }

    if (pathname === '/auth/v1/token') {
      if (failRefresh) {
        signedOut = true;
        return fulfillJson(route, {
          error: 'invalid_grant',
          error_description: 'Invalid Refresh Token: Refresh Token Not Found',
        }, 400);
      }
      return fulfillJson(route, refreshSessionOverride ?? makeSession(), 200);
    }

    if (pathname === '/rest/v1/contracts') {
      return fulfillJson(route, signedOut ? [] : DEALS, 200);
    }

    if (pathname === '/rest/v1/events') {
      return fulfillJson(route, [], 200);
    }

    if (pathname === '/rest/v1/runtime_snapshots') {
      return fulfillJson(route, [], 200);
    }

    if (pathname === '/functions/v1/manage-entry-agent-credential') {
      const body = req.postDataJSON() ?? {};
      calls.credentialActions.push({ action: body.action, contract_id: body.contract_id, id: body.id ?? null });
      const list = grantsByDeal.get(body.contract_id) ?? [];

      if (body.action === 'list') {
        return fulfillJson(route, { grants: list }, 200);
      }

      if (body.action === 'issue') {
        if (onIssue) return onIssue({ route, body, list, fulfillJson });
        const id = list.length === 0 ? GRANT_1_ID : GRANT_2_ID;
        const secret = list.length === 0 ? SECRET_1 : SECRET_2;
        const row = {
          status: 'issued',
          id,
          contract_id: body.contract_id,
          issuer_kind: 'owner_account',
          scopes: body.scopes,
          created_at: new Date().toISOString(),
          expires_at: body.expires_at,
          revoked_at: null,
        };
        list.push(row);
        grantsByDeal.set(body.contract_id, list);
        return fulfillJson(route, { grant: row, secret }, 201);
      }

      if (body.action === 'revoke') {
        const target = list.find(g => g.id === body.id);
        if (target) target.revoked_at = new Date().toISOString();
        return fulfillJson(route, { status: 'revoked' }, 200);
      }
    }

    calls.unexpected.push(`${req.method()} ${url.pathname}`);
    return route.abort();
  });

  return {
    calls,
    grantsByDeal,
    setFailRefresh: (v) => { failRefresh = v; },
    setRefreshSession: (session) => { refreshSessionOverride = session; },
  };
}

async function openDeal(page, dealName) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByText(dealName).click();
  await expect(page.getByRole('heading', { name: dealName, level: 1 })).toBeVisible({ timeout: 10_000 });
}

test('@flag-off default-off never mounts AgentCredentialsPanel or invokes manage-entry-agent-credential', async ({ context }) => {
  await seedOwnerSession(context);
  const { calls } = await installOfflineBackend(context);
  const page = await context.newPage();

  await openDeal(page, 'Row 6 Offline Deal One');

  await expect(page.getByRole('region', { name: 'Agent credentials' })).toHaveCount(0);
  await expect(page.getByText('Issue a new owner credential')).toHaveCount(0);
  expect(calls.credentialActions).toEqual([]);
  expect(calls.unexpected).toEqual([]);
});

test('@flag-on issue one-time reveal, dismiss discards secret, revoke updates list, and deal switch remounts cleanly', async ({ context }) => {
  await seedOwnerSession(context);
  const deal2Grant = {
    id: GRANT_2_ID,
    contract_id: DEAL_2_ID,
    issuer_kind: 'owner_account',
    scopes: ['read'],
    created_at: '2026-11-26T14:00:00.000Z',
    expires_at: futureIso(48),
    revoked_at: null,
  };
  const { calls } = await installOfflineBackend(context, {
    initialGrantsByDeal: { [DEAL_2_ID]: [deal2Grant] },
  });
  const page = await context.newPage();

  await openDeal(page, 'Row 6 Offline Deal One');
  const panel = page.getByRole('region', { name: 'Agent credentials' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No agent credentials issued for this agreement yet.')).toBeVisible();

  // Issue a read-scoped grant -> one-time reveal modal opens with token & clipboard warning.
  await panel.getByLabel('Read deal & receipt').check();
  await panel.getByRole('button', { name: 'Issue credential' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(TOKEN_1)).toBeVisible();
  await expect(dialog.getByText('Clear your clipboard after pasting.')).toBeVisible();

  // Keyboard & focus behavior: focus lands inside the modal dialog and Escape dismisses it.
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(TOKEN_1)).toHaveCount(0);

  // Revoke updates the grant row to revoked.
  await expect(panel.getByText('33333333…')).toBeVisible();
  await panel.getByRole('button', { name: 'Revoke' }).click();
  await expect(panel.getByText('revoked', { exact: true })).toBeVisible();

  // Deal switch remounts panel (`key="${contract.id}:${ownerUserId}"`) with Deal 2's grant only.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Row 6 Offline Deal Two').click();
  await expect(page.getByRole('heading', { name: 'Row 6 Offline Deal Two', level: 1 })).toBeVisible();
  await expect(panel.getByText('55555555…')).toBeVisible();
  await expect(panel.getByText('33333333…')).toHaveCount(0);
  expect(calls.unexpected).toEqual([]);
});

test('@flag-on cross-tab sign-out immediately clears open reveal & owner agreement and lands on anonymous home', async ({ context }) => {
  await seedOwnerSession(context);
  const { calls } = await installOfflineBackend(context);

  const tabA = await context.newPage();
  await openDeal(tabA, 'Row 6 Offline Deal One');
  const panel = tabA.getByRole('region', { name: 'Agent credentials' });
  await panel.getByLabel('Read deal & receipt').check();
  await panel.getByRole('button', { name: 'Issue credential' }).click();
  await expect(tabA.getByRole('dialog').getByText(TOKEN_1)).toBeVisible();

  // Tab B signs out explicitly (clears remembered email + broadcasts SIGNED_OUT).
  const tabB = await context.newPage();
  await tabB.goto('/');
  await expect(tabB.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  await tabB.getByRole('button', { name: /Sign out/i }).click();

  // Tab A immediately clears the reveal modal, unmounts the panel, and lands on anonymous home (not expired).
  await expect(tabA.getByRole('dialog')).toHaveCount(0);
  await expect(tabA.getByText(TOKEN_1)).toHaveCount(0);
  await expect(tabA.getByRole('region', { name: 'Agent credentials' })).toHaveCount(0);
  await expect(tabA.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible();
  await expect(tabA.getByText(OWNER_EMAIL)).toHaveCount(0);
  expect(calls.unexpected).toEqual([]);
});

test('@flag-on late issue resolving after cross-tab sign-out never reveals secret or auto-revokes', async ({ context }) => {
  await seedOwnerSession(context);
  let releaseIssue;
  let issueStarted;
  const issueGate = new Promise((resolve) => { releaseIssue = resolve; });
  const issueArrived = new Promise((resolve) => { issueStarted = resolve; });

  const { calls } = await installOfflineBackend(context, {
    onIssue: async ({ route, body, list, fulfillJson: reply }) => {
      issueStarted();
      await issueGate;
      const row = {
        status: 'issued',
        id: GRANT_1_ID,
        contract_id: body.contract_id,
        issuer_kind: 'owner_account',
        scopes: body.scopes,
        created_at: new Date().toISOString(),
        expires_at: body.expires_at,
        revoked_at: null,
      };
      list.push(row);
      return reply(route, { grant: row, secret: SECRET_1 }, 201);
    },
  });

  const tabA = await context.newPage();
  await openDeal(tabA, 'Row 6 Offline Deal One');
  const panel = tabA.getByRole('region', { name: 'Agent credentials' });
  await panel.getByLabel('Read deal & receipt').check();
  await panel.getByRole('button', { name: 'Issue credential' }).click();
  await issueArrived;

  // Tab B signs out while Tab A's issue request is still in flight.
  const tabB = await context.newPage();
  await tabB.goto('/');
  await expect(tabB.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  await tabB.getByRole('button', { name: /Sign out/i }).click();

  await expect(tabA.getByRole('region', { name: 'Agent credentials' })).toHaveCount(0);

  // Release the delayed 201 issue response carrying SECRET_1.
  releaseIssue();
  await tabA.waitForTimeout(300);

  await expect(tabA.getByRole('dialog')).toHaveCount(0);
  await expect(tabA.getByText(TOKEN_1)).toHaveCount(0);
  expect(calls.credentialActions.filter(c => c.action === 'revoke')).toEqual([]);
  expect(calls.unexpected).toEqual([]);
});

test('@flag-on session refresh failure mid-view clears owner panel and lands on expired home with remembered email', async ({ context }) => {
  await seedOwnerSession(context, { expiresInSec: 3600 });
  const { calls, setFailRefresh } = await installOfflineBackend(context);

  const page = await context.newPage();
  await openDeal(page, 'Row 6 Offline Deal One');
  await expect(page.getByRole('region', { name: 'Agent credentials' })).toBeVisible();

  // Expire the stored access token mid-view while keeping tf_last_earner_email,
  // then trigger supabase-js's visibilitychange auto-refresh tick against a
  // mocked 400 invalid_grant refresh failure.
  setFailRefresh(true);
  await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    parsed.expires_at = Math.floor(Date.now() / 1000) - 10;
    localStorage.setItem(key, JSON.stringify(parsed));
    document.dispatchEvent(new Event('visibilitychange'));
  }, STORAGE_KEY);

  await expect(page.getByRole('region', { name: 'Agent credentials' })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('You are signed out.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(OWNER_EMAIL)).toBeVisible();
  expect(calls.unexpected).toEqual([]);
});

test('@flag-on cross-tab switch to a second verified user immediately clears owner reveal and agreement', async ({ context }) => {
  await seedOwnerSession(context, { expiresInSec: 3600 });
  const { calls, setRefreshSession } = await installOfflineBackend(context);

  const tabA = await context.newPage();
  await openDeal(tabA, 'Row 6 Offline Deal One');
  const panel = tabA.getByRole('region', { name: 'Agent credentials' });
  await panel.getByLabel('Read deal & receipt').check();
  await panel.getByRole('button', { name: 'Issue credential' }).click();
  await expect(tabA.getByRole('dialog').getByText(TOKEN_1)).toBeVisible();

  // Tab B refreshes into a second verified user session; supabase-js broadcasts
  // the new session across tabs via BroadcastChannel/localStorage.
  const tabB = await context.newPage();
  await tabB.goto('/');
  await expect(tabB.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  setRefreshSession(makeSession({ userId: OTHER_OWNER_ID, email: OTHER_OWNER_EMAIL }));
  await tabB.evaluate((key) => {
    const parsed = JSON.parse(localStorage.getItem(key));
    parsed.expires_at = Math.floor(Date.now() / 1000) - 10;
    localStorage.setItem(key, JSON.stringify(parsed));
    document.dispatchEvent(new Event('visibilitychange'));
  }, STORAGE_KEY);

  // Tab A immediately clears the open reveal modal, unmounts the credential panel,
  // and clears User A's owner agreement (returning to home without User A's deal).
  await expect(tabA.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
  await expect(tabA.getByText(TOKEN_1)).toHaveCount(0);
  await expect(tabA.getByRole('region', { name: 'Agent credentials' })).toHaveCount(0);
  await expect(tabA.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible();
  await expect(tabA.getByText('Row 6 Offline Deal One')).toHaveCount(0);
  expect(calls.unexpected).toEqual([]);
});
