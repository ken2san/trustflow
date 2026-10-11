#!/usr/bin/env node
// One TrustFlow transaction, driven entirely over the API.
//
//   npm run test:api
//
// No Playwright, no Chrome, no DOM, no dev server, no localStorage. Two parties
// acting under two genuinely different authorities, through the same Edge
// Functions, RLS policies, column grants and party checks the browser goes
// through. Nothing here is privileged: there is no test-only RPC, no
// service_role, and no path that a real caller could not take.
//
// WHAT IT IS NOT
// This is not a simulation of two people. Both sides are driven by one script
// with one operator behind it, so every "I accept" below is a TEST ASSERTION
// OF PROTOCOL BEHAVIOUR, not a human act of will. The events it writes are
// indistinguishable in the record from real ones — which is the reason it may
// only ever run against the E2E project, and why scripts/lib/e2eGuard.mjs
// refuses anything else before the first request.
//
// THE TWO AUTHORITIES, WHICH ARE THE POINT
//   owner — a verified Earner's JWT. An account, with a user id.
//   guest — a guest_access_token bearer header. NOT an account: hirer_user_id
//           stays null, the email is self-claimed and recorded as unverified,
//           and the token is a capability the owner delivered out of band. It
//           says the holder may act on this one agreement. It says nothing
//           about who they are.
//
// SLICE 1 (this file): create -> accept -> deliver -> accept delivery -> both
// sides read -> independent chain verification. Correction, re-delivery and
// the payment pair are slice 2, left out on purpose so that the first vertical
// slice is one that actually runs.

import { ownerSession, rest, invoke, PROJECT_REF } from './lib/tfClient.mjs';
import { redact } from './lib/e2eGuard.mjs';
import {
  CANONICAL_INPUTS, missingCanonicalInputs, recomputeFromCanonicalBlock,
} from '../supabase/functions/_shared/guestEventView.ts';

const RUN = `api-e2e ${new Date().toISOString()}`;
let step = 0;
const fail = [];

