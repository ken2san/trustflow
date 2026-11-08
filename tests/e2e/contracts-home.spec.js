// The Contracts home screen.
//
// Two things are covered here, deliberately at different levels:
//
//   1. Rendering and grouping — driven by stubbed PostgREST responses, so the
//      screen can be shown a known set of contracts including states that are
//      awkward to create for real (expired invites, settled, cancelled). The
//      grouping rules themselves are unit-tested in contractStatus.test.js;
//      what this proves is that the screen actually uses them.
//
//   2. That listContracts is scoped by RLS and not by client-side filtering —
//      checked against the live API, because that is where the guarantee lives.
//
// The second group needs a verified Earner:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';

const hoursFromNow = h => new Date(Date.now() + h * 3_600_000).toISOString();

/** Rows shaped exactly as listContracts selects them. */
const CONTRACTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    project_name: 'Accepted — needs delivery',
    dod: ['a'], amount_jpy: 180000, amount_minor: 180000, currency: 'JPY', deadline: '2026-11-12',
    state: 'TERMS_ACCEPTED',
    earner_display_name: 'Me', invited_hirer_email: 'invited@acme.test',
    hirer_email: 'hana@acme.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursFromNow(-48),
    created_at: hoursFromNow(-72),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    project_name: 'Invite expired',
    dod: ['b'], amount_jpy: 45000, amount_minor: 45000, currency: 'JPY', deadline: '2026-12-30',
    state: 'AWAITING_ACCEPTANCE',
    earner_display_name: 'Me', invited_hirer_email: 'late@studio.test', hirer_email: null,
    invite_token: '33333333-3333-4333-8333-333333333333',
    invite_token_expires_at: hoursFromNow(-3), invite_token_used_at: null,
    created_at: hoursFromNow(-100),
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    project_name: 'Waiting on the client',
    dod: ['c'], amount_jpy: 90000, amount_minor: 90000, currency: 'JPY', deadline: null,
    state: 'AWAITING_ACCEPTANCE',
    earner_display_name: 'Me', invited_hirer_email: 'soon@client.test', hirer_email: null,
    invite_token: '55555555-5555-4555-8555-555555555555',
    invite_token_expires_at: hoursFromNow(60), invite_token_used_at: null,
    created_at: hoursFromNow(-2),
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    project_name: 'Finished last month',
    dod: ['d'], amount_jpy: 20000, amount_minor: 20000, currency: 'JPY', deadline: '2026-08-01',
    state: 'SETTLED',
    earner_display_name: 'Me', invited_hirer_email: 'done@past.test', hirer_email: 'done@past.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursFromNow(-900),
    created_at: hoursFromNow(-1000),
  },
];

/**
 * Answer the contracts query with `rows`, leaving every other request alone.
 *
 * listContracts() follows up with one query for the latest performance
 * statement per contract, because the state column cannot distinguish "never
 * delivered" from "delivered, correction requested". A fixture declares that
 * with `last_performance_type`, and this synthesises the matching events so the
 * real code path runs rather than being bypassed.
 */
async function stubContracts(page, rows) {
  await page.route('**/rest/v1/contracts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(rows),
    });
  });
  await page.route('**/rest/v1/events*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const synthesised = rows
      .filter(r => r.last_performance_type)
      .map(r => ({
        contract_id: r.id,
        type: r.last_performance_type,
        created_at: r.created_at,
      }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(synthesised),
    });
  });
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
}

// ── The screen ──────────────────────────────────────────────────────────────

test('home opens on contracts, not the marketplace', async ({ page }) => {
  await stubContracts(page, CONTRACTS);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  // The old home's marketing headline and fixture jobs are gone from this path.
  await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: 'Get paid' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Details' })).toHaveCount(0);
});

test('contracts are grouped by whose move it is', async ({ page }) => {
  await stubContracts(page, CONTRACTS);
  await page.goto('/');

  await expect(page.getByText('Needs you', { exact: false })).toBeVisible({ timeout: 15_000 });

  // Accepted work and a dead invite both need the Earner.
  await expect(page.getByText('Accepted — needs delivery')).toBeVisible();
  await expect(page.getByText('Invite expired')).toBeVisible();
  await expect(page.getByText('Ready for you to deliver').first()).toBeVisible();
  await expect(page.getByText('Send a new invite').first()).toBeVisible();

  // A healthy pending invite is in progress, not nagging.
  await expect(page.getByText('In progress', { exact: false })).toBeVisible();
  await expect(page.getByText('Waiting on the client')).toBeVisible();
});

