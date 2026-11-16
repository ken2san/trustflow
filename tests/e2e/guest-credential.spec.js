// What a guest credential can still do once it is replaced or expired, tested
// against the live system, plus the keyed replay that a live one gets.
//
// Scope, stated so a pass is not over-read: these are sequential HTTP checks.
// A token that is already replaced or expired fails log-event's pre-check
// (resolveActor) and is answered `not_a_party` before either locked RPC runs.
// The locked statuses `guest_credential_revoked` / `guest_credential_expired`
// arise only when a credential dies between that pre-check and the row lock —
// the in-flight race — which no sequential request can produce. That boundary
// is covered by the migration's self-test and scripts/race-guest-reissue-vs-
// append.sh, not here.
//
// "Nothing was written" is measured, not inferred from a repeated refusal: the
// owning Earner reads the contract's event set before and after each refusal.
//
// Requires a verified Earner:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL, LIVE_SKIPPED } from './liveEnv.js';
import { assertE2EProject } from '../../scripts/lib/e2eGuard.mjs';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

// Every test here writes permanent events. Refuse, never skip, anywhere else.
assertE2EProject(SUPABASE_URL);

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

// Same token as guest-evidence: the fixture from 20260924140000, expired 2020.
const EXPIRED_CONTRACT_ID = 'fffffff0-0000-4000-8000-000000000000';
const EXPIRED_GUEST_TOKEN = 'fffffff0-0000-4000-8000-000000000001';

const uniqueKey = label => `guest-credential:${label}:${randomUUID()}`;

/**
 * The cached Earner session, proven to be the E2E test account. A cache left
 * over from another account or project fails here rather than writing as it.
 * Nothing identifying is put in an assertion message.
 */
async function testEarner(request) {
  const { token, userId } = await getEarnerSession(request);
  const who = await api(request, '/auth/v1/user', { method: 'GET', token });
  expect(who.status, 'earner session is not valid on the E2E project').toBe(200);
  const isTestAccount = who.body?.id === userId
    && who.body?.is_anonymous !== true
    && String(who.body?.email ?? '').toLowerCase() === String(EARNER_EMAIL ?? '').toLowerCase();
  expect(isTestAccount, 'earner session is not the configured E2E test account').toBe(true);
  return { token, userId };
}

/** The contract's events as the owning Earner can read them: id, type, key. */
async function ownerEventSet(request, token, contractId) {
  const read = await api(request,
    `/rest/v1/events?select=id,type,idempotency_key&contract_id=eq.${contractId}&order=id`,
    { method: 'GET', token });
  expect(read.status, `owner event read failed: ${JSON.stringify(read.body)}`).toBe(200);
  return read.body.map(e => `${e.id}|${e.type}|${e.idempotency_key ?? ''}`);
}

