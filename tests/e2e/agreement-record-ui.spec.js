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
import { GUEST_EVENTS_ROUTE, guardFunctionCalls, askedForV2, toV2 } from './guestEvidenceStub.js';

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
let calls = { unexpected: [], guestEventUrls: [] };

/**
 * `shape: 'v1'` answers as today's function does (and as one rolled back
 * would), even though the page asks for version 2; `'v2'` answers in the
 * version 2 shape; `raw` replaces the body outright.
 */
async function openTheRecord(page, { invite = {}, trail = {}, shape = 'v1', raw = null } = {}) {
  logEventCalls = [];
  calls = await guardFunctionCalls(page);

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

  const v1Body = {
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
        canonical_version: 4, canonical_version_supported: true,
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
  };
  await page.route(GUEST_EVENTS_ROUTE, route => {
    calls.guestEventUrls.push(route.request().url());
    // The single v4 acceptance row's agreement digest is the one the server
    // compares with the accepted snapshot, so the v2 fixture states it was
    // checked (Codex T177: v1 alone cannot express that evidence).
    return json(route, raw ?? (shape === 'v2' ? toV2(v1Body, { agreementChecked: true }) : v1Body));
  });

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

test.afterEach(() => {
  // A stub that stopped matching would otherwise send this suite to a live backend.
  expect(calls.unexpected, 'Edge Function calls no stub handled').toEqual([]);
  expect(calls.guestEventUrls.every(askedForV2), 'every record read asks for response version 2')
    .toBe(true);
});

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
  await expect(page.getByText('Address given when accepting this invitation')).toBeVisible();
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

// ── Response versions (rank-1 provenance fix) ───────────────────────────────

test('the record names the hash format, never a writer, from a version 1 body', async ({ page }) => {
  await openTheRecord(page);
  await acceptAndOpen(page);

  expect(calls.guestEventUrls.length).toBeGreaterThan(0);
  await expect(page.getByText('Hash format v4')).toBeVisible();
  await expect(page.getByText(/Server-attested|Client-asserted|predate server attestation/)).toHaveCount(0);
  await expect(page.getByText('No check that ran found a mismatch.')).toBeVisible();
  await expect(page.getByText(/who actually acted is not\s+established by this record/)).toBeVisible();
  await expect(page.getByText(/trust_model "server_attested"/)).toBeVisible();
});

test('a version 2 body reads its strict verdict (option D)', async ({ page }) => {
  await openTheRecord(page, { shape: 'v2' });
  await acceptAndOpen(page);

  await expect(page.getByText('What was accepted')).toBeVisible();
  await expect(page.getByText('Hash format v4')).toBeVisible();
  await expect(page.getByText(/strict check passed every dimension/)).toBeVisible();
  await expect(page.getByText('No check that ran found a mismatch.')).toHaveCount(0);
  await expect(page.locator('ol').getByText('by a party', { exact: true })).toBeVisible();
});

// A format 1 row whose hash did not match beside a clean format 4 row, read
// with the cap reached. Served as version 1 (the default) and, separately, as
// version 2 below.
const TRUNCATED_MIXED_TRAIL = {
  events: [
    {
      id: '55555555-5555-4555-8555-555555555555', type: 'contract.initiated',
      created_at: '2026-09-20T12:00:00.000Z', actor: { id: 'x' }, payload: {},
      integrity: {
        trust_model: 'client_asserted', canonical_version: 1, canonical_version_supported: true,
        hash_valid: false, chain_linked: null, substance_valid: null,
      },
    },
    {
      id: '44444444-4444-4444-8444-444444444444', type: 'dod.consent_recorded',
      created_at: '2026-09-24T12:00:00.000Z', actor: { id: null }, payload: {},
      integrity: {
        trust_model: 'server_attested', canonical_version: 4, canonical_version_supported: true,
        hash_valid: true, chain_linked: true, substance_valid: true,
      },
    },
  ],
  chain: {
    event_count: 2, server_attested: 1, client_asserted: 1,
    verified: true, truncated: true, payload_covered_by_hash: false,
  },
};

test('a truncated record says more events may exist, and an old mismatch is shown', async ({ page }) => {
  await openTheRecord(page, { trail: TRUNCATED_MIXED_TRAIL });
  await acceptAndOpen(page);

  // verified is true here (the server checks v2+ only); the screen still says.
  await expect(page.getByText(/^1 event has a check that did not match/)).toBeVisible();
  await expect(page.getByText(/Additional events may exist and were not checked here/)).toBeVisible();
  await expect(page.getByText(/chain holds|tampered/)).toHaveCount(0);
});

test('version 2 of the same truncated record: the strict check failed, and the read is not proven complete', async ({ page }) => {
  await openTheRecord(page, { trail: TRUNCATED_MIXED_TRAIL, shape: 'v2' });
  await acceptAndOpen(page);

  await expect(page.getByText(/strict check found a problem in: event hash, on 1 event/)).toBeVisible();
  await expect(page.getByText(/could not establish that this response reaches the last event/)).toBeVisible();
  // A missing count is not proof the server's cap was reached.
  await expect(page.getByText(/most events the server returns/)).toHaveCount(0);
  await expect(page.getByText('No check that ran found a mismatch.')).toHaveCount(0);
});

test('a response the page cannot validate is refused, not partly shown', async ({ page }) => {
  // Accept through the stubs first, then serve a record missing a check result.
  await openTheRecord(page, {
    raw: {
      contract: { id: CONTRACT_ID, project_name: ACCEPTED.project_name },
      events: [{
        id: 'e1', type: 'dod.consent_recorded', created_at: '2026-09-24T12:00:00.000Z',
        payload: {}, integrity: { canonical_version: 4, canonical_version_supported: true, chain_linked: true, substance_valid: true },
      }],
      chain: { event_count: 1, verified: true, truncated: false },
    },
  });
  await page.getByRole('button', { name: 'Review Agreement' }).click();
  await page.getByPlaceholder('Your name or handle').fill('Guest');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /I Agree/ }).click();
  await page.getByRole('button', { name: 'View the full verification detail' })
    .click({ timeout: 15_000 });

  await expect(page.getByText(/unsupported or invalid response/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/No check that ran found a mismatch/)).toHaveCount(0);
});