test('completed contracts are collapsed until asked for', async ({ page }) => {
  await stubContracts(page, CONTRACTS);
  await page.goto('/');

  await expect(page.getByRole('button', { name: /Completed/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Finished last month')).toHaveCount(0);

  await page.getByRole('button', { name: /Completed/i }).click();
  await expect(page.getByText('Finished last month')).toBeVisible();
});

test('status text comes from contracts.state, not the numeric step', async ({ page }) => {
  // Two contracts share AWAITING_ACCEPTANCE and must still read differently,
  // which a step counter could not express.
  await stubContracts(page, CONTRACTS);
  await page.goto('/');

  await expect(page.getByText('Awaiting acceptance').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Send a new invite').first()).toBeVisible();
  await expect(page.getByText('Waiting on your client').first()).toBeVisible();
});

test('with no contracts, the screen offers to create one', async ({ page }) => {
  await stubContracts(page, []);
  await page.goto('/');

  await expect(page.getByText('No contracts yet.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /New contract/i }).first()).toBeVisible();
});

test('a failed load says so instead of showing an empty list', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.route('**/rest/v1/contracts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: 'server exploded' }),
    });
  });
  await page.goto('/');

  await expect(page.getByText(/could not be loaded/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('No contracts yet.')).toHaveCount(0);
});

test('opening a contract reaches the agreement screen, not the escrow flow', async ({ page }) => {
  await stubContracts(page, CONTRACTS);
  await page.goto('/');

  await page.getByRole('button', { name: 'Open' }).click();

  // The agreement itself, and the one action that belongs to this side.
  await expect(page.getByText('What counts as complete')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /Accepted — needs delivery/i })).toBeVisible();

  // The five-step flow is bypassed: no escrow, no staking, no tier gate between
  // the user and the action. Those screens still exist; nothing routes here.
  await expect(page.locator('text=PROTOCOL')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Secure Funds in Escrow/i })).toHaveCount(0);
});

// ── Scoping is the database's job ───────────────────────────────────────────

