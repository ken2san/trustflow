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
import { shownTermsDigest } from '../../supabase/functions/_shared/shownTerms.ts';

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

/**
 * Accept a non-JPY invitation the way a current client does: with a v2
 * shown-terms digest. A non-JPY acceptance without one is refused — see the
 * test for exactly that, below.
 */
async function acceptCad(request, contract, { version = 2 } = {}) {
  return api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
      shown_terms_digest: await shownTermsDigest(contract, version),
      shown_terms_version: version,
    },
  });
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

  const accept = await acceptCad(request, contract);
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

  const accept = await acceptCad(request, contract);
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

// ── The two failures Codex's review of this change found ────────────────────

test('a JPY writer that sends only amount_minor gets the mirror filled', async ({ request }) => {
  // The other half of the normalization contract: the client stopped writing
  // amount_jpy (the server owns the mirror in both directions), so this is the
  // path every current JPY creation takes.
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      project_name: 'Mirror fill probe',
      dod: ['deliverable'],
      amount_minor: 45000,
      currency: 'JPY',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status, `insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  expect(created.body[0].amount_minor).toBe(45000);
  expect(created.body[0].amount_jpy).toBe(45000);
});

test('two disagreeing amounts are refused rather than resolved', async ({ request }) => {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    body: {
      project_name: 'Disagreement probe',
      dod: ['deliverable'],
      amount_minor: 100, amount_jpy: 200, currency: 'JPY',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status).toBe(400);
  expect(JSON.stringify(created.body)).toContain('contracts_amount_jpy_mirror_check');
});

test('a writer that only knows amount_jpy still creates a JPY contract', async ({ request }) => {
  // The break this guards: `amount_minor` is NOT NULL with no default, so
  // every browser on a bundle from before 2026-11-08 — which sends amount_jpy
  // alone — would have failed with 23502 the moment the first migration
  // committed, and gone on failing until the person reloaded. The server fills
  // the new column from the old one instead (20261108160000's
  // contracts_fill_amount_minor).
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      project_name: 'Legacy writer probe',
      dod: ['deliverable'],
      amount_jpy: 45000,
      currency: 'JPY',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status, `legacy insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  expect(created.body[0].amount_minor).toBe(45000);
  expect(created.body[0].amount_jpy).toBe(45000);
});

test('a contract with no amount at all is still refused, not defaulted to zero', async ({ request }) => {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    body: {
      project_name: 'No amount probe',
      dod: ['deliverable'],
      currency: 'JPY',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
    },
  });
  expect(created.status).toBe(400);
  expect(JSON.stringify(created.body)).toContain('amount_minor');
});

test('accepting a CAD agreement against the v1 terms digest is refused', async ({ request }) => {
  // v1 of the shown-terms digest covers `amount_jpy`, which is NULL on every
  // non-JPY row — before and after an owner changes the price. So a guest on
  // an older bundle would have their acceptance checked against a digest that
  // is blind to the amount: the exact failure the mechanism exists to prevent,
  // on exactly the contracts this work is for.
  const { contract } = await createCadContract(request);

  const refused = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
      // Any digest at all: it is refused on the version, before comparison.
      shown_terms_digest: 'f'.repeat(64),
      shown_terms_version: 1,
    },
  });
  expect(refused.status).toBe(409);
  // "I cannot check this", not "they changed" — nothing is known to have been
  // edited, and saying so would be a claim about the agreement.
  expect(refused.body.error).toBe('terms_check_unsupported');

  // AND NO DIGEST AT ALL IS REFUSED TOO, which is the half that matters: the
  // whole version check lives inside a test for a non-empty digest, so
  // refusing v1 alone would leave a stale client able to skip the check
  // entirely by sending nothing. For JPY that omission is the deliberate
  // compatibility period; for a currency that only a current client can even
  // create, it is a stale bundle.
  const silent = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
    },
  });
  expect(silent.status).toBe(409);
  expect(silent.body.error).toBe('terms_check_unsupported');

  // The invitation is still usable, so the refusal costs a reload and nothing
  // more.
  const accepted = await acceptCad(request, contract);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
});

test('a JPY acceptance with no digest at all is still accepted', async ({ request }) => {
  // The compatibility period this change must not shorten: a yen contract
  // accepted by a client that predates the whole mechanism. v1 does cover the
  // amount of a yen contract, and nothing here makes the digest mandatory for
  // one.
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      project_name: 'Yen no-digest probe',
      dod: ['deliverable'],
      amount_minor: 20000, currency: 'JPY',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
      invited_hirer_email: 'invited@example.test',
    },
  });
  expect(created.status).toBe(201);

  const accepted = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: created.body[0].invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
    },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
});

test('a JPY agreement still accepts the v1 terms digest', async ({ request }) => {
  // The compatibility half: v1 does cover the amount of a yen contract, so a
  // guest on an older bundle is not refused for being one deploy behind.
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      project_name: 'Yen v1 digest probe',
      dod: ['deliverable'],
      amount_jpy: 20000, amount_minor: 20000, currency: 'JPY',
      deadline: '2026-12-31',
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
      invited_hirer_email: 'invited@example.test',
    },
  });
  expect(created.status).toBe(201);
  const contract = created.body[0];

  const digest = await shownTermsDigest(contract, 1);
  const accepted = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
      shown_terms_digest: digest, shown_terms_version: 1,
    },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
});
