// What an acceptance permanently binds, tested against the live system.
//
// The defect this suite defends against: canonical v3 bound only the completion
// criteria, so an accepted agreement's price, deadline or performing side could
// be changed afterwards and nothing in the evidence would say so. TrustFlow
// could prove which DoD was accepted while being unable to prove for how much.
//
// Two separate mechanisms are exercised here and should not be confused:
//   - the AGREEMENT SNAPSHOT, recorded inside the acceptance event, which is
//     what the evidence proves; and
//   - the FREEZE TRIGGER on the contracts row, which is defence in depth.
// The evidence must stand on its own even if the second one were absent, which
// is why the snapshot is embedded rather than merely referenced.
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
  project_name: 'Certified translation of a birth certificate',
  dod: ['translate the document', 'return a stamped PDF'],
  amount_jpy: 20000,
  amount_minor: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
};

/** An agreement created and then accepted through the real invite path. */
async function acceptedAgreement(request, {
  terms = {}, performedBy = 'creator',
  invitedEmail = 'invited@example.test', acceptingEmail = 'invited@example.test',
} = {}) {
  const { token, userId } = await getEarnerSession(request);

  const created = await api(request, '/rest/v1/contracts', {
    token,
    prefer: 'return=representation',
    body: {
      ...TERMS, ...terms,
      earner_user_id: userId,
      earner_display_name: 'Acme Translations',
      performed_by: performedBy,
      invited_hirer_email: invitedEmail,
    },
  });
  expect(created.status, `contract insert failed: ${JSON.stringify(created.body)}`).toBe(201);
  const contract = created.body[0];

  // Consuming the invitation and recording what was accepted are one operation.
  const accept = await api(request, '/functions/v1/validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: acceptingEmail, counterparty_name: 'Guest',
    },
  });
  expect(accept.status, `acceptance failed: ${JSON.stringify(accept.body)}`).toBe(200);

  return {
    contract, earnerToken: token, earnerUserId: userId,
    guestToken: accept.body.guest_access_token,
    acceptanceEventId: accept.body.acceptance_event_id,
  };
}

const trailFor = async (request, guestToken) =>
  (await api(request, '/functions/v1/guest-contract-events', { guestToken })).body;

/** Attempt a privileged edit of the contract row, as the owning Earner. */
const patchContract = (request, contract, token, body) =>
  api(request, `/rest/v1/contracts?id=eq.${contract.id}`, { method: 'PATCH', token, body });

// ── What the acceptance binds ───────────────────────────────────────────────

test('an acceptance records the whole deal, not just its completion criteria', async ({ request }) => {
  const { guestToken } = await acceptedAgreement(request);

  const trail = await trailFor(request, guestToken);
  expect(trail.accepted_agreement).toEqual({
    snapshot_version: 1,
    project_name: TERMS.project_name,
    dod: TERMS.dod,
    amount: TERMS.amount_jpy,
    currency: TERMS.currency,
    deadline: TERMS.deadline,
    performed_by: 'creator',
    offered_by: 'Acme Translations',
  });
});

test('the acceptance event verifies and says that it binds the whole agreement', async ({ request }) => {
  const { guestToken } = await acceptedAgreement(request);

  const trail = await trailFor(request, guestToken);
  const acceptance = trail.events.find(e => e.type === 'dod.consent_recorded');
  expect(acceptance.integrity.hash_valid).toBe(true);
  expect(acceptance.integrity.substance_valid).toBe(true);
  expect(acceptance.integrity.binds_whole_agreement).toBe(true);
  expect(trail.chain.verified).toBe(true);
});

test('two agreements differing only in price produce different bindings', async ({ request }) => {
  // The property that was missing: under v3 these two acceptances were
  // indistinguishable, because only the DoD reached the hash.
  const cheap = await acceptedAgreement(request, { terms: { amount_jpy: 20000, amount_minor: 20000 } });
  const dear = await acceptedAgreement(request, { terms: { amount_jpy: 30000, amount_minor: 30000 } });

  const a = await api(request, '/functions/v1/log-event', {
    token: cheap.earnerToken, body: { type: 'performance.asserted', contract_id: cheap.contract.id },
  });
  const b = await api(request, '/functions/v1/log-event', {
    token: dear.earnerToken, body: { type: 'performance.asserted', contract_id: dear.contract.id },
  });

  expect(a.body.event.dod_hash).toBe(b.body.event.dod_hash);      // same criteria
  expect(a.body.event.agreement_hash).toBeTruthy();
  expect(a.body.event.agreement_hash).not.toBe(b.body.event.agreement_hash);
});

