// One agreement, two parties, each on a DIFFERENT surface.
//
// WHAT WAS ALREADY COVERED, AND WHAT WAS NOT
// The suite had both surfaces well exercised in isolation. `scripts/api-e2e.mjs`
// and `scripts/two-agent-transaction.mjs` drive both parties over HTTP;
// `guest-evidence`, `guest-path-capture` and `invite-persistence` drive the
// guest through a real browser. Nothing crossed them: no test had a credential
// minted on one surface used on the other, and nothing non-JPY was ever
// accepted in a browser at all — `currency.spec.js` opens a CAD invitation in
// the page to check what it displays, then accepts over the API.
//
// The crossing is where the interesting failures live:
//
//   - the guest_access_token the BROWSER mints at acceptance, presented later
//     by an agent in `x-guest-access-token`;
//   - the shown-terms digest the BROWSER computes from its own rendering,
//     compared against the server's read — versus the one an AGENT computes
//     from the published specification, with no shared code;
//   - and the non-JPY path, where that digest is MANDATORY, so a mismatch is a
//     refusal rather than a cosmetic difference.
//
// WHAT THE PROTOCOL DOES NOT ALLOW, FOUND WHILE WRITING THIS
// `受諾 → performance.asserted → performance.accepted` cannot be driven
// entirely from the guest's browser, because the guest has no control for it.
// `GuestEvidenceView` is read-only — its only buttons are "back" and
// "Download this record" — and `AgreementView`, which carries the assert and
// accept controls, is the owner's screen. So in pattern (a) the delivery
// acceptance is necessarily an API act by the guest, using the capability the
// browser issued. That is not a gap in this test; it is the product's shape,
// and this is the test that makes it explicit.
//
// Requires a verified Earner: TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD.

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';
// The digest as an OUTSIDE client computes it: written from
// public/agent-protocol.md §1, importing none of this project's crypto. Used
// here for exactly the reason it exists — if the published spec and the server
// disagree, this is the test that says so.
import { digestV2 } from '../../scripts/agents/published-digest.mjs';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

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

/** Tomorrow, locally. toISOString() makes today read as past east of Greenwich. */
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}

/**
 * An agreement offered by the owner over the API. CAD 1250 is CA$12.50: the
 * interesting digits are the cents, and a round thousand reads the same whether
 * the minor unit is right or wrong.
 */
async function offer(request, { currency, amountMinor, label }) {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts?select=*', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Mixed Surface Owner',
      project_name: `mixed-surface ${label} ${Date.now()}`,
      dod: ['Translate the document', 'Return a stamped PDF'],
      amount_minor: amountMinor,
      currency,
      deadline: tomorrow(),
      invited_hirer_email: 'mixed-surface@example.invalid',
      performed_by: 'creator',
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { contract: created.body[0], ownerToken: token };
}

/**
 * The guest's real browser acceptance, as `invite-persistence` establishes it.
 *
 * The consent checkbox is not optional decoration: the submit button is
 * disabled until a name, an address and the tick are all present
 * (`InviteView.jsx:313`). A test that skips it waits forever on a button that
 * is never going to enable, which is exactly how this one failed first.
 */
async function acceptInBrowser(page, email) {
  await page.getByRole('button', { name: /Review Agreement|Continue|Accept/i }).first().click();
  await page.getByPlaceholder('Your name or handle').fill('Mixed Surface Guest');
  await page.getByPlaceholder(/Email address/i).fill(email);
  await page.getByRole('checkbox').check();

  const agree = page.getByRole('button', { name: /I Agree/i });
  await expect(agree).toBeEnabled();
  await agree.click();

  // Wait for the acceptance's own result, not a timer. It is one transaction:
  // the token is consumed, the capability issued and the event appended
  // together, so this heading means all of it committed.
  await expect(page.getByRole('heading', { name: /Agreement accepted/i, level: 2 }))
    .toBeVisible({ timeout: 30_000 });
}

