// The evidence core, tested as an evidence system rather than as a UI flow.
//
// What this suite is defending is a single idea: TrustFlow attests that a party
// SAID something, never that what they said is true. Every test below is a way
// that distinction could quietly collapse — a party confirming their own claim,
// an assertion citing terms nobody agreed to, a payload edited after the fact,
// or a state name that turns a claim into a fact.
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

/** An accepted agreement with both parties' credentials in hand. */
async function acceptedContract(request, { dod = ['ship the thing'] } = {}) {
  const { token, userId } = await getEarnerSession(request);

  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Evidence Core Earner',
      project_name: 'Evidence Core Probe',
      dod,
      amount_jpy: 1000,
      currency: 'JPY',
      invited_hirer_email: 'invited@example.test',
    },
  });
  expect(created.status, `contract insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  const contract = created.body[0];

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: { invite_token: contract.invite_token, accept: true, hirer_email: 'hirer@example.test' },
  });
  expect(accept.status).toBe(200);

  return { contract, earnerToken: token, earnerUserId: userId, guestToken: accept.body.guest_access_token };
}

const stateOf = async (request, contract, token) => {
  const { body } = await api(request,
    `/rest/v1/contracts?id=eq.${contract.id}&select=state`, { method: 'GET', token });
  return body[0].state;
};

// ── An assertion is not a fact ──────────────────────────────────────────────

test('an assertion moves the protocol to a waiting position, not to "delivered"', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);
  expect(await stateOf(request, contract, earnerToken)).toBe('TERMS_ACCEPTED');

  const asserted = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, payload: { note: 'done' } },
  });
  expect(asserted.status).toBe(201);

  // The state names where the protocol stands, not what happened in the world.
  const state = await stateOf(request, contract, earnerToken);
  expect(state).toBe('AWAITING_CONFIRMATION');
  expect(state).not.toBe('DELIVERED');
});

test('a unilateral assertion cannot reach settlement', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);

  await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });

  // This used to assert that capture-payment answered 409 from this state.
  // The payment functions were retired on 2026-11-06 — settlement is out of
  // scope and money moves outside TrustFlow (Decisions.md, Current scope) —
  // so the guarantee moves rather than disappearing, and gets stronger: there
  // is no settlement endpoint at all. Deleting the assertion instead would
  // have removed the only check that a one-sided claim cannot settle anything.
  const capture = await api(request, '/functions/v1/capture-payment', {
    guestToken, body: { contractId: contract.id },
  });
  expect(capture.status, 'the retired endpoint must not come back').toBe(404);
  expect(await stateOf(request, contract, earnerToken)).not.toBe('SETTLED');
});

test('a party cannot confirm their own assertion', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);
  await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });

  // Being a party is not enough — confirming is the counterparty's act. Without
  // this the Earner could walk a contract to the settlement gate alone.
  const selfAccept = await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.accepted', contract_id: contract.id },
  });
  expect(selfAccept.status).toBe(403);
  expect(selfAccept.body.error).toBe('wrong_party_for_event_type');
  expect(await stateOf(request, contract, earnerToken)).toBe('AWAITING_CONFIRMATION');
});

test('the Hirer cannot assert performance on the Earner’s behalf', async ({ request }) => {
  const { contract, guestToken } = await acceptedContract(request);

  const { status, body } = await api(request, '/functions/v1/log-event', {
    guestToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });
  expect(status).toBe(403);
  expect(body.error).toBe('wrong_party_for_event_type');
});

// ── Disagreement is representable, and repeatable ───────────────────────────

test('assert → reject → assert → accept needs no second architecture', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);

  const assert1 = await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });
  expect(assert1.status).toBe(201);
  expect(await stateOf(request, contract, earnerToken)).toBe('AWAITING_CONFIRMATION');

  const reject = await api(request, '/functions/v1/log-event', {
    guestToken,
    body: { type: 'performance.rejected', contract_id: contract.id, payload: { reason: 'incomplete' } },
  });
  expect(reject.status).toBe(201);
  // A rejection returns the protocol to a position where the Earner may assert
  // again. It is not a verdict, and both positions stay in the log.
  expect(await stateOf(request, contract, earnerToken)).toBe('TERMS_ACCEPTED');

  const assert2 = await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });
  expect(assert2.status).toBe(201);

  const accept = await api(request, '/functions/v1/log-event', {
    guestToken, body: { type: 'performance.accepted', contract_id: contract.id },
  });
  expect(accept.status).toBe(201);
  expect(await stateOf(request, contract, earnerToken)).toBe('PERFORMANCE_ACCEPTED');

  // All four remain, in order, attributed to whoever made them.
  const trail = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  const performance = trail.body.events.filter(e => e.type.startsWith('performance.'));
  expect(performance.map(e => e.type)).toEqual([
    'performance.asserted', 'performance.rejected', 'performance.asserted', 'performance.accepted',
  ]);
  expect(performance.map(e => e.actor.role)).toEqual(['earner', 'guest_hirer', 'earner', 'guest_hirer']);
});

// ── What an assertion may cite ──────────────────────────────────────────────

test('a client cannot choose which agreement version its assertion cites', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);

  const forged = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, dod_hash: 'terms-nobody-agreed-to' },
  });
  expect(forged.status).toBe(400);
  expect(forged.body.error).toBe('dod_hash_is_server_derived');
});

test('the terms an assertion cites are derived from the agreement itself', async ({ request }) => {
  const a = await acceptedContract(request, { dod: ['three logo concepts'] });
  const b = await acceptedContract(request, { dod: ['three logo concepts', 'and a website'] });

  const inA = await api(request, '/functions/v1/log-event', {
    token: a.earnerToken, body: { type: 'performance.asserted', contract_id: a.contract.id },
  });
  const inB = await api(request, '/functions/v1/log-event', {
    token: b.earnerToken, body: { type: 'performance.asserted', contract_id: b.contract.id },
  });

  expect(inA.body.event.dod_hash).toBeTruthy();
  // Different terms produce different pins, which is what would make a scope
  // change visible in the log rather than silent.
  expect(inB.body.event.dod_hash).not.toBe(inA.body.event.dod_hash);
});

// ── The substance is attested, not merely recorded ──────────────────────────

test('the payload is bound into the hash under the current version', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);

  const written = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, payload: { note: 'delivered in full' } },
  });
  expect(written.status).toBe(201);
  expect(written.body.event.hash_version).toBe(4);
  expect(written.body.event.payload_hash).toBeTruthy();

  const trail = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  const asserted = trail.body.events.find(e => e.type === 'performance.asserted');
  expect(asserted.integrity.hash_valid).toBe(true);
  expect(asserted.integrity.substance_valid).toBe(true);
  expect(trail.body.chain.payload_covered_by_hash).toBe(true);
});

test('a payload edited after the fact fails verification', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedContract(request);
  await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, payload: { note: 'original claim' } },
  });

  // An edit is refused by the no_update_events rule rather than by a permission
  // check — Postgres reports 0A000 because a DO INSTEAD NOTHING rule cannot
  // satisfy UPDATE ... RETURNING. That distinction matters: a grant applies to
  // a role, but the rule applies to every role, the service role included.
  const edit = await api(request, `/rest/v1/events?contract_id=eq.${contract.id}`, {
    method: 'PATCH', token: earnerToken, body: { payload: { note: 'a different claim' } },
  });
  expect(edit.status).toBe(400);
  expect(edit.body.code).toBe('0A000');

  // And the stored hash is over the stored payload, so had an edit landed by
  // some other route, verification would report it.
  const trail = await api(request, '/functions/v1/guest-contract-events', { guestToken });
  const asserted = trail.body.events.find(e => e.type === 'performance.asserted');
  expect(asserted.integrity.substance_valid).toBe(true);
});

// ── Vocabulary that claims a world fact is refused ──────────────────────────

test('the retired world-fact event names are no longer accepted', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);

  for (const type of ['work.submitted', 'work.approved', 'work.rejected']) {
    const { status, body } = await api(request, '/functions/v1/log-event', {
      token: earnerToken, body: { type, contract_id: contract.id },
    });
    expect(status, `${type} should be refused`).toBe(400);
    expect(body.error).toBe('type_retired');
  }
});

// ── Preserved invariants ────────────────────────────────────────────────────

test('replaying an assertion returns the original rather than appending', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);
  const key = `assert:${contract.id}`;

  const first = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key },
  });
  const replay = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: { type: 'performance.asserted', contract_id: contract.id, idempotency_key: key },
  });

  expect(first.status).toBe(201);
  expect(replay.status).toBe(200);
  expect(replay.body.deduplicated).toBe(true);
  expect(replay.body.event.id).toBe(first.body.event.id);
});

test('a client still cannot write state directly', async ({ request }) => {
  const { contract, earnerToken } = await acceptedContract(request);

  const direct = await api(request, `/rest/v1/contracts?id=eq.${contract.id}`, {
    method: 'PATCH', token: earnerToken, body: { state: 'PERFORMANCE_ACCEPTED' },
  });
  expect(direct.status).toBeGreaterThanOrEqual(401);
  expect(await stateOf(request, contract, earnerToken)).toBe('TERMS_ACCEPTED');
});

// ── Who does the work, and what that changes ────────────────────────────────
//
// The model used to assume the account holder always performs. That made an
// ordinary transaction backwards: someone hiring a translator is the receiver,
// and the translator would have had to open an account to send the link.
//
// performed_by fixes the direction. What must NOT change with it is the
// authority rule — in either direction, the performer asserts and the receiver
// answers, and neither can do both.

async function agreementWhere(request, performedBy) {
  const { token, userId } = await getEarnerSession(request);
  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Creator',
      project_name: 'Direction Probe',
      dod: ['translate the document'],
      amount_jpy: 20000,
      currency: 'JPY',
      invited_hirer_email: 'invited@example.test',
      performed_by: performedBy,
    },
  });
  expect(created.status, `insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  const contract = created.body[0];

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: { invite_token: contract.invite_token, accept: true, hirer_email: 'worker@example.test' },
  });
  expect(accept.status).toBe(200);

  const creator = { token };
  const guest = { guestToken: accept.body.guest_access_token };
  return {
    contract, creator, guest,
    performer: performedBy === 'counterparty' ? guest : creator,
    receiver: performedBy === 'counterparty' ? creator : guest,
  };
}

