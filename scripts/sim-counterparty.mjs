#!/usr/bin/env node
// Several agreements, each with its own counterparty who DECIDES.
//
//   npm run sim:counterparty
//
// WHAT THIS ADDS OVER scripts/api-e2e.mjs
// That file is slice 1: one agreement, one happy path, both sides driven as a
// straight line of assertions. Its own header defers "correction, re-delivery
// and the payment pair" to a slice 2. This is that slice, and it changes one
// more thing: the counterparty is not a list of steps, it is a POLICY that is
// handed the delivery and returns a verdict. The script does not know in
// advance how many events a run will produce.
//
// THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT
// Asked: can a separate, anonymous, account-less counterparty be exercised end
// to end without a mailbox, a second Supabase account, or another operator?
// Yes, and it already could — that is the finding, not the feature. A guest
// has no auth.users row at all: `hirer_email` is typed by them and recorded
// unverified, and their authority is a bearer token the owner handed over. So
// a second party costs one more invite token and nothing else. Nobody needs to
// be registered, emailed, or added to a thread. Two counterparties run below
// with different self-claimed identities to make that concrete.
//
// NOT asked, and NOT answered: whether a human who did not build this can use
// it. A simulated counterparty shares our assumptions by construction. It
// cannot misread a screen, type the wrong address, change its mind for a
// reason we failed to anticipate, or give up. Every verdict below was written
// by the same person who wrote the thing being judged. This is a protocol
// exercise; the dogfood with a real second human is a different item and this
// does not shorten it.
//
// CREDENTIAL ISOLATION IS STRUCTURAL, NOT POLITE
// `counterparty()` closes over its own guest token and is never passed the
// owner's. There is no flag to switch it; a policy that tried to act as the
// owner has nothing to act with. In api-e2e.mjs both credentials sit in one
// scope, which is fine for asserting refusals on purpose and wrong for a
// simulation, where the whole claim is that the two sides are separate.
//
// E2E ONLY. tfClient's import of e2eGuard refuses any other project before the
// first request. The events this writes are indistinguishable in the record
// from real ones, which is exactly why they may not be written anywhere else.

import { ownerSession, rest, invoke, PROJECT_REF } from './lib/tfClient.mjs';
import { redact } from './lib/e2eGuard.mjs';

const RUN = `sim ${new Date().toISOString()}`;

let checks = 0;
const failures = [];

