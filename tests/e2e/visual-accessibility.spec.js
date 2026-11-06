// Focused color contrast checks for the core evidence path.
// Every backend response in this file is stubbed; these cases do not write to
// Supabase, send mail, or use a real account.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const OWNER_CONTRACT = {
  id: '11111111-1111-4111-8111-111111111111',
  project_name: 'Contrast check agreement',
  dod: ['Deliver the final document'],
  amount_jpy: 20000,
  currency: 'JPY',
  deadline: '2026-12-01',
  state: 'TERMS_ACCEPTED',
  performed_by: 'creator',
  earner_display_name: 'Owner',
  invited_hirer_email: 'invited@example.test',
  hirer_email: 'guest@example.test',
  invite_token: null,
  invite_token_expires_at: null,
  invite_token_used_at: '2026-10-01T00:00:00.000Z',
  created_at: '2026-09-30T00:00:00.000Z',
};

const ACCEPTED = {
  snapshot_version: 1,
  project_name: 'Contrast check agreement',
  dod: ['Deliver the final document'],
  amount: 20000,
  currency: 'JPY',
  deadline: '2026-12-01',
  performed_by: 'creator',
  offered_by: 'Owner',
};

const INVITE_TOKEN = '22222222-2222-4222-8222-222222222222';
const GUEST_CONTRACT_ID = '33333333-3333-4333-8333-333333333333';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const preflight = route => route.fulfill({
  status: 200,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer, x-guest-access-token, x-supabase-api-version',
  },
  body: '',
});

async function blockUnstubbedBackend(page) {
  // The app may attempt anonymous auth and runtime-snapshot persistence during
  // startup. Abort both, plus any unanticipated endpoint, so these visual tests
  // cannot create accounts or write to the configured Supabase project.
  await page.route('**/auth/v1/**', route => route.abort());
  await page.route('**/rest/v1/**', route => route.abort());
  await page.route('**/functions/v1/**', route => route.abort());
  await page.routeWebSocket('**/realtime/v1/websocket*', () => {});
}

async function stubContracts(page, contracts) {
  await page.route('**/rest/v1/contracts*', async route => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    if (route.request().method() !== 'GET') return route.abort();
    await json(route, contracts);
  });
  await page.route('**/rest/v1/events*', async route => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    if (route.request().method() !== 'GET') return route.abort();
    await json(route, []);
  });
}

async function stubGuestEvidence(page) {
  await page.route('**/functions/v1/validate-invite-token', async route => {
    if (route.request().method() === 'OPTIONS') {
      return preflight(route);
    }
    await json(route, {
      contract_id: GUEST_CONTRACT_ID,
      project_name: ACCEPTED.project_name,
      dod: ACCEPTED.dod,
      amount_jpy: ACCEPTED.amount,
      currency: ACCEPTED.currency,
      deadline: ACCEPTED.deadline,
      earner_display_name: ACCEPTED.offered_by,
      invited_hirer_email: 'invited@example.test',
      performed_by: ACCEPTED.performed_by,
      guest_access_token: 'stub-guest-token',
    });
  });

  await page.route('**/functions/v1/guest-contract-events', async route => {
    if (route.request().method() === 'OPTIONS') {
      return preflight(route);
    }
    await json(route, {
      accepted_agreement: ACCEPTED,
      acceptance_identity: {
        invited_recipient: 'invited@example.test',
        claimed_identity: 'someone.else@example.test',
        claimed_identity_verified: false,
        authentication: 'invite_capability',
      },
      terms_changed_since_acceptance: [],
      contract: {
        id: GUEST_CONTRACT_ID,
        project_name: ACCEPTED.project_name,
        dod: ACCEPTED.dod,
        amount_jpy: ACCEPTED.amount,
        currency: ACCEPTED.currency,
        deadline: ACCEPTED.deadline,
        state: 'TERMS_ACCEPTED',
        performed_by: ACCEPTED.performed_by,
        viewer_role: 'receiver',
        earner_display_name: ACCEPTED.offered_by,
        hirer_email: 'someone.else@example.test',
      },
      events: [{
        id: '44444444-4444-4444-8444-444444444444',
        type: 'dod.consent_recorded',
        created_at: '2026-10-01T00:00:00.000Z',
        actor: { id: null, role: 'guest_hirer', label: 'You' },
        payload: { counterparty_name: 'Guest' },
        integrity: {
          trust_model: 'server_attested',
          event_hash: 'abc',
          prev_event_hash: 'GENESIS',
          hash_valid: true,
          chain_linked: true,
          substance_valid: true,
          binds_whole_agreement: true,
        },
      }],
      chain: {
        event_count: 1,
        server_attested: 1,
        client_asserted: 0,
        verified: true,
        truncated: false,
        payload_covered_by_hash: true,
      },
    });
  });
}

async function finishFiniteAnimations(page) {
  await page.locator('main').evaluate(async main => {
    const finiteAnimations = main.getAnimations({ subtree: true }).filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finiteAnimations.map(animation => animation.finished.catch(() => undefined)));
  });
}

async function expectNoColorContrastViolations(page) {
  // The gate is color-contrast only. TF_AXE_ALL=1 runs every rule instead,
  // for surveying how much more axe would catch before widening the gate.
  let builder = new AxeBuilder({ page }).include('main');
  if (!process.env.TF_AXE_ALL) builder = builder.withRules(['color-contrast']);
  const results = await builder.analyze();
  const details = results.violations.map(violation => ({
    id: violation.id,
    description: violation.description,
    nodes: violation.nodes.map(node => ({ target: node.target, summary: node.failureSummary })),
  }));
  expect(details, `color-contrast violations: ${JSON.stringify(details)}`).toEqual([]);
}

test('color contrast: contracts home', async ({ page }) => {
  await blockUnstubbedBackend(page);
  await stubContracts(page, []);
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  await finishFiniteAnimations(page);
  await expectNoColorContrastViolations(page);
});

test('color contrast: record of agreement', async ({ page }) => {
  await blockUnstubbedBackend(page);
  await stubContracts(page, [OWNER_CONTRACT]);
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: OWNER_CONTRACT.project_name })).toBeVisible({ timeout: 15_000 });
  await finishFiniteAnimations(page);
  await expectNoColorContrastViolations(page);
});

test('color contrast: guest record of agreement', async ({ page }) => {
  await blockUnstubbedBackend(page);
  await stubGuestEvidence(page);
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${INVITE_TOKEN}`);
  await expect(page.getByText(ACCEPTED.project_name).first()).toBeVisible({ timeout: 15_000 });

  // The two screens a counterparty reads BEFORE committing had never been
  // measured: this walk passed through them to reach the record and only
  // checked the end of it. Three blind reviews in a row called text on them
  // too dim, which is a measurement gap rather than three opinions.
  await finishFiniteAnimations(page);
  await expectNoColorContrastViolations(page);

  await page.getByRole('button', { name: 'Review Agreement' }).click();
  await expect(page.getByPlaceholder('Your name or handle')).toBeVisible();
  await finishFiniteAnimations(page);
  await expectNoColorContrastViolations(page);

  await page.getByPlaceholder('Your name or handle').fill('Guest');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /I Agree/ }).click();
  await page.getByRole('button', { name: 'View the full verification detail' }).click();
  await expect(page.getByRole('heading', { name: 'Record of agreement' })).toBeVisible();

  await finishFiniteAnimations(page);
  await expectNoColorContrastViolations(page);
});