test.describe('listContracts scoping', () => {
  test.skip(LIVE_SKIPPED,
    'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

  test('an unauthenticated client sees no contracts, not an error', async ({ request }) => {
    // listContracts applies no client-side filter on purpose — RLS is the
    // control. If that ever regressed to a permissive policy, this returns rows.
    const response = await request.fetch(
      `${SUPABASE_URL}/rest/v1/contracts?select=id,project_name&limit=5`,
      { headers: { apikey: SUPABASE_KEY } },
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test('a signed-in Earner sees their own contracts and only those', async ({ request }) => {
    const { token: access_token, userId } = await getEarnerSession(request);

    const response = await request.fetch(
      `${SUPABASE_URL}/rest/v1/contracts?select=id,earner_user_id,state&limit=200`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${access_token}` } },
    );
    expect(response.status()).toBe(200);
    const rows = await response.json();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.earner_user_id).toBe(userId);
    }
  });
});

// ── Coming back later ───────────────────────────────────────────────────────
//
// The product's value is preserving agreements, so a finished one must not
// vanish from the place people look. These use stubbed rows so the states and
// role directions that are awkward to create for real are all present at once.

const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();

const RETRIEVAL = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    project_name: 'I perform — ready to deliver',
    dod: ['a'], amount_jpy: 10000, amount_minor: 10000, currency: 'JPY', deadline: null,
    state: 'TERMS_ACCEPTED', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: 'c@x.test', hirer_email: 'c@x.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursAgo(50),
    created_at: hoursAgo(60), last_performance_type: null,
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    project_name: 'They perform — waiting on them',
    dod: ['b'], amount_jpy: 20000, amount_minor: 20000, currency: 'JPY', deadline: null,
    state: 'TERMS_ACCEPTED', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: 't@x.test', hirer_email: 't@x.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursAgo(50),
    created_at: hoursAgo(59), last_performance_type: null,
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000003',
    project_name: 'They delivered — my turn to review',
    dod: ['c'], amount_jpy: 30000, amount_minor: 30000, currency: 'JPY', deadline: null,
    state: 'AWAITING_CONFIRMATION', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: 't@x.test', hirer_email: 't@x.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursAgo(50),
    created_at: hoursAgo(58), last_performance_type: 'performance.asserted',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000004',
    project_name: 'I asked for a correction',
    dod: ['d'], amount_jpy: 40000, amount_minor: 40000, currency: 'JPY', deadline: null,
    state: 'TERMS_ACCEPTED', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: 't@x.test', hirer_email: 't@x.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursAgo(50),
    created_at: hoursAgo(57), last_performance_type: 'performance.rejected',
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000005',
    project_name: 'Finished months ago',
    dod: ['e'], amount_jpy: 50000, amount_minor: 50000, currency: 'JPY', deadline: null,
    state: 'PERFORMANCE_ACCEPTED', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: 't@x.test', hirer_email: 't@x.test',
    invite_token: null, invite_token_expires_at: null, invite_token_used_at: hoursAgo(4000),
    created_at: hoursAgo(4300), last_performance_type: 'performance.accepted',
  },
];

test('status reads from the functional role, in both directions', async ({ page }) => {
  await stubContracts(page, RETRIEVAL);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });

  // The account holder performs on one, receives on the other. The same
  // TERMS_ACCEPTED must not read the same way for both.
  await expect(page.getByText('Ready for you to deliver').first()).toBeVisible();
  await expect(page.getByText('Waiting on them to deliver').first()).toBeVisible();
  await expect(page.getByText('Review the delivery').first()).toBeVisible();
});

test('a requested correction is visible rather than hidden behind the state', async ({ page }) => {
  await stubContracts(page, RETRIEVAL);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });

  // A rejection returns the agreement to TERMS_ACCEPTED, so without the last
  // performance statement this would read as "waiting on them to deliver" and
  // lose the only fact that matters.
  await expect(page.getByText('Correction requested').first()).toBeVisible();
});

test('a finished agreement stays retrievable and reads as completed', async ({ page }) => {
  await stubContracts(page, RETRIEVAL);
  await page.goto('/');

  await page.getByRole('button', { name: /Completed/i }).click();
  await expect(page.getByText('Finished months ago')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Completed').first()).toBeVisible();
});

test('reopening a finished agreement shows the terms and the record', async ({ page }) => {
  await stubContracts(page, RETRIEVAL);
  await page.route('**/rest/v1/events*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([
        { id: 'e1', type: 'dod.consent_recorded', actor_id: 'guest:t@x.test', created_at: hoursAgo(4200), payload: {} },
        { id: 'e2', type: 'performance.asserted', actor_id: 'guest:t@x.test', created_at: hoursAgo(4100), payload: {} },
        { id: 'e3', type: 'performance.rejected', actor_id: 'owner-uid', created_at: hoursAgo(4090), payload: { reason: 'page 2 missing' } },
        { id: 'e4', type: 'performance.asserted', actor_id: 'guest:t@x.test', created_at: hoursAgo(4080), payload: {} },
        { id: 'e5', type: 'performance.accepted', actor_id: 'owner-uid', created_at: hoursAgo(4000), payload: {} },
      ]),
    });
  });
  await page.goto('/');

  await page.getByRole('button', { name: /Completed/i }).click();
  await page.getByText('Finished months ago').click();

  // The agreement itself, months later.
  await expect(page.getByText('What counts as complete')).toBeVisible({ timeout: 15_000 });

  // The record, in order, in ordinary language — and the correction reason,
  // which is the part someone actually needs six months later.
  await expect(page.getByText('Agreement confirmed')).toBeVisible();
  await expect(page.getByText('Correction requested')).toBeVisible();
  await expect(page.getByText(/page 2 missing/)).toBeVisible();
  await expect(page.getByText('Accepted')).toBeVisible();

  // No protocol internals in the normal view.
  await expect(page.getByText(/PERFORMANCE_ACCEPTED|performance\.asserted|payload_hash|prev_event_hash/)).toHaveCount(0);
});