/**
 * Put a real verified-Earner session in the page, so the browser acts as the
 * owner for real rather than against stubs.
 *
 * supabase-js v2 persists the session in localStorage under
 * `sb-<project-ref>-auth-token`. Writing it before any script runs is what
 * makes the first `getSession()` on load return a signed-in Earner — there is
 * no sign-in UI path that an automated test can complete, because the
 * product's own sign-in is an emailed OTP behind a CAPTCHA.
 */
async function signInOwnerInBrowser(page, request) {
  const { session } = await getEarnerSession(request);
  // The whole session object as Supabase Auth returned it, not a hand-built
  // one: the library reads fields this test has no business guessing at, and a
  // reconstruction that happens to work today is a test that breaks on a
  // library upgrade for reasons no one will connect to this line.
  await page.addInitScript(([ref, stored]) => {
    localStorage.setItem('tf_onboarded', '1');
    localStorage.setItem(`sb-${ref}-auth-token`, stored);
  }, [PROJECT_REF, JSON.stringify(session)]);
  return session;
}

/** The events of one contract, read as the owner. */
async function eventsOf(request, contract, ownerToken) {
  const r = await api(request,
    `/rest/v1/events?contract_id=eq.${contract.id}&select=type,payload,created_at&order=created_at.asc`,
    { method: 'GET', token: ownerToken });
  expect(r.status).toBe(200);
  return r.body;
}

function acceptanceOf(events) {
  const acceptance = events.find(e => e.type === 'dod.consent_recorded');
  expect(acceptance, 'the acceptance event must exist').toBeTruthy();
  return acceptance;
}

// ── (a) owner = agent, guest = browser ──────────────────────────────────────