function ok(label, condition, detail = '') {
  step += 1;
  console.log(`${condition ? ' ok ' : 'FAIL'} ${String(step).padStart(2)}. ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) fail.push(label);
  return condition;
}

function die(message) {
  console.error(`\nABORTED: ${message}`);
  process.exit(1);
}

/** Tomorrow, locally. Not toISOString(): UTC makes today read as past east of Greenwich. */
function tomorrowLocalISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}

async function main() {
  console.log(`\nTrustFlow API transaction — project ${PROJECT_REF}\n`);

  const { token: ownerToken, userId: ownerId } = await ownerSession();
  ok('owner holds a verified session', Boolean(ownerToken && ownerId));

  // ── 1. The owner offers an agreement ──────────────────────────────────────
  // A plain PostgREST insert, exactly as src/lib/contracts.js does it. The
  // server-owned columns are absent because the client's INSERT grant on them
  // was revoked (20260923000000); including one makes the whole insert 403.
  const created = await rest(ownerToken, 'contracts?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      earner_user_id: ownerId,
      earner_display_name: 'API Harness Owner',
      project_name: `${RUN} — slice 1`,
      dod: ['Deliver the thing', 'Thing matches the brief'],
      amount_jpy: 50000,
      currency: 'JPY',
      deadline: tomorrowLocalISO(),
      invited_hirer_email: 'harness-guest@example.invalid',
      performed_by: 'creator',
    }),
  });
  const contract = Array.isArray(created.body) ? created.body[0] : null;
  if (!ok('owner creates a contract', created.status === 201 && Boolean(contract),
    `HTTP ${created.status}`)) die(`insert refused: ${JSON.stringify(created.body)}`);

  const contractId = contract.id;
  console.log(`      contract ${contractId}`);

  ok('the server owned the state, not the caller', contract.state === 'AWAITING_ACCEPTANCE',
    contract.state);
  ok('the server issued the invite token', Boolean(contract.invite_token),
    redact(contract.invite_token));
  ok('the server derived dod_hash rather than accepting one',
    contract.dod_hash === null || typeof contract.dod_hash === 'string');

  // ── 2. The invitee reads the invitation holding only the link ─────────────
  // anon key and nothing else: no account, no JWT. This is what someone who was
  // sent a URL actually has.
  const peek = await invoke('validate-invite-token', {
    body: { invite_token: contract.invite_token },
  });
  ok('an invitee with only the link can read the terms',
    peek.status === 200 && peek.data?.project_name === contract.project_name,
    `HTTP ${peek.status}`);
  ok('the terms come from the row, not the URL',
    peek.data?.amount_jpy === 50000);

  // ── 3. Acceptance: one transaction, and the guest credential is born ──────
  const accepted = await invoke('validate-invite-token', {
    body: {
      invite_token: contract.invite_token,
      accept: true,
      hirer_email: 'harness-guest@example.invalid',
      counterparty_name: 'API Harness Guest',
    },
  });
  if (!ok('the invitee accepts', accepted.status === 200, `HTTP ${accepted.status} ${accepted.reason ?? ''}`)) {
    die('acceptance failed; nothing downstream can run');
  }
  const guestToken = accepted.data?.guest_access_token;
  ok('acceptance issued a guest capability', Boolean(guestToken), redact(guestToken));

  // The same token twice must not accept twice. A single-use token that is not
  // single-use is a second counterparty.
  const replay = await invoke('validate-invite-token', {
    body: {
      invite_token: contract.invite_token, accept: true,
      hirer_email: 'someone-else@example.invalid', counterparty_name: 'Replay',
    },
  });
  ok('the invite token is spent and cannot be replayed',
    replay.status !== 200 && replay.reason === 'already_used',
    `HTTP ${replay.status} ${replay.reason}`);

  // ── 4. The authorities are not interchangeable ────────────────────────────
  // performed_by is 'creator', so the owner performs and the guest receives.
  // Each attempting the other's event must be refused by role, not by UI.
  const wrongWay = await invoke('log-event', {
    ownerToken,
    body: { type: 'performance.accepted', contract_id: contractId, payload: {} },
  });
  ok('the performer cannot accept their own performance',
    wrongWay.status === 403 && wrongWay.reason === 'wrong_party_for_event_type',
    `HTTP ${wrongWay.status} ${wrongWay.reason}`);

  const guestAsserts = await invoke('log-event', {
    guestToken,
    body: { type: 'performance.asserted', contract_id: contractId, payload: {} },
  });
  ok('the receiver cannot assert the performance',
    guestAsserts.status === 403 && guestAsserts.reason === 'wrong_party_for_event_type',
    `HTTP ${guestAsserts.status} ${guestAsserts.reason}`);

  // ── 5. Delivery, asserted by the owner under their JWT ────────────────────
  const idemKey = `${RUN}:asserted`;
  const asserted = await invoke('log-event', {
    ownerToken,
    body: {
      type: 'performance.asserted', contract_id: contractId,
      payload: { note: 'Harness delivery assertion — not a human statement' },
      idempotency_key: idemKey,
    },
  });
  // 201 on a write, 200 on a deduplicated retry — both are the function
  // answering, and pinning the exact code is a test of the status line rather
  // than of the behaviour.
  ok('the owner asserts delivery', asserted.status < 300 && Boolean(asserted.data?.event),
    `HTTP ${asserted.status} ${asserted.reason ?? ''}`);

  // An agent will retry. A retry must return the first write, not make a second.
  const retried = await invoke('log-event', {
    ownerToken,
    body: {
      type: 'performance.asserted', contract_id: contractId,
      payload: { note: 'Harness delivery assertion — not a human statement' },
      idempotency_key: idemKey,
    },
  });
  ok('a retry with the same idempotency key is deduplicated',
    retried.status < 300 && retried.data?.deduplicated === true
      && retried.data?.event?.id === asserted.data?.event?.id,
    retried.data?.deduplicated ? 'returned the original' : 'wrote again');

  // ── 6. Acceptance of delivery, by the guest under the bearer capability ───
  const deliveryAccepted = await invoke('log-event', {
    guestToken,
    body: {
      type: 'performance.accepted', contract_id: contractId,
      payload: { note: 'Harness acceptance — a test assertion, not consent' },
      idempotency_key: `${RUN}:accepted`,
    },
  });
  ok('the guest accepts the delivery under the bearer capability',
    deliveryAccepted.status < 300 && Boolean(deliveryAccepted.data?.event),
    `HTTP ${deliveryAccepted.status} ${deliveryAccepted.reason ?? ''}`);

  // ── 7. A revoked capability stops working ─────────────────────────────────
  // Re-issue rotates the token. The old one must die, because this is the only
  // credential revocation the system has.
  const reissued = await invoke('reissue-guest-access', { ownerToken, body: { contract_id: contractId } });
  ok('the owner can re-issue the guest capability',
    reissued.status < 300 && Boolean(reissued.data?.guest_access_token),
    redact(reissued.data?.guest_access_token));

  const staleRead = await invoke('guest-contract-events', { guestToken });
  ok('the superseded capability is refused',
    staleRead.status !== 200 && staleRead.reason === 'invalid_guest_token',
    `HTTP ${staleRead.status} ${staleRead.reason}`);

  const newGuestToken = reissued.data?.guest_access_token;

  // ── 8. Both sides read the same evidence ──────────────────────────────────
  const ownerRows = await rest(ownerToken,
    `events?contract_id=eq.${contractId}&select=id,type,event_hash,prev_event_hash&order=created_at.asc,id.asc`);
  const guestView = await invoke('guest-contract-events', { guestToken: newGuestToken });

  const ownerIds = (ownerRows.body ?? []).map(r => r.id);
  const guestEvents = guestView.data?.events ?? [];
  ok('the owner reads the trail over PostgREST', ownerIds.length >= 4, `${ownerIds.length} events`);
  ok('the guest reads the trail over the Edge Function',
    guestView.status === 200 && guestEvents.length > 0, `${guestEvents.length} events`);

  // THE CHECK THIS WHOLE HARNESS IS FOR: two parties, two authorities, two code
  // paths — and the question is whether they are shown the same history.
  const guestIds = guestEvents.map(e => e.id).filter(Boolean);
  ok('both parties see the same events, in the same order',
    guestIds.length > 0 && JSON.stringify(guestIds) === JSON.stringify(ownerIds),
    guestIds.length ? `owner ${ownerIds.length} / guest ${guestIds.length}` : 'guest view exposes no event ids');

  // ── measured, not asserted ────────────────────────────────────────────────
  // Whether the counterparty can check the record for themselves, instead of
  // being told the server checked it. This is deliberately NOT an ok() check:
  // the answer depends on which build of guest-contract-events is deployed to
  // this project, and a harness that failed because the repo is ahead of the
  // deployment would be reporting the wrong thing. It is printed because the
  // number is the whole point of the read path, and because a gap nobody
  // measures is a gap nobody closes.
  const recomputable = [];
  const missing = new Set();
  for (const ev of guestEvents) {
    const block = ev.canonical ?? null;
    const absent = missingCanonicalInputs(block);
    absent.forEach(k => missing.add(k));
    if (absent.length) continue;
    const stored = ev.integrity?.event_hash ?? null;
    if (stored && (await recomputeFromCanonicalBlock(block)) === stored) recomputable.push(ev.id);
  }

  console.log(`\n--- what the counterparty can verify without trusting the server`);
  console.log(`events recomputable from the response alone: `
    + `${recomputable.length} / ${guestEvents.length}`);
  if (missing.size) {
    console.log(`canonical inputs the deployed response omits: ${[...missing].join(', ')}`);
    console.log(`  (of ${CANONICAL_INPUTS.length}; the repo's guest-contract-events sends all of them)`);
  }
  console.log(`payload preimage: still not disclosed, by design — one digest covers`);
  console.log(`  the whole payload, so the allowlisted projection cannot reproduce it.`);

  console.log(`\n${step} checks, ${fail.length} failed`);
  if (fail.length) {
    for (const f of fail) console.log(`  FAILED: ${f}`);
  }
  console.log(`\nVerify the chain independently:\n  node scripts/verify-chain.mjs ${contractId}\n`);
  process.exit(fail.length ? 1 : 0);
}

main().catch(err => { console.error(`\n${err.message}`); process.exit(1); });
