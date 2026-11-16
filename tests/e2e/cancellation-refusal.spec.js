// contract.cancelled after Task 81: new writes are refused, and only a keyed
// retry of one already recorded is answered with that event.
//
// Two halves, and they need different things:
//   - Refusals use fresh contracts made here. They need only the deployed
//     log-event that refuses the type.
//   - Replays need cancellations recorded BEFORE that deploy, because the new
//     endpoint cannot create one. Those come from a fixture file written once,
//     against E2E, while the old log-event was still serving (see
//     .ada/claude-report-82.md). Without it this suite fails rather than skips:
//     a replay test that quietly did not run is the failure noSilentSkip exists for.
//
// "Nothing written" is measured: the owning Earner reads the contract's event
// set before and after each refusal.
//
// Requires a verified Earner (TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD)
// and tests/e2e/.cancel-fixture.json (gitignored, mode 0600: it holds a guest
// token).

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL, LIVE_SKIPPED } from './liveEnv.js';
import { E2E_PROJECT_REF, assertE2EProject } from '../../scripts/lib/e2eGuard.mjs';
import { readCredentialFile } from '../../scripts/lib/credentialFile.mjs';

test.skip(LIVE_SKIPPED,
  'TF_LIVE_E2E=skip — the live-API suites were deliberately disabled.');

// Every test here can write permanent events. Refuse, never skip, anywhere else.
assertE2EProject(SUPABASE_URL);

const FIXTURE_FILE = process.env.TF_CANCEL_FIXTURE
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.cancel-fixture.json');

const LOCK_FILE = `${FIXTURE_FILE}.lock`;

const CANCELLED = 'contract.cancelled';

// One fixture contract is shared: the guest test reissues its access, which
// adds an event and revokes the guest token, while the owner test compares
// its event set. So the tests run in one worker, in order, and a second run
// anywhere on this machine is refused rather than allowed to race it
// (Codex Task 87). A lock left by a dead process is taken over; a live
// holder is never waited for.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(LOCK_FILE, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
      await lock.close();
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(await readFile(LOCK_FILE, 'utf8')).pid; } catch { /* unreadable: treat as live */ }
      let alive = true;
      if (Number.isSafeInteger(holder) && holder > 0) {
        try { process.kill(holder, 0); } catch (e) { alive = e?.code !== 'ESRCH'; }
      }
      if (alive) {
        throw new Error(`another run holds ${path.basename(LOCK_FILE)}; this suite does not run concurrently`,
          { cause: error });
      }
      await rm(LOCK_FILE, { force: true });
    }
  }
  throw new Error(`could not take ${path.basename(LOCK_FILE)}`);
});

test.afterAll(async () => {
  try {
    if (JSON.parse(await readFile(LOCK_FILE, 'utf8')).pid === process.pid) await rm(LOCK_FILE, { force: true });
  } catch { /* already gone */ }
});

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

// Messages carry a status and an error code, never a response body.
const errorCode = body => String(body?.error ?? body?.code ?? '');
const uniqueKey = label => `cancellation-refusal:${label}:${randomUUID()}`;
const logEvent = (request, auth, body) => api(request, '/functions/v1/log-event', { ...auth, body });

/** The cached Earner session, proven to be the configured E2E test account. */
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
  expect(read.status, `owner event read failed: ${read.status} ${errorCode(read.body)}`).toBe(200);
  return read.body.map(e => `${e.id}|${e.type}|${e.idempotency_key ?? ''}`);
}

/** A fresh agreement, accepted through the real invite path. */
async function acceptedContract(request) {
  const { token, userId } = await testEarner(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Cancellation Refusal Suite',
      project_name: 'Cancellation refusal probe',
      dod: ['deliver the probe'],
      amount_jpy: 1000,
      amount_minor: 1000,
      currency: 'JPY',
      invited_hirer_email: 'cancel.refusal@example.test',
    },
  });
  expect(created.status, `contract insert failed: ${created.status} ${errorCode(created.body)}`).toBe(201);
  const contract = created.body[0];

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'cancel.refusal@example.test', counterparty_name: 'Refusal Guest',
    },
  });
  expect(accept.status, `acceptance failed: ${errorCode(accept.body)}`).toBe(200);
  return { contract, earnerToken: token, guestToken: accept.body.guest_access_token };
}

/**
 * The cancellations recorded before the refusal was deployed. Checked before
 * it is relied on: right project, owned by the test Earner, and both events
 * still present as recorded. Never modified here.
 */
async function recordedFixture(request, earnerToken, earnerUserId) {
  let fixture;
  try {
    fixture = await readCredentialFile(FIXTURE_FILE);
  } catch (error) {
    throw new Error(`cancellation fixture unavailable (${error.code ?? error.name}); `
      + 'it must be recorded on E2E before the refusing log-event is deployed', { cause: error });
  }
  expect(fixture.status === 'complete', 'fixture recording did not finish; see its recovery notes').toBe(true);
  for (const field of ['project_ref', 'contract_id', 'owner_key', 'owner_event_id',
    'guest_key', 'guest_event_id', 'guest_token_at_record']) {
    expect(typeof fixture[field] === 'string' && fixture[field] !== '', `fixture lacks ${field}`).toBe(true);
  }
  expect(fixture.project_ref === E2E_PROJECT_REF, 'fixture was recorded on another project').toBe(true);

  const row = await api(request,
    `/rest/v1/contracts?select=earner_user_id&id=eq.${fixture.contract_id}`, { method: 'GET', token: earnerToken });
  expect(row.status).toBe(200);
  expect(row.body.length === 1 && row.body[0].earner_user_id === earnerUserId,
    'fixture contract is missing or not owned by the test Earner').toBe(true);

  const events = await ownerEventSet(request, earnerToken, fixture.contract_id);
  expect(events).toContain(`${fixture.owner_event_id}|${CANCELLED}|${fixture.owner_key}`);
  expect(events).toContain(`${fixture.guest_event_id}|${CANCELLED}|${fixture.guest_key}`);
  return fixture;
}