function ok(label, condition, detail = '') {
  checks += 1;
  console.log(`${condition ? ' ok ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures.push(label);
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

// ── The counterparty ────────────────────────────────────────────────────────

/**
 * Accept an invitation and return a party that holds ONLY its own credential.
 *
 * The returned object cannot reach the owner token: it is not in scope here.
 * That is the difference between a second party and a second code path.
 */
async function counterparty({ inviteToken, name, email, policy }) {
  const accepted = await invoke('validate-invite-token', {
    body: {
      invite_token: inviteToken,
      accept: true,
      hirer_email: email,
      counterparty_name: name,
    },
  });
  if (accepted.status !== 200 || !accepted.data?.guest_access_token) {
    die(`${name} could not accept: HTTP ${accepted.status} ${accepted.reason ?? ''}`);
  }
  const guestToken = accepted.data.guest_access_token;

  return {
    name,
    email,
    tokenPreview: redact(guestToken),

    /** Everything this party can see of the agreement — through its own door. */
    async readTrail(contractId) {
      const r = await invoke('guest-contract-events', {
        guestToken,
        body: { contract_id: contractId },
      });
      return r.status === 200 ? r.data : null;
    },

    /**
     * Look at the delivery and decide. The policy returns the verdict; this
     * function only turns it into the event the protocol allows a receiver to
     * write. A policy cannot invent a type it is not entitled to, because it
     * never touches `invoke`.
     */
    async judgeDelivery(contractId, deliveryNote) {
      const verdict = await policy({ name, deliveryNote });
      const type = verdict.accept ? 'performance.accepted' : 'performance.rejected';
      const r = await invoke('log-event', {
        guestToken,
        body: {
          type,
          contract_id: contractId,
          payload: verdict.reason ? { note: verdict.reason } : {},
        },
      });
      return { type, status: r.status, reason: r.reason, verdict };
    },

    /** The receiver is the one who pays, so this side reports payment. */
    async reportPayment(contractId, note) {
      const r = await invoke('log-event', {
        guestToken,
        body: { type: 'payment.reported', contract_id: contractId, payload: { note } },
      });
      return { status: r.status, reason: r.reason };
    },
  };
}

// ── Policies: what a counterparty is, in one function ───────────────────────
//
// Each is handed the delivery and returns `{ accept, reason? }`. They are
// deliberately dumb. A policy that read the delivery note and reasoned about
// it would be a model, and a model is Model-Trials' subject, not this file's —
// nothing here sends anything anywhere but TrustFlow's own E2E project.

/** Takes the first delivery at face value. */
const agreeable = async () => ({ accept: true });

/**
 * Rejects once, with a reason, then accepts the re-delivery. This is the path
 * api-e2e.mjs never walks: `performance.rejected` returns the agreement to
 * TERMS_ACCEPTED, and the owner must assert again.
 */
function exacting() {
  let seen = 0;
  return async ({ deliveryNote }) => {
    seen += 1;
    if (seen === 1) {
      return { accept: false, reason: `The brief asked for two items; I see one in "${deliveryNote}".` };
    }
    return { accept: true };
  };
}

// ── One agreement, start to finish ──────────────────────────────────────────

async function runAgreement({ ownerToken, ownerId, label, party }) {
  console.log(`\n── ${label} ────────────────────────────────`);

  const created = await rest(ownerToken, 'contracts?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      earner_user_id: ownerId,
      earner_display_name: 'Simulation Owner',
      project_name: `${RUN} — ${label}`,
      dod: ['Deliver the thing', 'Thing matches the brief'],
      amount_jpy: 50000,
      currency: 'JPY',
      deadline: tomorrowLocalISO(),
      invited_hirer_email: party.email,
      performed_by: 'creator',
    }),
  });
  const contract = Array.isArray(created.body) ? created.body[0] : null;
  if (!contract) die(`insert refused (HTTP ${created.status}): ${JSON.stringify(created.body)}`);
  return contract;
}

async function main() {
  console.log(`\nTrustFlow counterparty simulation — project ${PROJECT_REF}\n`);
  console.log('Two counterparties, neither of them an account, neither of them');
  console.log('holding the owner\'s credential. Verdicts come from policies.\n');

  const { token: ownerToken, userId: ownerId } = await ownerSession();
  ok('the owner holds a verified session', Boolean(ownerToken && ownerId));

  const plans = [
    { label: 'agreement A — an agreeable counterparty', name: 'Sim Party A',
      email: 'sim-a@example.invalid', policy: agreeable },
    { label: 'agreement B — a counterparty that sends it back', name: 'Sim Party B',
      email: 'sim-b@example.invalid', policy: exacting() },
  ];

  const transcripts = [];

  for (const plan of plans) {
    // The owner offers. Nothing about the counterparty exists yet.
    const contract = await runAgreement({
      ownerToken, ownerId, label: plan.label, party: { email: plan.email },
    });
    console.log(`      contract ${contract.id}`);

    // The invitation is handed over. From here the two sides are separate: the
    // party below never receives ownerToken.
    const party = await counterparty({
      inviteToken: contract.invite_token,
      name: plan.name,
      email: plan.email,
      policy: plan.policy,
    });
    ok(`${party.name} accepted and holds its own capability`, true, party.tokenPreview);

    // Its identity is self-claimed and recorded as such. This is the property
    // that makes a second party free, and the one nobody may forget.
    const trail = await party.readTrail(contract.id);
    ok(`${party.name}'s identity is recorded as unverified`,
      trail?.acceptance_identity?.claimed_identity === plan.email
      && trail?.acceptance_identity?.claimed_identity_verified === false,
      `claimed ${trail?.acceptance_identity?.claimed_identity ?? '—'}`);

    // The owner performs and says so. Then the counterparty decides, possibly
    // more than once, and the script does not know how many rounds that is.
    let round = 0;
    let settled = false;
    while (!settled && round < 3) {
      round += 1;
      const note = round === 1 ? 'Delivered: thing-v1.zip' : `Delivered: thing-v${round}.zip (revised)`;
      const asserted = await invoke('log-event', {
        ownerToken,
        body: { type: 'performance.asserted', contract_id: contract.id, payload: { note } },
      });
      if (!ok(`the owner asserts delivery (round ${round})`, asserted.status === 201,
        `HTTP ${asserted.status} ${asserted.reason ?? ''}`)) break;

      const judged = await party.judgeDelivery(contract.id, note);
      ok(`${party.name} returns a verdict (round ${round})`, judged.status === 201,
        `${judged.type}${judged.verdict.reason ? ` — "${judged.verdict.reason}"` : ''}`);
      settled = judged.type === 'performance.accepted' && judged.status === 201;
    }
    ok(`${party.name} eventually settled`, settled, `${round} round(s)`);

    // Payment flows the other way: the receiver reports, the performer
    // acknowledges. Neither side can write the other's half — that is
    // ROLE_REQUIRED in log-event, and it is why these are two calls under two
    // credentials rather than one convenience helper.
    const reported = await party.reportPayment(contract.id, 'Bank transfer sent');
    ok(`${party.name} reports payment as the receiver`, reported.status === 201,
      `HTTP ${reported.status} ${reported.reason ?? ''}`);

    const acked = await invoke('log-event', {
      ownerToken,
      body: { type: 'payment.acknowledged', contract_id: contract.id, payload: {} },
    });
    ok('the owner acknowledges payment as the performer', acked.status === 201,
      `HTTP ${acked.status} ${acked.reason ?? ''}`);

    const finalTrail = await party.readTrail(contract.id);
    const acts = finalTrail?.events ?? [];
    ok(`${party.name} reads the whole trail through its own door`, acts.length > 0,
      `${acts.length} acts`);

    transcripts.push({ contractId: contract.id, party: party.name, rounds: round, acts: acts.length });
  }

  // Two agreements, two counterparties, no account between them.
  console.log('\n--- what this run demonstrates');
  for (const t of transcripts) {
    console.log(`  ${t.party.padEnd(12)} ${t.contractId}  ${t.rounds} delivery round(s), ${t.acts} acts`);
  }
  console.log('  neither counterparty has an auth.users row, a password, or a mailbox.');
  console.log('  what it does NOT show: whether a stranger can use this. See HANDOFF #1.');

  console.log('\nVerify either chain independently:');
  for (const t of transcripts) console.log(`  node scripts/verify-chain.mjs ${t.contractId}`);

  console.log(`\n${checks} checks, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main().catch(err => die(String(err)));
