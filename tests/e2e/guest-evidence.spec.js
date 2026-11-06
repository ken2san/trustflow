// Security coverage for the guest Hirer's read access to their evidence trail.
//
// The guest credential is the only thing that selects a contract — the request
// carries no contract id at all — so most of what these tests protect is the
// absence of a way in, not a check that could be bypassed. They exist to fail
// loudly if a contract id is ever accepted from the caller, if the payload
// allowlist is widened, or if runtime snapshots become reachable.
//
// Requires a verified Earner, same as the other live-API suites:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, LIVE_SKIPPED } from './liveEnv.js';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

async function api(request, path, { method = 'POST', token, guestToken, body, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  // Always present a bearer: a user's token when there is one, otherwise the anon
  // key — which is what supabase-js does, and what these tests' own comments mean
  // by "anon key only". Sending `apikey` alone worked on the older project but is
  // refused at the gateway by a newer one (UNAUTHORIZED_NO_AUTH_HEADER), which
  // would turn every negative-auth assertion into a pass for the wrong reason.
  headers.Authorization = `Bearer ${token ?? SUPABASE_KEY}`;
  if (guestToken) headers['x-guest-access-token'] = guestToken;
  if (prefer) headers.Prefer = prefer;
  const response = await request.fetch(`${SUPABASE_URL}${path}`, { method, headers, data: body });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status(), body: parsed };
}

// The Earner session is shared across every live-API suite and cached on disk
// — see earnerSession.js. Five suites each opening their own session put enough
// traffic through Supabase Auth to time out token grants during a full run,
// failing tests that had nothing to do with authentication.
const signInEarner = getEarnerSession;

/**
 * A contract that has been accepted by a guest, with a handful of events on it.
 * Returns the guest credential plus what the guest ought to be able to see.
 */
