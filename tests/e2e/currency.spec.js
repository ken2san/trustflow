// A contract denominated in something other than yen, end to end, live.
//
// WHY A WHOLE SPEC FOR ONE CURRENCY
// Until 2026-11-08 every contract in both projects was JPY, the column was
// called `amount_jpy`, and the database CHECK said `currency = 'JPY'`. Three
// separate things therefore had to be true at once before a CAD agreement
// could be recorded honestly, and each of them fails in a way that still looks
// like success:
//
//   1. the amount is stored in MINOR UNITS — CA$12.50 is 1250 — so a reader
//      that treats it as a whole currency unit shows CA$1,250.00, and one that
//      treats it as yen shows ¥1,250. Both are plausible numbers on screen.
//   2. the agreement snapshot inside the acceptance event must carry that
//      integer and the currency, because that snapshot is what the evidence
//      proves. A null amount there verifies perfectly well as an agreement
//      about nothing.
//   3. `amount_jpy` must be NULL on the row, not a copy — a cent amount in a
//      column named after yen is wrong by a factor of 100 to anything that
//      trusts the name.
//
// So this runs the real path: insert as a verified Earner, open the invitation
// in a browser, accept it, and read the recorded evidence back.
//
// Requires a verified Earner:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

async function api(request, path, { method = 'POST', token, guestToken, body, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${token ?? SUPABASE_KEY}`;
  if (guestToken) headers['x-guest-access-token'] = guestToken;
  if (prefer) headers.Prefer = prefer;
  const response = await request.fetch(`${SUPABASE_URL}${path}`, { method, headers, data: body });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status(), body: parsed };
}

// CA$12.50. Small on purpose: the interesting digits are the cents, and a
// round thousand would read the same whether the unit were right or wrong.
const CAD_MINOR = 1250;

const TERMS = {
  project_name: 'Translation quoted in Canadian dollars',
  dod: ['translate the document', 'return a stamped PDF'],
  amount_minor: CAD_MINOR,
  currency: 'CAD',
  deadline: '2026-12-31',
};

async function createCadContract(request, overrides = {}) {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      ...TERMS, ...overrides,
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
      invited_hirer_email: 'invited@example.test',
    },
  });
  expect(created.status, `CAD insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  return { contract: created.body[0], token, userId };
}

// ── The row ─────────────────────────────────────────────────────────────────

test('a CAD contract is stored in cents, with no yen column', async ({ request }) => {
  const { contract } = await createCadContract(request);

  expect(contract.currency).toBe('CAD');
  expect(contract.amount_minor).toBe(CAD_MINOR);
  // The whole reason amount_jpy is nulled rather than mirrored: a reader still
  // asking for it gets no amount instead of a plausible wrong one.
  expect(contract.amount_jpy).toBeNull();
});

test('a CAD contract carrying a yen amount is refused outright', async ({ request }) => {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    body: {
      ...TERMS,
      amount_jpy: CAD_MINOR,
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status).toBe(400);
  expect(JSON.stringify(created.body)).toContain('contracts_amount_jpy_mirror_check');
});

test('a currency nobody agreed to is refused by the database, not just the form', async ({ request }) => {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    body: {
      ...TERMS, currency: 'CHF',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status).toBe(400);
  expect(JSON.stringify(created.body)).toContain('contracts_currency_check');
});

// ── What the counterparty is shown ──────────────────────────────────────────

test('the invitation shows CA$12.50, not ¥1,250 and not CA$1,250', async ({ page, request }) => {
  const { contract } = await createCadContract(request);

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${contract.invite_token}`);

  await expect(page.getByText(TERMS.project_name).first()).toBeVisible({ timeout: 15_000 });
  // The exact string, and the two wrong readings of the same integer.
  await expect(page.getByText('CA$12.50').first()).toBeVisible();
  await expect(page.getByText('¥1,250')).toHaveCount(0);
  await expect(page.getByText('CA$1,250.00')).toHaveCount(0);
  // And not rounded to a whole unit, which is what maximumFractionDigits: 0
  // used to do to every currency.
  await expect(page.getByText('CA$13', { exact: true })).toHaveCount(0);
});

// ── What the evidence records ───────────────────────────────────────────────

test('the acceptance binds the amount in cents and the currency it was agreed in', async ({ request }) => {
  const { contract } = await createCadContract(request);

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
    },
  });
  expect(accept.status, `acceptance failed: ${JSON.stringify(accept.body)}`).toBe(200);
  expect(accept.body.amount_minor).toBe(CAD_MINOR);
  expect(accept.body.currency).toBe('CAD');

  const trail = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: accept.body.guest_access_token,
  });

  // The snapshot shape is unchanged — `amount` has always been an integer in
  // the currency's minor unit, which for JPY is yen. That is why no
  // snapshot_version bump was needed and why every historical agreement_hash
  // still recomputes.
  expect(trail.body.accepted_agreement).toEqual({
    snapshot_version: 1,
    project_name: TERMS.project_name,
    dod: TERMS.dod,
    amount: CAD_MINOR,
    currency: 'CAD',
    deadline: TERMS.deadline,
    performed_by: 'creator',
    offered_by: 'Acme Translations',
  });

  // And it is evidence, not just a record: the chain over it verifies.
  expect(trail.body.chain.verified).toBe(true);
});

test('the agreed amount cannot be changed after acceptance', async ({ request }) => {
  const { contract, token } = await createCadContract(request);

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
    },
  });
  expect(accept.status).toBe(200);

  // freeze_accepted_terms learned about amount_minor in 20261108160000. Before
  // that it watched amount_jpy only — which on a CAD row is NULL and never
  // changes, so the price of every non-JPY agreement would have been editable
  // after it was agreed.
  const edited = await api(request, `/rest/v1/contracts?id=eq.${contract.id}`, {
    method: 'PATCH', token, body: { amount_minor: 999999 },
  });
  expect(edited.status).toBeGreaterThanOrEqual(400);

  const after = await api(request, `/rest/v1/contracts?id=eq.${contract.id}&select=amount_minor`, {
    method: 'GET', token,
  });
  expect(after.body[0].amount_minor).toBe(CAD_MINOR);
});
