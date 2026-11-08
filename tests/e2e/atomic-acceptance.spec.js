// Acceptance and its evidence are one operation, or neither happens.
//
// THE INVARIANT UNDER TEST
// TrustFlow must never show a contract as accepted unless the authoritative
// acceptance evidence for that exact agreement was recorded in the same atomic
// operation. Under canonical v4 that event carries the agreement snapshot, so
// its absence is not a missing log line — it is the absence of any record of
// what was agreed.
//
// The old flow could produce exactly that: validate-invite-token consumed the
// invitation and moved the contract, and the browser then called log-event.
// Anything failing in between left an accepted contract with no evidence.
//
// Every test below asks the same question from a different angle: can this
// system be made to hold an accepted state that no acceptance event explains?
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

const TERMS = {
  project_name: 'Atomic acceptance probe',
  dod: ['translate the document'],
  amount_jpy: 20000,
  amount_minor: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
};

/** An unaccepted contract with a live invitation. */
async function invited(request, overrides = {}) {
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
  expect(created.status, `contract insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  return { contract: created.body[0], earnerToken: token };
}

const acceptWith = (request, inviteToken, body = {}) =>
  api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: inviteToken, accept: true,
      hirer_email: 'invited@example.test', counterparty_name: 'Guest',
      ...body,
    },
  });

/** What the database now holds for this contract — state and acceptance events. */
async function stateOf(request, contract, token) {
  const [row, events] = await Promise.all([
    api(request, `/rest/v1/contracts?id=eq.${contract.id}&select=state,hirer_email,invite_token_used_at,guest_access_token`,
      { method: 'GET', token }),
    api(request, `/rest/v1/events?contract_id=eq.${contract.id}&select=id,type,event_hash,prev_event_hash,payload,agreement_hash&order=created_at.asc`,
      { method: 'GET', token }),
  ]);
  const all = events.body ?? [];
  return {
    contract: row.body?.[0] ?? null,
    events: all,
    acceptances: all.filter(e => e.type === 'dod.consent_recorded'),
  };
}

// ── The invariant, stated directly ──────────────────────────────────────────

test('an accepted contract always carries the evidence of its acceptance', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  const accepted = await acceptWith(request, contract.invite_token);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  // The response names the record, so the caller never has to assume it exists.
  expect(accepted.body.acceptance_event_id).toBeTruthy();

  const after = await stateOf(request, contract, earnerToken);
  expect(after.contract.state).toBe('TERMS_ACCEPTED');
  expect(after.contract.invite_token_used_at).toBeTruthy();
  expect(after.acceptances).toHaveLength(1);
  expect(after.acceptances[0].id).toBe(accepted.body.acceptance_event_id);
  // And it is evidence, not a marker: the agreed deal is inside it.
  expect(after.acceptances[0].payload._agreement.amount).toBe(TERMS.amount_jpy);
  expect(after.acceptances[0].agreement_hash).toBeTruthy();
});

// ── A refused acceptance leaves nothing behind ──────────────────────────────

test('reusing a consumed invitation changes nothing and adds no second record', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  const first = await acceptWith(request, contract.invite_token);
  expect(first.status).toBe(200);
  const afterFirst = await stateOf(request, contract, earnerToken);

  // Same invitation, a different claimed identity — a replay, not a retry.
  const replay = await acceptWith(request, contract.invite_token,
    { hirer_email: 'attacker@example.test' });
  expect(replay.status).toBe(410);
  expect(replay.body.error).toBe('already_used');

  const afterReplay = await stateOf(request, contract, earnerToken);
  expect(afterReplay.acceptances).toHaveLength(1);
  expect(afterReplay.acceptances[0].id).toBe(afterFirst.acceptances[0].id);
  // The recorded identity is the one that actually accepted, and a replay
  // cannot re-mint a guest credential either.
  expect(afterReplay.contract.hirer_email).toBe('invited@example.test');
  expect(afterReplay.contract.guest_access_token).toBe(afterFirst.contract.guest_access_token);
});

test('a retried acceptance request cannot append a second acceptance', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  await acceptWith(request, contract.invite_token);
  // Identical request, as a client retry after a lost response would send it.
  const retry = await acceptWith(request, contract.invite_token);
  expect(retry.status).toBe(410);

  expect((await stateOf(request, contract, earnerToken)).acceptances).toHaveLength(1);
});

test('an unknown invitation leaves the contract unaccepted and unrecorded', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  // Not "expired": invite_token_expires_at is server-owned and cannot be set on
  // insert, so a genuinely time-expired row is not constructible from a test.
  // An unknown token is the reachable refusal, and the property being checked —
  // a refused acceptance writes neither half — is the same one. Consumption is
  // covered separately above.
  const unknown = await acceptWith(request, '00000000-0000-4000-8000-000000000000');
  expect(unknown.status).toBe(404);

  const after = await stateOf(request, contract, earnerToken);
  expect(after.contract.state).not.toBe('TERMS_ACCEPTED');
  expect(after.acceptances).toHaveLength(0);
  expect(after.contract.invite_token_used_at).toBeNull();
});

test('a malformed acceptance writes neither the state nor an event', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  const noEmail = await api(request, '/functions/v1/validate-invite-token', {
    body: { invite_token: contract.invite_token, accept: true },
  });
  expect(noEmail.status).toBe(400);

  const badEmail = await acceptWith(request, contract.invite_token, { hirer_email: 'not-an-email' });
  expect(badEmail.status).toBe(400);

  const after = await stateOf(request, contract, earnerToken);
  expect(after.contract.state).not.toBe('TERMS_ACCEPTED');
  expect(after.contract.invite_token_used_at).toBeNull();
  expect(after.acceptances).toHaveLength(0);
  // The invitation is still usable — a rejected request must not burn it.
  expect((await acceptWith(request, contract.invite_token)).status).toBe(200);
});

// ── Concurrency ─────────────────────────────────────────────────────────────

test('two simultaneous acceptances produce one acceptance, not two', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  // The row lock inside accept_invitation serializes these. The previous
  // conditional update guarded the contract row but not the event, so two
  // racing accepts could each have gone on to append their own.
  const results = await Promise.all([
    acceptWith(request, contract.invite_token, { hirer_email: 'first@example.test' }),
    acceptWith(request, contract.invite_token, { hirer_email: 'second@example.test' }),
    acceptWith(request, contract.invite_token, { hirer_email: 'third@example.test' }),
  ]);

  const won = results.filter(r => r.status === 200);
  const lost = results.filter(r => r.status === 410);
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(2);

  const after = await stateOf(request, contract, earnerToken);
  expect(after.acceptances).toHaveLength(1);
  expect(after.acceptances[0].id).toBe(won[0].body.acceptance_event_id);
  // The identity recorded belongs to the request that actually won.
  expect(after.acceptances[0].payload._claimed_identity).toBe(after.contract.hirer_email);
});

// ── The chain the acceptance joins ──────────────────────────────────────────

test('the acceptance links to the chain tip that existed when it committed', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  // Give the contract a history first, so the acceptance is not the genesis.
  const initiated = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'contract.initiated', contract_id: contract.id, payload: { step: 1 } },
  });
  expect(initiated.status).toBe(201);

  const accepted = await acceptWith(request, contract.invite_token);
  expect(accepted.status).toBe(200);

  const after = await stateOf(request, contract, earnerToken);
  const acceptance = after.acceptances[0];
  expect(acceptance.prev_event_hash).toBe(initiated.body.event.event_hash);

  // And the trail as the guest reads it verifies end to end.
  const trail = await api(request, '/functions/v1/guest-contract-events', {
    guestToken: accepted.body.guest_access_token,
  });
  expect(trail.body.chain.verified).toBe(true);
  expect(trail.body.accepted_agreement.amount).toBe(TERMS.amount_jpy);
});

// ── The client cannot author the record any more ────────────────────────────

test('a guest cannot add an acceptance of their own through log-event', async ({ request }) => {
  const { contract } = await invited(request);
  const accepted = await acceptWith(request, contract.invite_token);
  expect(accepted.status).toBe(200);

  // A second acceptance, taken at a later moment and therefore possibly of
  // different terms, would leave two records and no rule for which is the
  // agreement. The type is no longer writable by a party at all.
  const forged = await api(request, '/functions/v1/log-event', {
    guestToken: accepted.body.guest_access_token,
    body: {
      type: 'dod.consent_recorded',
      contract_id: contract.id,
      payload: { counterparty_name: 'Guest', _agreement: { amount: 1 } },
    },
  });
  expect(forged.status).toBe(400);
  expect(forged.body.error).toBe('type_is_server_recorded');
});

test('nothing in the acceptance request can choose what the record says', async ({ request }) => {
  const { contract, earnerToken } = await invited(request);

  const accepted = await acceptWith(request, contract.invite_token, {
    // Every one of these is derived server-side. Sending them must change
    // nothing at all.
    actor_id: 'spoofed@example.test',
    agreement_hash: 'a-deal-nobody-made',
    event_hash: 'forged',
    payload: { _agreement: { amount: 1, dod: ['whatever I like'] } },
    state: 'SETTLED',
  });
  expect(accepted.status).toBe(200);

  const after = await stateOf(request, contract, earnerToken);
  const acceptance = after.acceptances[0];
  expect(after.contract.state).toBe('TERMS_ACCEPTED');
  expect(acceptance.agreement_hash).not.toBe('a-deal-nobody-made');
  expect(acceptance.event_hash).not.toBe('forged');
  expect(acceptance.payload._agreement.amount).toBe(TERMS.amount_jpy);
  expect(JSON.stringify(acceptance.payload)).not.toContain('whatever I like');
  expect(JSON.stringify(acceptance.payload)).not.toContain('spoofed@example.test');
});

// ── Both directions of the deal ─────────────────────────────────────────────

test('an agreement where the guest performs is accepted atomically too', async ({ request }) => {
  const { contract, earnerToken } = await invited(request, { performed_by: 'counterparty' });

  const accepted = await acceptWith(request, contract.invite_token);
  expect(accepted.status).toBe(200);

  const after = await stateOf(request, contract, earnerToken);
  expect(after.acceptances).toHaveLength(1);
  expect(after.acceptances[0].payload._agreement.performed_by).toBe('counterparty');
  expect(after.acceptances[0].payload._role_in_agreement).toBe('performer');
});