for (const { currency, amountMinor, shown } of [
  { currency: 'JPY', amountMinor: 50000, shown: '¥50,000' },
  { currency: 'CAD', amountMinor: 1250, shown: 'CA$12.50' },
]) {
  test(`(a) an agent offers ${currency}, a browser accepts, and the capability it minted carries the rest`,
    async ({ page, request }) => {
      const { contract, ownerToken } = await offer(request,
        { currency, amountMinor, label: `a-${currency}` });

      // The guest sees the real amount before agreeing to it. For CAD this is
      // the assertion that catches a reader treating cents as whole units.
      await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
      await page.goto(`/?token=${contract.invite_token}`);
      await expect(page.getByText(shown).first()).toBeVisible({ timeout: 15_000 });

      await acceptInBrowser(page, 'browser-guest@example.invalid');

      // What the browser's own digest computation was recorded as. For a
      // non-JPY agreement this is also proof the mandatory branch was
      // satisfied by the page rather than waived.
      const accepted = await eventsOf(request, contract, ownerToken);
      const check = acceptanceOf(accepted).payload._shown_terms_check;
      expect(check, 'the browser must report the terms it displayed').toBeTruthy();
      expect(check.presented).toBe(true);
      expect(check.verified, 'the server recomputed the browser digest and matched it').toBe(true);
      expect(check.version).toBe(2);

      // The snapshot the evidence rests on carries the agreed sum in minor units.
      const snapshot = acceptanceOf(accepted).payload._agreement;
      expect(snapshot.amount).toBe(amountMinor);
      expect(snapshot.currency).toBe(currency);

      // The capability the BROWSER minted, now read back by an agent.
      const row = await api(request,
        `/rest/v1/contracts?id=eq.${contract.id}&select=guest_access_token,state`,
        { method: 'GET', token: ownerToken });
      const guestToken = row.body[0].guest_access_token;
      expect(guestToken, 'acceptance issues the capability').toBeTruthy();
      expect(row.body[0].state).toBe('TERMS_ACCEPTED');

      // The performer is the creator here, so the owner's agent asserts.
      const asserted = await api(request, '/functions/v1/log-event', {
        token: ownerToken,
        body: { type: 'performance.asserted', contract_id: contract.id, payload: { note: 'Stamped PDF returned' } },
      });
      expect(asserted.status, JSON.stringify(asserted.body)).toBe(201);

      // And the receiver accepts it under the browser-minted capability. This
      // step has no browser control at all (see the header), so an agent is
      // not a shortcut here — it is the only way a guest can take it.
      const confirmed = await api(request, '/functions/v1/log-event', {
        guestToken,
        body: { type: 'performance.accepted', contract_id: contract.id, payload: { note: 'Checked against the agreed list' } },
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

      const final = await eventsOf(request, contract, ownerToken);
      expect(final.map(e => e.type)).toEqual([
        'dod.consent_recorded', 'performance.asserted', 'performance.accepted',
      ]);

      // One credential, minted in a page, accepted by the server for an API
      // write — which is the whole point of this test.
      const reuse = await api(request, '/functions/v1/guest-contract-events', { guestToken, body: {} });
      expect(reuse.status).toBe(200);
      expect(reuse.body.contract.state).toBe('PERFORMANCE_ACCEPTED');
    });
}

// ── (b) owner = browser, guest = agent ──────────────────────────────────────

for (const { currency, amountMinor } of [
  { currency: 'JPY', amountMinor: 50000 },
  { currency: 'CAD', amountMinor: 1250 },
]) {
  test(`(b) an agent accepts ${currency} with a digest from the published spec, and a browser owner delivers`,
    async ({ page, request }) => {
      const { contract, ownerToken } = await offer(request,
        { currency, amountMinor, label: `b-${currency}` });

      // The invitation as an outside client reads it — no browser, no repo.
      const preview = await api(request, '/functions/v1/validate-invite-token', {
        body: { invite_token: contract.invite_token },
      });
      expect(preview.status).toBe(200);

      // Computed by the implementation written from public/agent-protocol.md,
      // which shares none of this project's hashing code.
      const digest = digestV2(preview.body);

      const accepted = await api(request, '/functions/v1/validate-invite-token', {
        body: {
          invite_token: contract.invite_token,
          accept: true,
          hirer_email: 'agent-guest@example.invalid',
          counterparty_name: 'Mixed Surface Agent',
          shown_terms_digest: digest,
          shown_terms_version: 2,
        },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const guestToken = accepted.body.guest_access_token;
      expect(guestToken).toBeTruthy();

      const afterAccept = await eventsOf(request, contract, ownerToken);
      const check = acceptanceOf(afterAccept).payload._shown_terms_check;
      expect(check.presented).toBe(true);
      expect(check.verified, 'the published spec and the server agree').toBe(true);
      expect(check.version).toBe(2);

      // Now the owner, in a real browser, on a real session. Only the LIST is
      // stubbed, and with the real row fetched over the API — the E2E project
      // holds dozens of contracts and "Open" has to be unambiguous. Every
      // write below goes to the live function.
      await signInOwnerInBrowser(page, request);
      const row = await api(request, `/rest/v1/contracts?id=eq.${contract.id}&select=*`,
        { method: 'GET', token: ownerToken });
      await page.route('**/rest/v1/contracts?*', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row.body) });
      });

      await page.goto('/');
      await page.getByRole('button', { name: 'Open' }).first().click();
      await page.getByRole('button', { name: /Mark as delivered/i }).click();
      await page.getByRole('button', { name: /^Confirm$/ }).click();

      // The assertion landed through the live log-event, written by the page.
      await expect.poll(async () => (await eventsOf(request, contract, ownerToken))
        .map(e => e.type), { timeout: 30_000 })
        .toContain('performance.asserted');

      // The receiver is the agent again, under its own capability.
      const confirmed = await api(request, '/functions/v1/log-event', {
        guestToken,
        body: { type: 'performance.accepted', contract_id: contract.id },
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

      const final = await eventsOf(request, contract, ownerToken);
      expect(final.map(e => e.type)).toEqual([
        'dod.consent_recorded', 'performance.asserted', 'performance.accepted',
      ]);
    });
}