// ── New writes are refused ──────────────────────────────────────────────────

test('the owner cannot record a new contract.cancelled, with or without a key', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);
  const before = await ownerEventSet(request, earnerToken, contract.id);

  for (const idempotency_key of [undefined, '', uniqueKey('owner-new')]) {
    const r = await logEvent(request, { token: earnerToken },
      { type: CANCELLED, contract_id: contract.id, idempotency_key });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('type_not_allowed');
    expect(r.body.event).toBeUndefined();
    expect(await ownerEventSet(request, earnerToken, contract.id)).toEqual(before);
  }
});

test('the guest cannot record a new contract.cancelled, with or without a key', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);
  const before = await ownerEventSet(request, earnerToken, contract.id);

  for (const idempotency_key of [undefined, '', uniqueKey('guest-new')]) {
    const r = await logEvent(request, { guestToken },
      { type: CANCELLED, contract_id: contract.id, idempotency_key });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('type_not_allowed');
    expect(r.body.event).toBeUndefined();
    expect(await ownerEventSet(request, earnerToken, contract.id)).toEqual(before);
  }
});

// ── Recorded ones replay; nothing else does ─────────────────────────────────

test('the owner\'s recorded cancellation replays, and its key collides for anything else', async ({ request }) => {
  const { token: earnerToken, userId } = await testEarner(request);
  const fixture = await recordedFixture(request, earnerToken, userId);
  const before = await ownerEventSet(request, earnerToken, fixture.contract_id);

  const replay = await logEvent(request, { token: earnerToken },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: fixture.owner_key });
  expect(replay.status, `owner replay failed: ${errorCode(replay.body)}`).toBe(200);
  expect(replay.body.deduplicated).toBe(true);
  expect(replay.body.event.id).toBe(fixture.owner_event_id);

  // Same key, another type the owner may write: a collision, not a write.
  const collision = await logEvent(request, { token: earnerToken },
    { type: 'dispute.opened', contract_id: fixture.contract_id, idempotency_key: fixture.owner_key });
  expect(collision.status).toBe(409);
  expect(collision.body.error).toBe('idempotency_key_in_use');
  expect(collision.body.event).toBeUndefined();

  // A key that was never used is a new cancellation, and refused.
  const fresh = await logEvent(request, { token: earnerToken },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: uniqueKey('owner-fresh') });
  expect(fresh.status).toBe(400);
  expect(fresh.body.error).toBe('type_not_allowed');

  expect(await ownerEventSet(request, earnerToken, fixture.contract_id)).toEqual(before);
});

test('the guest\'s recorded cancellation replays only with a live token', async ({ request }) => {
  const { token: earnerToken, userId } = await testEarner(request);
  const fixture = await recordedFixture(request, earnerToken, userId);

  // Each run replaces the guest credential, so the token the cancellation was
  // recorded with is revoked whatever state earlier runs left — and the guest
  // replay never depends on that token's 30-day lifetime.
  const reissue = await api(request, '/functions/v1/reissue-guest-access', {
    token: earnerToken, body: { contract_id: fixture.contract_id },
  });
  expect(reissue.status, `reissue failed: ${errorCode(reissue.body)}`).toBe(200);
  const liveToken = reissue.body.guest_access_token;
  expect(typeof liveToken === 'string' && liveToken !== fixture.guest_token_at_record,
    'reissue did not replace the recorded token').toBe(true);

  const before = await ownerEventSet(request, earnerToken, fixture.contract_id);

  // The revoked token cannot read its own cancellation back.
  const revoked = await logEvent(request, { guestToken: fixture.guest_token_at_record },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: fixture.guest_key });
  expect(revoked.status).toBe(403);
  expect(revoked.body.error).toBe('not_a_party');
  expect(revoked.body.event).toBeUndefined();

  // The same guest, holding the live token, replays it (matched on
  // guest:<hirer_email>, which a reissue does not change).
  const replay = await logEvent(request, { guestToken: liveToken },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: fixture.guest_key });
  expect(replay.status, `guest replay failed: ${errorCode(replay.body)}`).toBe(200);
  expect(replay.body.deduplicated).toBe(true);
  expect(replay.body.event.id).toBe(fixture.guest_event_id);

  // The owner's key is another actor's: a collision, without the owner's event.
  const collision = await logEvent(request, { guestToken: liveToken },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: fixture.owner_key });
  expect(collision.status).toBe(409);
  expect(collision.body.error).toBe('idempotency_key_in_use');
  expect(collision.body.event).toBeUndefined();

  // A key that was never used is a new cancellation, and refused.
  const fresh = await logEvent(request, { guestToken: liveToken },
    { type: CANCELLED, contract_id: fixture.contract_id, idempotency_key: uniqueKey('guest-fresh') });
  expect(fresh.status).toBe(400);
  expect(fresh.body.error).toBe('type_not_allowed');

  expect(await ownerEventSet(request, earnerToken, fixture.contract_id)).toEqual(before);
});