/** An agreement the guest performs, accepted through the real invite path. */
async function guestPerformedAgreement(request) {
  const { token, userId } = await testEarner(request);

  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Guest Credential Suite',
      project_name: 'Guest credential probe',
      dod: ['deliver the probe'],
      amount_jpy: 1000,
      amount_minor: 1000,
      currency: 'JPY',
      performed_by: 'counterparty',
      invited_hirer_email: 'guest.credential@example.test',
    },
  });
  expect(created.status, `contract insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  const contract = created.body[0];

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'guest.credential@example.test', counterparty_name: 'Credential Guest',
    },
  });
  expect(accept.status, `acceptance failed: ${accept.body?.error}`).toBe(200);
  const guestToken = accept.body.guest_access_token;

  // The guest really is the performer, and is recorded under the identity a
  // replay is matched on (guest:<hirer_email>).
  const trail = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  expect(trail.status).toBe(200);
  expect(trail.body.accepted_agreement.performed_by).toBe('counterparty');
  expect(trail.body.contract.viewer_role).toBe('performer');

  const row = await api(request,
    `/rest/v1/contracts?select=hirer_email&id=eq.${contract.id}`, { method: 'GET', token });
  expect(row.status).toBe(200);
  expect(row.body[0].hirer_email).toBe('guest.credential@example.test');

  return { contract, earnerToken: token, guestToken };
}

const logEvent = (request, auth, body) =>
  api(request, '/functions/v1/log-event', { ...auth, body });

// ── a. Keyed guest replay ───────────────────────────────────────────────────

test('a guest retry with the same key returns the original event, even after the chain moved', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await guestPerformedAgreement(request);
  const key = uniqueKey('replay');

  const first = await logEvent(request, { guestToken },
    { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key });
  expect(first.status, `first write failed: ${first.body?.error}`).toBe(201);
  expect(first.body.deduplicated).toBe(false);
  const eventId = first.body.event.id;
  expect(eventId).toBeTruthy();

  // The tip moves, and the agreement leaves the state in which a new
  // performance.asserted would be permitted — so only a replay can answer 200.
  const confirm = await logEvent(request, { token: earnerToken },
    { type: 'performance.accepted', contract_id: contract.id });
  expect(confirm.status, `earner confirm failed: ${confirm.body?.error}`).toBe(201);

  const before = await ownerEventSet(request, earnerToken, contract.id);

  const retry = await logEvent(request, { guestToken },
    { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key });
  expect(retry.status, `replay failed: ${retry.body?.error}`).toBe(200);
  expect(retry.body.deduplicated).toBe(true);
  expect(retry.body.event.id).toBe(eventId);

  // The same key for a different type the guest may submit is a collision,
  // answered without an event.
  const collision = await logEvent(request, { guestToken },
    { type: 'dispute.opened', contract_id: contract.id, idempotency_key: key });
  expect(collision.status).toBe(409);
  expect(collision.body.error).toBe('idempotency_key_in_use');
  expect(collision.body.event).toBeUndefined();

  expect(await ownerEventSet(request, earnerToken, contract.id)).toEqual(before);
});

// ── b. Reissue refuses the old token ────────────────────────────────────────

test('after a reissue the old token can neither append nor replay, and the new one can', async ({ request }) => {
  const { contract, earnerToken, guestToken: oldToken } = await guestPerformedAgreement(request);
  const key = uniqueKey('reissue');

  const first = await logEvent(request, { guestToken: oldToken },
    { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key });
  expect(first.status, `first write failed: ${first.body?.error}`).toBe(201);
  const eventId = first.body.event.id;

  const reissue = await api(request, '/functions/v1/reissue-guest-access', {
    token: earnerToken, body: { contract_id: contract.id },
  });
  expect(reissue.status, `reissue failed: ${reissue.body?.error}`).toBe(200);
  const newToken = reissue.body.guest_access_token;
  expect(typeof newToken).toBe('string');
  expect(newToken !== oldToken, 'reissue returned the same token').toBe(true);

  const before = await ownerEventSet(request, earnerToken, contract.id);

  const oldAppend = await logEvent(request, { guestToken: oldToken },
    { type: 'dispute.opened', contract_id: contract.id, idempotency_key: uniqueKey('old-append') });
  expect(oldAppend.status).toBe(403);
  expect(oldAppend.body.error).toBe('not_a_party');
  expect(oldAppend.body.event).toBeUndefined();
  expect(await ownerEventSet(request, earnerToken, contract.id)).toEqual(before);

  // A retry of a write the old token itself made is refused too, and does
  // not hand the event back.
  const oldReplay = await logEvent(request, { guestToken: oldToken },
    { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key });
  expect(oldReplay.status).toBe(403);
  expect(oldReplay.body.error).toBe('not_a_party');
  expect(oldReplay.body.event).toBeUndefined();
  expect(await ownerEventSet(request, earnerToken, contract.id)).toEqual(before);

  // Controls: the same guest, holding the new token, replays its own write
  // (the replay matches on guest:<hirer_email>, unchanged by a reissue)...
  const newReplay = await logEvent(request, { guestToken: newToken },
    { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key });
  expect(newReplay.status, `new-token replay failed: ${newReplay.body?.error}`).toBe(200);
  expect(newReplay.body.deduplicated).toBe(true);
  expect(newReplay.body.event.id).toBe(eventId);

  // ...and can append.
  const newAppend = await logEvent(request, { guestToken: newToken },
    { type: 'rating.submitted', contract_id: contract.id, idempotency_key: uniqueKey('new-append') });
  expect(newAppend.status, `new-token append failed: ${newAppend.body?.error}`).toBe(201);
  expect(newAppend.body.deduplicated).toBe(false);

  const after = await ownerEventSet(request, earnerToken, contract.id);
  expect(after.length).toBe(before.length + 1);
  expect(after.some(e => e.startsWith(`${newAppend.body.event.id}|`))).toBe(true);
});

// ── c. Expiry ───────────────────────────────────────────────────────────────

test('an expired guest token cannot write, and nothing lands', async ({ request }) => {
  const { token: earnerToken, userId } = await testEarner(request);

  // Rely on the fixture only after seeing it: present, owned by this Earner
  // (so its events are observable), and really expired. It is not modified.
  const fixture = await api(request,
    `/rest/v1/contracts?select=id,earner_user_id,state,performed_by,guest_access_token,guest_access_token_expires_at`
      + `&id=eq.${EXPIRED_CONTRACT_ID}`,
    { method: 'GET', token: earnerToken });
  expect(fixture.status).toBe(200);
  expect(fixture.body.length, 'expired fixture is missing or not readable by the test Earner').toBe(1);
  const row = fixture.body[0];
  expect(row.earner_user_id === userId, 'expired fixture is not owned by the test Earner').toBe(true);
  expect(row.guest_access_token === EXPIRED_GUEST_TOKEN, 'fixture token differs from the expected one').toBe(true);
  expect(new Date(row.guest_access_token_expires_at).getTime()).toBeLessThan(Date.now());

  const before = await ownerEventSet(request, earnerToken, EXPIRED_CONTRACT_ID);

  // Otherwise a valid guest request: an allowed type with no role
  // requirement, a fresh key, an existing contract. Only the credential is
  // wrong, so the pre-check's `not_a_party` is the answer, not a role or
  // state refusal.
  const attempt = await logEvent(request, { guestToken: EXPIRED_GUEST_TOKEN },
    { type: 'dispute.opened', contract_id: EXPIRED_CONTRACT_ID, idempotency_key: uniqueKey('expired') });
  expect(attempt.status).toBe(403);
  expect(attempt.body.error).toBe('not_a_party');
  expect(attempt.body.event).toBeUndefined();

  expect(await ownerEventSet(request, earnerToken, EXPIRED_CONTRACT_ID)).toEqual(before);
});