// ── A term cannot be rewritten after it was agreed ──────────────────────────

for (const [term, change] of [
  ['the price', { amount_jpy: 999999, amount_minor: 999999 }],
  ['the deadline', { deadline: '2027-06-30' }],
  ['what counts as finished', { dod: ['just send anything'] }],
  ['which side performs', { performed_by: 'counterparty' }],
]) {
  test(`changing ${term} after acceptance is refused, and the record still shows what was agreed`, async ({ request }) => {
    const { contract, earnerToken, guestToken } = await acceptedAgreement(request);
    const before = (await trailFor(request, guestToken)).accepted_agreement;

    // Defence in depth, in two layers. A party reaching PostgREST is stopped by
    // the table's grants before the row is ever touched (403); a privileged
    // writer that gets past those is stopped by the freeze trigger (400). Both
    // are refusals of the same attempt, so either satisfies this test — which
    // layer answers first is a deployment detail, not the property.
    const edit = await patchContract(request, contract, earnerToken, change);
    expect([400, 403], `the edit was not refused: ${JSON.stringify(edit.body)}`)
      .toContain(edit.status);
    expect(String(edit.body?.message ?? ''))
      .toMatch(/agreed terms cannot change after acceptance|permission denied/);

    // And the evidence, which does not depend on that protection, is unmoved.
    const after = await trailFor(request, guestToken);
    expect(after.accepted_agreement).toEqual(before);
    expect(after.terms_changed_since_acceptance).toEqual([]);
  });
}

test('the protocol still moves while the agreed terms stay put', async ({ request }) => {
  // The freeze must not be a freeze of the whole row: a transaction that
  // cannot change state is not a transaction.
  const { contract, earnerToken, guestToken } = await acceptedAgreement(request);

  const asserted = await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });
  expect(asserted.status).toBe(201);

  const accepted = await api(request, '/functions/v1/log-event', {
    guestToken, body: { type: 'performance.accepted', contract_id: contract.id },
  });
  expect(accepted.status).toBe(201);

  const trail = await trailFor(request, guestToken);
  expect(trail.terms_changed_since_acceptance).toEqual([]);
  expect(trail.chain.verified).toBe(true);
  // And the completed record is still retrievable in full.
  expect(trail.events.map(e => e.type)).toEqual(
    expect.arrayContaining(['dod.consent_recorded', 'performance.asserted', 'performance.accepted']));
});

// ── Who was invited, who accepted, and how ──────────────────────────────────

test('the invited recipient and the claimed identity are recorded separately', async ({ request }) => {
  const { guestToken } = await acceptedAgreement(request, {
    invitedEmail: 'invited@example.test', acceptingEmail: 'invited@example.test',
  });

  const { acceptance_identity: identity } = await trailFor(request, guestToken);
  expect(identity.invited_recipient).toBe('invited@example.test');
  expect(identity.claimed_identity).toBe('invited@example.test');
  // Coinciding is not the same as verified, and the record does not blur them.
  expect(identity.claimed_identity_verified).toBe(false);
});

test('an invitation accepted by someone else keeps both facts', async ({ request }) => {
  // A forwarded invitation is legitimate and the divergence is itself evidence.
  // Forcing the two into agreement would erase information without proving
  // anything about who the accepting person is.
  const { guestToken } = await acceptedAgreement(request, {
    invitedEmail: 'invited@example.test', acceptingEmail: 'somebody.else@example.test',
  });

  const { acceptance_identity: identity } = await trailFor(request, guestToken);
  expect(identity.invited_recipient).toBe('invited@example.test');
  expect(identity.claimed_identity).toBe('somebody.else@example.test');
  expect(identity.claimed_identity_verified).toBe(false);
});