const logAs = (request, who, contract, type, payload) =>
  api(request, '/functions/v1/log-event', {
    ...who, body: { type, contract_id: contract.id, ...(payload ? { payload } : {}) },
  });

for (const performedBy of ['creator', 'counterparty']) {
  const who = performedBy === 'counterparty' ? 'the invited guest' : 'the account holder';

  test(`the full run works when ${who} performs`, async ({ request }) => {
    const { contract, creator, performer, receiver } = await agreementWhere(request, performedBy);
    expect(await stateOf(request, contract, creator.token)).toBe('TERMS_ACCEPTED');

    expect((await logAs(request, performer, contract, 'performance.asserted')).status).toBe(201);
    expect(await stateOf(request, contract, creator.token)).toBe('AWAITING_CONFIRMATION');

    // Correction, then perform again — no second architecture needed.
    expect((await logAs(request, receiver, contract, 'performance.rejected',
      { reason: 'page 2 missing' })).status).toBe(201);
    expect(await stateOf(request, contract, creator.token)).toBe('TERMS_ACCEPTED');

    expect((await logAs(request, performer, contract, 'performance.asserted')).status).toBe(201);
    expect((await logAs(request, receiver, contract, 'performance.accepted')).status).toBe(201);

    // Complete with no payment anywhere in the system.
    expect(await stateOf(request, contract, creator.token)).toBe('PERFORMANCE_ACCEPTED');
  });

  test(`authority follows the role, not the account, when ${who} performs`, async ({ request }) => {
    const { contract, creator, performer, receiver } = await agreementWhere(request, performedBy);
    await logAs(request, performer, contract, 'performance.asserted');

    // The receiver cannot claim to have performed merely by being a party.
    const wrongAssert = await logAs(request, receiver, contract, 'performance.asserted');
    expect(wrongAssert.status).toBe(403);
    expect(wrongAssert.body.error).toBe('wrong_party_for_event_type');

    // And the performer cannot accept their own assertion — in either
    // direction. This is the property that keeps a single party from walking an
    // agreement to completion alone.
    const selfAccept = await logAs(request, performer, contract, 'performance.accepted');
    expect(selfAccept.status).toBe(403);
    expect(selfAccept.body.error).toBe('wrong_party_for_event_type');

    expect(await stateOf(request, contract, creator.token)).toBe('AWAITING_CONFIRMATION');
  });
}