async function acceptedContract(request, { projectName = 'Guest Evidence Probe' } = {}) {
  const { token, userId } = await signInEarner(request);

  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Evidence Suite Earner',
      project_name: projectName,
      dod: ['deliverable one', 'deliverable two'],
      amount_jpy: 42000,
      currency: 'JPY',
      invited_hirer_email: 'invited@example.test',
    },
  });
  expect(created.status, `contract insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  const contract = created.body[0];

  await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.initiated', contract_id: contract.id, payload: { step: 1 } },
  });

  // Accepting writes its own evidence, in the same transaction. There is no
  // second call to make.
  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'guest.reader@example.test', counterparty_name: 'Guest Reader',
    },
  });
  expect(accept.status).toBe(200);

  return { contract, earnerToken: token, earnerUserId: userId, guestToken: accept.body.guest_access_token };
}

// ── The happy path ──────────────────────────────────────────────────────────

test('a valid guest can read the evidence trail for their own contract', async ({ request }) => {
  const { contract, guestToken } = await acceptedContract(request);

  const { status, body } = await api(request, '/functions/v1/guest-contract-events', { guestToken });

  expect(status).toBe(200);
  expect(body.contract.id).toBe(contract.id);
  expect(body.contract.project_name).toBe('Guest Evidence Probe');
  expect(body.contract.hirer_email).toBe('guest.reader@example.test');

  const types = body.events.map(e => e.type);
  expect(types).toContain('contract.initiated');
  expect(types).toContain('dod.consent_recorded');

  // The guest sees who acted, in terms they can read.
  const consent = body.events.find(e => e.type === 'dod.consent_recorded');
  expect(consent.actor.role).toBe('guest_hirer');
  expect(consent.actor.label).toBe('guest.reader@example.test');

  const initiated = body.events.find(e => e.type === 'contract.initiated');
  expect(initiated.actor.role).toBe('earner');
  expect(initiated.actor.label).toBe('Evidence Suite Earner');

  // Chain verification is reported, and it holds.
  expect(body.chain.verified).toBe(true);
  expect(body.chain.server_attested).toBeGreaterThan(0);
  for (const event of body.events) {
    expect(event.integrity.hash_valid).not.toBe(false);
    expect(event.integrity.chain_linked).not.toBe(false);
    expect(event.integrity.trust_model).toBe('server_attested');
  }
});

// ── Isolation between contracts ─────────────────────────────────────────────

test("a guest token for contract A cannot read contract B", async ({ request }) => {
  const a = await acceptedContract(request, { projectName: 'Contract A' });
  const b = await acceptedContract(request, { projectName: 'Contract B' });

  const asA = await api(request, '/functions/v1/guest-contract-events', { guestToken: a.guestToken });
  expect(asA.status).toBe(200);
  expect(asA.body.contract.id).toBe(a.contract.id);
  expect(asA.body.contract.project_name).toBe('Contract A');

  // Every event returned belongs to A. B's contract id appears nowhere.
  const serialized = JSON.stringify(asA.body);
  expect(serialized).not.toContain(b.contract.id);
  expect(serialized).not.toContain('Contract B');
});

test('the request body cannot change which contract is read', async ({ request }) => {
  const a = await acceptedContract(request, { projectName: 'Body Spoof A' });
  const b = await acceptedContract(request, { projectName: 'Body Spoof B' });

  // Every field an attacker might hope the server reads.
  const { status, body } = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: a.guestToken,
    body: {
      contract_id: b.contract.id,
      id: b.contract.id,
      hirer_email: 'guest.reader@example.test',
      actor_id: b.earnerUserId,
      guest_access_token: b.guestToken,
    },
  });

  expect(status).toBe(200);
  expect(body.contract.id).toBe(a.contract.id);
  expect(JSON.stringify(body)).not.toContain(b.contract.id);
});

// ── Failing closed ──────────────────────────────────────────────────────────

test('an invalid or missing guest token fails closed', async ({ request }) => {
  const missing = await api(request, '/functions/v1/guest-contract-events', {});
  expect(missing.status).toBe(401);
  expect(missing.body.error).toBe('missing_guest_token');

  // Well-formed but unknown, and malformed, are indistinguishable to a caller.
  const unknown = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: '00000000-0000-4000-8000-0000000000ff',
  });
  expect(unknown.status).toBe(403);
  expect(unknown.body.error).toBe('invalid_guest_token');

  const malformed = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: 'not-a-uuid',
  });
  expect(malformed.status).toBe(403);
  expect(malformed.body.error).toBe('invalid_guest_token');
});

// Seeded by 20260924140000. A test cannot age a credential it was just
// issued — guest_access_token_expires_at is server-owned and the client has no
// UPDATE privilege on contracts — so the expiry branch needs a row that is
// already expired. This credential grants nothing; being expired, the only
// response it can produce is the one asserted here.
const EXPIRED_GUEST_TOKEN = 'fffffff0-0000-4000-8000-000000000001';

test('an expired guest token fails closed', async ({ request }) => {
  const { status, body } = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: EXPIRED_GUEST_TOKEN,
  });

  expect(status).toBe(403);
  expect(body.error).toBe('guest_token_expired');
  // Nothing about the contract leaks alongside the refusal.
  expect(body.contract).toBeUndefined();
  expect(body.events).toBeUndefined();
});

test('the client cannot extend its own guest credential', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);

  const patch = await api(request, `/rest/v1/contracts?id=eq.${contract.id}`, {
    method: 'PATCH',
    token: earnerToken,
    body: { guest_access_token_expires_at: '2099-01-01T00:00:00Z' },
  });

  // Even the contract's own Earner holds no UPDATE privilege on contracts.
  expect(patch.status).toBeGreaterThanOrEqual(401);
});

test('a public anonymous client cannot read the trail without a credential', async ({ request }) => {
  const { contract } = await acceptedContract(request);

  // No guest token, anon key only.
  const viaFunction = await api(request, '/functions/v1/guest-contract-events', {});
  expect(viaFunction.status).toBe(401);

  // And the underlying table stays closed to it.
  const viaTable = await api(request,
    `/rest/v1/events?select=id,type,payload&contract_id=eq.${contract.id}`, { method: 'GET' });
  expect(viaTable.status).toBe(200);
  expect(viaTable.body).toEqual([]);
});

// ── Nothing internal leaks ──────────────────────────────────────────────────

test('runtime snapshots and internal rows are never returned', async ({ request }) => {
  const { guestToken } = await acceptedContract(request);

  const { status, body } = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  expect(status).toBe(200);

  const serialized = JSON.stringify(body);
  expect(body.events.some(e => e.type === 'runtime.snapshot')).toBe(false);
  // Snapshot payload keys carry the Earner's whole app state, including their
  // own contact details and other clients' addresses.
  for (const key of ['byocForm', 'uiProfile', 'internalProfile', 'contractHistory',
                     'activityLog', 'badActorFlags', 'selectedItem']) {
    expect(serialized, `snapshot field ${key} leaked`).not.toContain(key);
  }
});

test('internal event fields are omitted and payloads are allowlisted', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);

  // An event whose payload carries a field nobody allowlisted.
  await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: {
      type: 'performance.asserted',
      contract_id: contract.id,
      idempotency_key: 'guest-evidence-secret-key',
      payload: { step: 3, internal_note: 'SHOULD-NOT-REACH-GUEST', user_agent: 'probe-agent/1.0' },
    },
  });

  const { status, body } = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  expect(status).toBe(200);

  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('SHOULD-NOT-REACH-GUEST');
  expect(serialized).not.toContain('probe-agent/1.0');
  expect(serialized).not.toContain('guest-evidence-secret-key');
  expect(serialized).not.toContain('_actor_role');
  expect(serialized).not.toContain('server_recorded_at');

  // Secrets are checked by VALUE, not by field name. Two name checks used to
  // stand here and both were the wrong test. `guest_access_token` as a string
  // would not appear even if the token itself did, since the response would
  // carry the random value and not the key; and `invite_token` DOES appear, as
  // the value of acceptance_identity.authentication_detail.credential, which
  // names the kind of credential used and leaks nothing. So the pair failed on
  // a harmless identifier while being blind to an actual leak.
  expect(serialized, 'the guest credential was echoed back').not.toContain(guestToken);
  if (contract.invite_token) {
    expect(serialized, 'the invite token was echoed back').not.toContain(contract.invite_token);
  }
  // Nothing in this response should be a bare credential-shaped value beyond
  // the identifiers it legitimately carries: the contract, each event, and
  // each actor. Actor ids are deliberate — `canonical.actor_id` is part of
  // what an independent verifier rehashes, so withholding it would make the
  // record unverifiable, which is the opposite of the point.
  const knownIds = new Set([
    contract.id,
    ...body.events.flatMap(e => [e.id, e.actor?.id, e.canonical?.actor_id, e.canonical?.contract_id]),
  ].filter(Boolean));
  const uuids = (serialized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
    .filter(u => !knownIds.has(u));
  expect(uuids, `unexpected credential-shaped values: ${uuids.join(', ')}`).toEqual([]);

  const submitted = body.events.find(e => e.type === 'performance.asserted');
  expect(Object.keys(submitted.payload)).toEqual(['step']);
  // The role survives, lifted out of the payload into a field of its own.
  expect(submitted.actor.role).toBe('earner');
});

// ── The Hirer-facing view, end to end in the browser ────────────────────────

test('a guest accepts an invite and can then read the record in the UI', async ({ page, request }) => {
  const { token, userId } = await signInEarner(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'UI Flow Earner',
      project_name: 'UI Flow Probe',
      dod: ['ship the thing'],
      amount_jpy: 7500,
      currency: 'JPY',
      invited_hirer_email: 'ui.guest@example.test',
    },
  });
  expect(created.status).toBe(201);
  const contract = created.body[0];

  await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.initiated', contract_id: contract.id, payload: { step: 1 } },
  });

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${contract.invite_token}`);

  // Stage 1: review the terms, then move to the consent stage.
  await expect(page.getByText('UI Flow Probe')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Review Agreement|Continue|Accept/i }).first().click();

  // Stage 2: identity plus explicit consent.
  //
  // A distinct address is typed because accepting from one the invitation did
  // NOT go to is the case worth exercising — it is what makes the record carry
  // two addresses, which is the distinction the whole identity section exists
  // to preserve.
  //
  // This comment used to say something else: that the submit button was gated
  // on `guestEmail` alone, so accepting the prefilled address left it
  // permanently disabled, and that the defect was "noted separately". Both
  // halves were false by 2026-11-06 — `acceptingEmail` at InviteView.jsx:174
  // reads the prefilled value when nothing was typed, and no note existed
  // anywhere. A comment is a claim about code; this one outlived the code it
  // described and recorded a defect in the only place nobody looks.
  await page.getByPlaceholder('Your name or handle').fill('UI Guest');
  await page.getByPlaceholder(/Email address/i).fill('ui.actual@example.test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /I Agree/i }).click();

  // The toast and the view heading carry the same words, and the toast is also
  // a heading element. Level 2 is the one that means the view actually
  // switched; the toast renders at level 4.
  await expect(page.getByRole('heading', { name: /Agreement accepted/i, level: 2 }))
    .toBeVisible({ timeout: 15_000 });

  // The credential issued on acceptance is what unlocks the record. The guest
  // reaches the full verification detail from the agreement screen's own link.
  await page.getByRole('button', { name: /View the full verification detail/i }).click();

  await expect(page.getByText(/Record of agreement/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Agreement created')).toBeVisible();
  await expect(page.getByText('Terms accepted')).toBeVisible();
  // Was /Hash chain verified/. That wording was the defect three blind reviews
  // circled: it named no one as having verified, while the download note below
  // it told the reader they could not check it themselves. The line now says
  // who recomputed it, so the assertion follows — and it asserts the actor,
  // which is the part that was missing, not the phrasing.
  await expect(page.getByText(/TrustFlow recomputed every server-attested event/i)).toBeVisible();
  // The trail says who acted, in readable terms rather than raw ids. The name
  // also appears in the header ("… — with UI Flow Earner") and again on each
  // trail entry ("by UI Flow Earner"), so this is scoped to the trail list. It
  // previously matched both and failed strict mode; the assertion was wrong
  // rather than the page.
  await expect(page.locator('ol').getByText('UI Flow Earner', { exact: true }).first())
    .toBeVisible();
  // And the guest's own entry is attributed to them. The address shows twice —
  // as the actor label and as the allowlisted counterparty_email detail — so
  // this asserts presence rather than uniqueness.
  await expect(page.getByText('ui.actual@example.test', { exact: true }).first()).toBeVisible();

  // And it states what the hash covers without overstating it. These events are
  // written under canonical v3, so the detail fields are covered — and the view
  // is explicit that a record of what was stated is not a finding that it is true.
  await expect(page.getByText(/also covers the detail fields/i)).toBeVisible();
  await expect(page.getByText(/does not establish that a statement is true/i)).toBeVisible();
});

test('the response states whether payloads are covered by the hash', async ({ request }) => {
  const { guestToken } = await acceptedContract(request);

  const { body } = await api(request, '/functions/v1/guest-contract-events', { guestToken });

  // Events written under canonical v3 bind a hash of the payload, so on a
  // trail made up entirely of such events the detail fields ARE tamper-evident
  // and the response says so. The flag is per-trail rather than constant: a
  // trail containing a pre-v3 event reports false, because its substance was
  // never attested.
  expect(body.chain.payload_covered_by_hash).toBe(true);
});

// ── Promoted from blind counterparty runs, 2026-11-06 ────────────────────────
//
// Each of these fixes a hole that every suite in this repository passed
// through. They are here rather than in a new file because they need the same
// acceptance machinery the tests above already have, and a second file would
// have meant a second copy of it.

test('a guest who navigates away can still reach the agreement they accepted', async ({ page, request }) => {
  // THE DEFECT THIS PINS
  // The credential issued at acceptance is stored in localStorage under the
  // contract id. Every reader of it needed an id first, and nothing could ask
  // which ids were present — so a guest who left the agreement screen had no
  // route back, while their token sat in the browser for ninety days. The
  // invitation link, revisited, told them their record was reachable from "the
  // access link you were given when you accepted". No such link is given.
  //
  // Found by a blind counterparty asked to accept and then look for its own
  // record. The first blind run declined, so it never reached this.
  const { token, userId } = await signInEarner(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Return Path Earner',
      project_name: 'Return Path Probe',
      dod: ['do the thing'],
      amount_jpy: 20000,
      currency: 'JPY',
      invited_hirer_email: 'return.invited@example.test',
    },
  });
  expect(created.status).toBe(201);
  const contract = created.body[0];

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${contract.invite_token}`);

  await expect(page.getByText('Return Path Probe')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Review Agreement|Continue|Accept/i }).first().click();
  await page.getByPlaceholder('Your name or handle').fill('Return Path Guest');
  await page.getByPlaceholder(/Email address/i).fill('return.actual@example.test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /I Agree/i }).click();
  await expect(page.getByRole('heading', { name: /Agreement accepted/i, level: 2 }))
    .toBeVisible({ timeout: 15_000 });

  // Leaving the way a person leaves: a fresh load of the site, with no token
  // in the URL. Everything the guest has is what the browser kept.
  await page.goto('/');

  // The agreement is offered, and the id is the one they accepted.
  const offer = page.getByRole('button', { name: /Open the agreement you accepted/i });
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(contract.id, { exact: true })).toBeVisible();

  // And it opens, on the stored credential alone.
  await offer.click();
  await expect(page.getByText('Return Path Probe')).toBeVisible({ timeout: 15_000 });
});

test('declining records nothing and leaves the invitation usable', async ({ page, request }) => {
  // THE DEFECT THIS PINS
  // Declining cleared the URL and dropped the reader on the app's home screen
  // with no acknowledgement — "断れたのか分からない" — and, for a browser
  // holding a session, on the operator's own contract list. A refusal is not
  // an act on the agreement, so nothing is written; the screen has to say so,
  // and the invitation has to still work, because reconsidering is the common
  // case and the link is the only way back.
  const { token, userId } = await signInEarner(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Decline Path Earner',
      project_name: 'Decline Path Probe',
      dod: ['do the thing'],
      amount_jpy: 20000,
      currency: 'JPY',
      invited_hirer_email: 'decline.invited@example.test',
    },
  });
  expect(created.status).toBe(201);
  const contract = created.body[0];

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${contract.invite_token}`);
  await expect(page.getByText('Decline Path Probe')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /Not interested/i }).click();

  // It says what did NOT happen, which is what the reader is uncertain about.
  await expect(page.getByRole('heading', { name: /You did not accept/i })).toBeVisible();
  await expect(page.getByText(/Nothing was recorded and nothing was sent/i)).toBeVisible();
  await expect(page.getByText(/not told/i)).toBeVisible();

  // The invitation really is unspent: the server still answers for it.
  const stillOffered = await api(request, '/functions/v1/validate-invite-token', {
    body: { invite_token: contract.invite_token },
  });
  expect(stillOffered.status).toBe(200);
  expect(stillOffered.body.project_name).toBe('Decline Path Probe');

  // And the reader can go back to the terms without reloading anything.
  await page.getByRole('button', { name: /Look at the terms again/i }).click();
  await expect(page.getByText('Decline Path Probe')).toBeVisible();
});
