// Negative security coverage for the server-authoritative event trail.
//
// These tests exist to fail loudly if the trust boundary closed in
// 20260924000002 is ever reopened. Before it, any holder of the public anon
// key could insert an event with any actor_id, type and prev_event_hash, so
// the hash chain proved nothing about authorship.
//
// Everything here runs against the live API rather than the UI: the boundary
// is enforced by RLS, grants and the log-event function, none of which a
// browser test can observe directly.
//
// Requires a verified Earner, same as invite-persistence.spec.js:
//   TF_TEST_EARNER_EMAIL / TF_TEST_EARNER_PASSWORD

import { test, expect } from '@playwright/test';
import { getEarnerSession } from './earnerSession.js';
import { getAnonymousSession } from './anonymousSession.js';
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

// Shared across every live-API suite and cached on disk — see earnerSession.js.
const signInEarner = getEarnerSession;

async function createContract(request) {
  const { token, userId } = await signInEarner(request);
  const { status, body } = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      earner_user_id: userId,
      earner_display_name: 'Ingestion Suite Earner',
      project_name: 'Event Ingestion Probe',
      dod: ['deliverable'],
      amount_jpy: 1000,
      currency: 'JPY',
      invited_hirer_email: 'ingestion.invitee@example.test',
    },
  });
  expect(status, `contract insert failed: ${JSON.stringify(body)}`).toBe(201);
  return { contract: body[0], token, userId };
}

// ── The client cannot write to the table at all ─────────────────────────────

test('a public anonymous client cannot insert a forged event', async ({ request }) => {
  const { status, body } = await api(request, '/rest/v1/events', {
    body: {
      type: 'contract.completed',
      contract_id: 'forged-contract',
      actor_id: 'somebody-else',
      event_hash: 'forged',
      prev_event_hash: 'forged',
    },
  });

  expect(status).toBe(401);
  expect(body.code).toBe('42501'); // insufficient_privilege
});

test('even a verified Earner cannot insert directly — ingestion is server-only', async ({ request }) => {
  const { contract, token } = await createContract(request);

  const { status, body } = await api(request, '/rest/v1/events', {
    token,
    body: { type: 'contract.completed', contract_id: contract.id, actor_id: 'anyone', event_hash: 'x' },
  });

  expect(status).toBe(403);
  expect(body.code).toBe('42501');
});

test('a public anonymous client cannot read the event trail', async ({ request }) => {
  const { status, body } = await api(request, '/rest/v1/events?select=id,type,actor_id&limit=5', {
    method: 'GET',
  });

  expect(status).toBe(200);
  expect(body).toEqual([]); // RLS returns no rows rather than an error
});

test('an anonymous JWT cannot read an event trail after guest acceptance', async ({ request }) => {
  const { contract } = await createContract(request);
  const claimedEmail = 'self.claimed@example.test';

  // Acceptance records a self-claimed address and creates an event. The
  // anonymous JWT still has no authority; guests read through their capability.
  // A direct regression for a matching verified-account email needs a separate
  // verified account fixture, which this suite intentionally does not create.
  const accepted = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token,
      accept: true,
      hirer_email: claimedEmail,
    },
  });
  expect(accepted.status).toBe(200);

  const anonymous = await getAnonymousSession(request);
  const { status, body } = await api(request,
    `/rest/v1/events?contract_id=eq.${contract.id}&select=id,type`, {
      method: 'GET', token: anonymous.accessToken,
    });

  expect(status).toBe(200);
  expect(body).toEqual([]);
});

// ── What the ingestion function refuses ─────────────────────────────────────

test('the ingestion function ignores a client-supplied actor_id, hash and timestamp', async ({ request }) => {
  const { contract, token, userId } = await createContract(request);

  const { status, body } = await api(request, '/functions/v1/log-event', {
    token,
    body: {
      type: 'contract.initiated',
      contract_id: contract.id,
      actor_id: 'attacker-chosen',
      event_hash: 'forged-hash',
      prev_event_hash: 'forged-prev',
      created_at: '1999-01-01T00:00:00.000Z',
      payload: { step: 1 },
      // dod_hash is deliberately absent — it is rejected outright now, and
      // that refusal has its own test in evidence-core.spec.js.
    },
  });

  expect(status).toBe(201);
  // Every field the client tried to dictate came from the server instead.
  expect(body.event.actor_id).toBe(userId);
  expect(body.event.event_hash).not.toBe('forged-hash');
  expect(body.event.prev_event_hash).toBe('GENESIS');
  expect(new Date(body.event.created_at).getFullYear()).toBeGreaterThan(2020);
  expect(body.event.hash_version).toBe(4);
});