test('the acceptance records how the authority to accept was obtained', async ({ request }) => {
  const { guestToken } = await acceptedAgreement(request);

  const { acceptance_identity: identity } = await trailFor(request, guestToken);
  // Possession of a consumed single-use invitation — not an email check, not
  // an account, not a legal identity.
  expect(identity.authentication).toBe('invite_capability');
});

// ── The client cannot author any of it ──────────────────────────────────────

test('a client cannot supply the agreement snapshot its event records', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedAgreement(request);

  const forged = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: {
      type: 'performance.asserted',
      contract_id: contract.id,
      payload: {
        note: 'delivered',
        _agreement: { snapshot_version: 1, amount: 1, dod: ['whatever I like'] },
        _auth_method: 'government_id_verified',
      },
    },
  });
  expect(forged.status).toBe(201);

  // The server's namespace is not writable from outside: the injected keys are
  // gone, and the note the caller legitimately sent survives.
  const trail = await trailFor(request, guestToken);
  const asserted = trail.events.find(e => e.type === 'performance.asserted');
  expect(asserted.payload.note).toBe('delivered');
  expect(JSON.stringify(asserted.payload)).not.toContain('whatever I like');
  expect(JSON.stringify(trail)).not.toContain('government_id_verified');
  expect(trail.accepted_agreement.amount).toBe(TERMS.amount_jpy);
  expect(asserted.integrity.hash_valid).toBe(true);
});

test('a client cannot choose the agreement hash its event carries', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedAgreement(request);

  const forged = await api(request, '/functions/v1/log-event', {
    token: earnerToken,
    body: {
      type: 'performance.asserted',
      contract_id: contract.id,
      agreement_hash: 'a-deal-nobody-made',
    },
  });
  expect(forged.status).toBe(201);
  expect(forged.body.event.agreement_hash).not.toBe('a-deal-nobody-made');

  const trail = await trailFor(request, guestToken);
  expect(trail.events.find(e => e.type === 'performance.asserted').integrity.hash_valid).toBe(true);
});

// ── Both directions of the transaction ──────────────────────────────────────

test('an agreement where the guest performs binds that fact too', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedAgreement(request, {
    performedBy: 'counterparty',
  });

  const trail = await trailFor(request, guestToken);
  expect(trail.accepted_agreement.performed_by).toBe('counterparty');
  expect(trail.contract.viewer_role).toBe('performer');

  // And the roles really are inverted: the guest asserts, the Earner accepts.
  const guestAsserts = await api(request, '/functions/v1/log-event', {
    guestToken, body: { type: 'performance.asserted', contract_id: contract.id },
  });
  expect(guestAsserts.status).toBe(201);

  const earnerConfirms = await api(request, '/functions/v1/log-event', {
    token: earnerToken, body: { type: 'performance.accepted', contract_id: contract.id },
  });
  expect(earnerConfirms.status).toBe(201);

  expect((await trailFor(request, guestToken)).terms_changed_since_acceptance).toEqual([]);
});

// ── Correction still works, and stays visible ───────────────────────────────

test('a rejection and a second attempt leave the accepted terms untouched', async ({ request }) => {
  const { contract, earnerToken, guestToken } = await acceptedAgreement(request);

  for (const step of [
    { token: earnerToken, type: 'performance.asserted' },
    { guestToken, type: 'performance.rejected', payload: { reason: 'the stamp is missing' } },
    { token: earnerToken, type: 'performance.asserted' },
    { guestToken, type: 'performance.accepted' },
  ]) {
    const { type, payload, ...auth } = step;
    const { status, body } = await api(request, '/functions/v1/log-event', {
      ...auth, body: { type, contract_id: contract.id, ...(payload ? { payload } : {}) },
    });
    expect(status, `${type} failed: ${JSON.stringify(body)}`).toBe(201);
  }

  const trail = await trailFor(request, guestToken);
  // The correction is part of the record, not a replacement of it.
  expect(trail.events.filter(e => e.type === 'performance.asserted')).toHaveLength(2);
  expect(trail.events.find(e => e.type === 'performance.rejected').payload.reason)
    .toBe('the stamp is missing');
  expect(trail.accepted_agreement.amount).toBe(TERMS.amount_jpy);
  expect(trail.chain.verified).toBe(true);
});
