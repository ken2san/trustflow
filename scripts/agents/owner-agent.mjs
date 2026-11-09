#!/usr/bin/env node
// The creating party's agent. A separate process, holding an account.
//
// Its authority is a verified Earner's JWT, obtained by `ownerSession()` — a
// password grant, which exists ONLY for harnesses. The product's own sign-in is
// an emailed OTP behind a Turnstile challenge and no agent can complete it;
// see .ada/claude-report-13.md §4. That gap is the honest limit of this run:
// everything after the first credential is agent-reachable, and the first
// credential is not.
//
// It never learns the counterparty's address, capability or verdict except by
// reading the evidence trail like anyone else. Coordination between the two
// processes is: one invite token, handed over once, in one direction.

import { randomUUID } from 'node:crypto';
import { ownerSession, rest, invoke, SUPABASE_URL, PROJECT_REF } from '../lib/tfClient.mjs';
import { redact } from '../lib/e2eGuard.mjs';
import { channel, reporter, until } from './lib.mjs';

const DIR = process.env.TF_CHANNEL_DIR;
if (!DIR) {
  console.error('owner: TF_CHANNEL_DIR is required');
  process.exit(2);
}

const r = reporter('owner');
const RUN = randomUUID().slice(0, 8);

/** Tomorrow, locally. toISOString() makes today read as past east of Greenwich. */
function tomorrowLocalISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}

async function main() {
  const ch = channel(DIR);
  const { token, userId } = await ownerSession();
  r.ok('holds a verified session', Boolean(token && userId), `project ${PROJECT_REF}`);

  // CAD with cents, deliberately. $1,250.50 is 125050 minor units, and every
  // path that has ever been exercised headlessly was in yen — a currency with
  // no minor unit, where the mandatory-digest branch does not apply.
  const created = await rest(token, 'contracts?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      earner_user_id: userId,
      earner_display_name: 'Owner Agent',
      project_name: `two-agent ${RUN} — CAD`,
      dod: ['Translate the document', 'Return a stamped PDF'],
      amount_minor: 125050,
      currency: 'CAD',
      deadline: tomorrowLocalISO(),
      invited_hirer_email: 'agent-guest@example.invalid',
      performed_by: 'creator',
    }),
  });
  const contract = Array.isArray(created.body) ? created.body[0] : null;
  r.ok('created a CAD agreement', created.status === 201 && Boolean(contract?.id),
    `HTTP ${created.status} ${contract?.amount_minor} ${contract?.currency}`);
  if (!contract) throw new Error(`creation failed: ${JSON.stringify(created.body)}`);
  console.log(`      contract ${contract.id}`);

  r.ok('the deprecated yen mirror is null off JPY', contract.amount_jpy === null,
    String(contract.amount_jpy));

  // The handover. This is the entire delivery mechanism, by rule: TrustFlow
  // does not send invitations and the other side cannot look one up.
  await ch.put('invite.json', { invite_token: contract.invite_token, run: RUN });
  r.ok('handed the invitation to the other agent, out of band',
    Boolean(contract.invite_token), redact(contract.invite_token));

  // From here the two sides coordinate only through the record.
  await until('the counterparty to accept', async () => {
    const got = await rest(token, `contracts?id=eq.${contract.id}&select=state`);
    return got.body?.[0]?.state === 'TERMS_ACCEPTED' ? got.body[0] : null;
  });
  r.ok('saw the agreement accepted by the other side', true, 'TERMS_ACCEPTED');

  const asserted = await invoke('log-event', {
    ownerToken: token,
    body: {
      type: 'performance.asserted', contract_id: contract.id,
      idempotency_key: `agent-deliver-${RUN}`,
      payload: { note: 'Stamped PDF returned' },
    },
  });
  r.ok('asserted delivery', asserted.status === 201 || asserted.status === 200,
    `HTTP ${asserted.status} ${asserted.reason ?? ''}`);

  const ownEvents = () => rest(token, `events?contract_id=eq.${contract.id}&select=type,created_at`);

  await until('the counterparty to accept the delivery', async () => {
    const got = await ownEvents();
    return got.body?.some(e => e.type === 'performance.accepted') ? got : null;
  });
  r.ok('saw the delivery accepted', true);

  await until('the payer to report the transfer', async () => {
    const got = await ownEvents();
    return got.body?.some(e => e.type === 'payment.reported') ? got : null;
  });
  r.ok('saw the payment reported', true);

  // The payee's own statement that it arrived. Not an observation: TrustFlow
  // cannot see the rail the money moved on.
  const ack = await invoke('log-event', {
    ownerToken: token,
    body: {
      type: 'payment.acknowledged', contract_id: contract.id,
      idempotency_key: `agent-ack-${RUN}`,
      payload: { note: 'Arrived, full amount' },
    },
  });
  r.ok('acknowledged receiving the payment', ack.status === 201 || ack.status === 200,
    `HTTP ${ack.status} ${ack.reason ?? ''}`);

  const final = await ownEvents();
  r.ok('the trail holds the whole transaction', (final.body?.length ?? 0) >= 5,
    `${final.body?.length} events`);

  await ch.put('done.json', { contract_id: contract.id, url: SUPABASE_URL });
}

main()
  .then(() => {
    if (r.failures.length) {
      console.error(`owner: ${r.failures.length} failed`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error(`owner ABORTED: ${err.message}`);
    process.exit(1);
  });