test('a privileged event type cannot be asserted by a party', async ({ request }) => {
  const { contract, token } = await createContract(request);

  for (const type of ['payment.captured', 'trustpoints.earned', 'dispute.resolved', 'runtime.snapshot']) {
    const { status, body } = await api(request, '/functions/v1/log-event', {
      token,
      body: { type, contract_id: contract.id },
    });
    expect(status, `${type} should be rejected`).toBe(400);
    expect(body.error).toBe('type_not_allowed');
  }
});

test('an event referencing a non-contract is rejected', async ({ request }) => {
  const { token } = await signInEarner(request);

  // The ids the marketplace demo flow passes today.
  for (const contractId of ['1', 'mock', 'runtime']) {
    const { status, body } = await api(request, '/functions/v1/log-event', {
      token,
      body: { type: 'contract.accepted', contract_id: contractId },
    });
    expect(status, `${contractId} should be rejected`).toBe(404);
    expect(body.error).toBe('contract_not_found');
  }
});

test('a caller with no party credentials is rejected', async ({ request }) => {
  const { contract } = await createContract(request);

  // Anon key only — no user JWT, no guest token.
  const anonAttempt = await api(request, '/functions/v1/log-event', {
    body: { type: 'contract.accepted', contract_id: contract.id },
  });
  expect(anonAttempt.status).toBe(403);
  expect(anonAttempt.body.error).toBe('not_a_party');

  // A guest token that does not match this contract.
  const badGuest = await api(request, '/functions/v1/log-event', {
    guestToken: '00000000-0000-4000-8000-0000000000ff',
    body: { type: 'contract.accepted', contract_id: contract.id },
  });
  expect(badGuest.status).toBe(403);
  expect(badGuest.body.error).toBe('not_a_party');
});

// ── Chain and idempotency guarantees ────────────────────────────────────────

test('the chain links each event to its predecessor and cannot be forked', async ({ request }) => {
  const { contract, token } = await createContract(request);

  const first = await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.initiated', contract_id: contract.id },
  });
  const second = await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.accepted', contract_id: contract.id },
  });

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(first.body.event.prev_event_hash).toBe('GENESIS');
  expect(second.body.event.prev_event_hash).toBe(first.body.event.event_hash);

  // Two concurrent writers read the same tip; the unique index on
  // (contract_id, prev_event_hash) means only one of them can claim it, and
  // the other retries — so the tail is a chain, never a fork.
  const concurrent = await Promise.all(
    ['contract.completed', 'contract.cancelled', 'dispute.opened'].map(type =>
      api(request, '/functions/v1/log-event', { token, body: { type, contract_id: contract.id } })
    )
  );
  for (const r of concurrent) expect(r.status).toBe(201);

  const prevHashes = concurrent.map(r => r.body.event.prev_event_hash);
  expect(new Set(prevHashes).size, 'two events claimed the same predecessor').toBe(prevHashes.length);
});

test('retrying with the same idempotency key returns the original event', async ({ request }) => {
  const { contract, token } = await createContract(request);
  const key = `consent:${contract.id}`;

  const first = await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.accepted', contract_id: contract.id, idempotency_key: key },
  });
  const retry = await api(request, '/functions/v1/log-event', {
    token, body: { type: 'contract.accepted', contract_id: contract.id, idempotency_key: key },
  });

  expect(first.status).toBe(201);
  expect(first.body.deduplicated).toBe(false);
  expect(retry.status).toBe(200);
  expect(retry.body.deduplicated).toBe(true);
  expect(retry.body.event.id).toBe(first.body.event.id);
});

// ── The guest Hirer's identity comes from the invite, not the request ───────

test('a guest Hirer is recorded as the email that accepted, not one it supplies', async ({ request }) => {
  const { contract } = await createContract(request);

  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token,
      accept: true,
      hirer_email: 'real.accepter@example.test',
    },
  });
  expect(accept.status).toBe(200);

  // A later assertion by the same guest, with a forged actor_id in the body.
  const { status, body } = await api(request, '/functions/v1/log-event', {
    guestToken: accept.body.guest_access_token,
    body: {
      type: 'contract.accepted',
      contract_id: contract.id,
      actor_id: 'spoofed@example.test',
      payload: { step: 1 },
    },
  });

  expect(status).toBe(201);
  expect(body.event.actor_id).toBe('guest:real.accepter@example.test');
  expect(body.event.payload._actor_role).toBe('guest_hirer');
});
