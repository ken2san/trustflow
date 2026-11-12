// What a person actually reads on screen about the deal they accepted.
//
// Driven by stubbed Edge Function responses rather than a live agreement: what
// is being checked here is the wording and the rendering, and a stub can
// present states that are awkward to produce for real — in particular a
// contract row that no longer matches the terms that were accepted.
//
// The claims themselves are enforced server-side and covered by
// agreement-binding.spec.js. This suite guards against the screen saying more
// than the record supports.

import { test, expect } from '@playwright/test';

const ACCEPTED = {
  snapshot_version: 1,
  project_name: 'Certified translation of a birth certificate',
  dod: ['translate the document', 'return a stamped PDF'],
  amount: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  offered_by: 'Acme Translations',
};

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INVITE_TOKEN = '22222222-2222-4222-8222-222222222222';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

/**
 * Stub the three functions the guest path calls, and walk to the record.
 *
 * `trail` overrides let one test present an agreement whose live row has
 * drifted from what was accepted.
 */
let logEventCalls = [];

async function openTheRecord(page, { invite = {}, trail = {} } = {}) {
  logEventCalls = [];

  await page.route('**/functions/v1/validate-invite-token', route => json(route, {
    contract_id: CONTRACT_ID,
    project_name: ACCEPTED.project_name,
    dod: ACCEPTED.dod,
    amount_jpy: ACCEPTED.amount,
    currency: ACCEPTED.currency,
    deadline: ACCEPTED.deadline,
    earner_display_name: ACCEPTED.offered_by,
    invited_hirer_email: 'invited@example.test',
    performed_by: ACCEPTED.performed_by,
    guest_access_token: 'stub-guest-token',
    ...invite,
  }));

  // Nothing should reach log-event on this path any more: acceptance writes its
  // own evidence server-side. Fulfilled with an error so that a client that
  // regressed to calling it would fail loudly rather than pass unnoticed.
  await page.route('**/functions/v1/log-event', route => {
    logEventCalls.push(route.request().url());
    return json(route, { error: 'log_event_should_not_be_called_on_acceptance' }, 500);
  });

  await page.route('**/functions/v1/guest-contract-events', route => json(route, {
    accepted_agreement: ACCEPTED,
    acceptance_identity: {
      invited_recipient: 'invited@example.test',
      claimed_identity: 'someone.else@example.test',
      claimed_identity_verified: false,
      authentication: 'invite_capability',
    },
    terms_changed_since_acceptance: [],
    contract: {
      id: CONTRACT_ID,
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
      created_at: '2026-09-24T12:00:00.000Z',
      actor: { id: null, role: 'guest_hirer', label: 'You' },
      dod_hash: 'terms-hash',
      payload: { counterparty_name: 'Guest' },
      integrity: {
        trust_model: 'server_attested',
        event_hash: 'abc', prev_event_hash: 'GENESIS',
        hash_valid: true, chain_linked: true, substance_valid: true,
        binds_whole_agreement: true,
      },
    }],
    chain: {
      event_count: 1, server_attested: 1, client_asserted: 0,
      verified: true, truncated: false, payload_covered_by_hash: true,
    },
    ...trail,
  }));

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${INVITE_TOKEN}`);

  await expect(page.getByText(ACCEPTED.project_name).first()).toBeVisible({ timeout: 15_000 });
}

/** Accept the stubbed invitation and open the evidence screen. */
async function acceptAndOpen(page) {
  await page.getByRole('button', { name: 'Review Agreement' }).click();
  await page.getByPlaceholder('Your name or handle').fill('Guest');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /I Agree/ }).click();
  await page.getByRole('button', { name: 'View the full verification detail' })
    .click({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Record of agreement' }))
    .toBeVisible({ timeout: 15_000 });
  // The correctness of the record must not depend on a second client call.
  expect(logEventCalls, 'acceptance must not write evidence from the browser')
    .toEqual([]);
}

// ── Before agreeing ─────────────────────────────────────────────────────────

test('the invitation says which side does the work before anyone agrees', async ({ page }) => {
  // performed_by is bound into the agreement snapshot at acceptance, so it has
  // to be on screen first.
  await openTheRecord(page);

  await expect(page.getByText('Who does the work')).toBeVisible();
  await expect(page.getByText('Acme Translations does the work · you pay', { exact: true }))
    .toBeVisible();
});

test('the invitation states the work direction the other way round too', async ({ page }) => {
  await openTheRecord(page, { invite: { performed_by: 'counterparty' } });

  // Both the headline and the card say this now — the headline states the
  // direction because a blind reviewer read the old one backwards — so this
  // pins the card's own label rather than matching twice.
  await expect(page.getByText('You do the work · Acme Translations pays', { exact: true }))
    .toBeVisible();
});

// ── After agreeing ──────────────────────────────────────────────────────────

test('the record shows what was accepted, read from the acceptance itself', async ({ page }) => {
  await openTheRecord(page);
  await acceptAndOpen(page);

  await expect(page.getByText('What was accepted')).toBeVisible();
  await expect(page.getByText('return a stamped PDF')).toBeVisible();
  await expect(page.getByText('¥20,000')).toBeVisible();
  // One fact, one spelling: the invitation writes the deadline as
  // "November 30, 2026" and the record used to write the same date as
  // "2026-11-30", which a blind reader counted as a third date format on a
  // screen that already had two.
  await expect(page.getByText('November 30, 2026')).toBeVisible();
});

test('the record does not claim the accepting identity was established', async ({ page }) => {
  await openTheRecord(page);
  await acceptAndOpen(page);

  // "Accepted as x@example.com" read as a verified identity. Nothing checks it.
  await expect(page.getByText('Accepted as')).toHaveCount(0);
  await expect(page.getByText('Invitation addressed to')).toBeVisible();
  await expect(page.getByText('invited@example.test')).toBeVisible();
  await expect(page.getByText('Address given when accepting')).toBeVisible();
  await expect(page.getByText('someone.else@example.test')).toBeVisible();
});

test('a live record that no longer matches the accepted terms says so', async ({ page }) => {
  await openTheRecord(page, {
    trail: { terms_changed_since_acceptance: ['amount', 'deadline'] },
  });
  await acceptAndOpen(page);

  await expect(page.getByText(/no longer matches what was accepted/)).toBeVisible();
  await expect(page.getByText(/the amount, the deadline/)).toBeVisible();
  // And the accepted figures are still the ones on display.
  await expect(page.getByText('¥20,000')).toBeVisible();
});

test('an agreement accepted before snapshots existed shows no invented terms', async ({ page }) => {
  await openTheRecord(page, {
    trail: {
      accepted_agreement: null,
      acceptance_identity: null,
      terms_changed_since_acceptance: null,
    },
  });
  await acceptAndOpen(page);

  // Absent, not reconstructed from the current row.
  await expect(page.getByText('What was accepted')).toHaveCount(0);
  await expect(page.getByText(/no longer matches what was accepted/)).toHaveCount(0);
});
