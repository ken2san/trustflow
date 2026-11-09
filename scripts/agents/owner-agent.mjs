#!/usr/bin/env node
// The creating party's agent. A separate process, holding a key.
//
// WHAT IT IS GIVEN
//   TF_SUPABASE_URL, TF_SUPABASE_ANON_KEY — public, in every request the web
//     app makes.
//   TF_OWNER_KEY_FILE — one opaque string, a Supabase refresh token, handed
//     over once by a human who signed in. `grant_type=refresh_token` is not a
//     sign-in, so no address, password, mailbox or CAPTCHA is involved. See
//     ../lib/ownerKey.mjs.
//   TF_CHANNEL_DIR — where it leaves the invitation for the other agent.
//
// WHAT IT IS NOT GIVEN
// The earner's address or password, and no module that reads them. It does not
// import the password-grant client, nor tests/e2e/liveEnv.js, which refuses to
// load without those two variables. That is the whole difference from the
// previous run: the credential is now one a real agent could be handed.
//
// What the key is NOT is a scoped API key. It is the account. Every event below
// records `_auth_method: account_session` and names the owner, because that is
// what happened — nothing in the record distinguishes this process from the
// human. .ada/claude-report-15.md §3 says what a real first-party key needs.
//
// It never learns the counterparty's address, capability or verdict except by
// reading the evidence trail like anyone else. Coordination between the two
// processes is: one invite token, handed over once, in one direction.

import { randomUUID } from 'node:crypto';
import { assertE2EProject, redact } from '../lib/e2eGuard.mjs';
import { ownerSessionFromKey } from '../lib/ownerKey.mjs';
import { channel, fn, rest as restCall, reporter, until } from './lib.mjs';

const URL_ = process.env.TF_SUPABASE_URL;
const KEY = process.env.TF_SUPABASE_ANON_KEY;
const KEY_FILE = process.env.TF_OWNER_KEY_FILE;
const DIR = process.env.TF_CHANNEL_DIR;
if (!URL_ || !KEY || !KEY_FILE || !DIR) {
  console.error('owner: TF_SUPABASE_URL, TF_SUPABASE_ANON_KEY, TF_OWNER_KEY_FILE'
    + ' and TF_CHANNEL_DIR are required');
  process.exit(2);
}
const PROJECT_REF = assertE2EProject(URL_);

// A PRECONDITION, not a reported check. The first version asserted this inside
// main() AFTER the key exchange, through the reporter — so a directly launched
// child with the earner's password in its environment would authenticate, write
// events, and merely log a failed line. Codex's judgment 3. The claim this file
// makes is that it holds only a key; refusing to start is what makes that true
// of the process rather than of the intention.
if (process.env.TF_TEST_EARNER_EMAIL || process.env.TF_TEST_EARNER_PASSWORD) {
  console.error('owner: refusing to run — TF_TEST_EARNER_EMAIL / _PASSWORD are set.');
  console.error('This process is meant to hold one handed-over key and nothing else.');
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

  // No address, no password, no mailbox, no CAPTCHA — one string, exchanged.
  const { token, userId, rotated } = await ownerSessionFromKey(URL_, KEY, KEY_FILE);
  r.ok('exchanged a handed-over key for a session', Boolean(token && userId),
    `project ${PROJECT_REF}`);
  // Already enforced at module load, above; restated here so the run's own
  // output says what the credential was. It is a statement about sign-in INPUT:
  // the session response and the JWT may well carry the account's address, so
  // the supportable claim is that none was supplied, not that none exists in
  // this process's memory.
  r.ok('was supplied no address or password, only a key', true,
    'refused to start otherwise');
  // The part a deployment gets wrong: a new refresh token comes back from every
  // exchange, and an agent that does not persist it is relying on a reuse
  // window it does not control. This says the replacement was written — NOT
  // that the previous string stopped working, which it does not do promptly
  // (measured; see ../lib/ownerKey.mjs).
  r.ok('the key was replaced, and the replacement persisted', rotated,
    rotated ? 'the previous string stays usable for a while' : 'NO new token returned');

  // CAD with cents, deliberately. $1,250.50 is 125050 minor units, and every
  // path that has ever been exercised headlessly was in yen — a currency with
  // no minor unit, where the mandatory-digest branch does not apply.
  const created = await restCall(URL_, KEY, token, 'contracts?select=*', {
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
    const got = await restCall(URL_, KEY, token, `contracts?id=eq.${contract.id}&select=state`);
    return got.body?.[0]?.state === 'TERMS_ACCEPTED' ? got.body[0] : null;
  });
  r.ok('saw the agreement accepted by the other side', true, 'TERMS_ACCEPTED');

  const asserted = await fn(URL_, KEY, 'log-event', {
    bearer: token,
    body: {
      type: 'performance.asserted', contract_id: contract.id,
      idempotency_key: `agent-deliver-${RUN}`,
      payload: { note: 'Stamped PDF returned' },
    },
  });
  r.ok('asserted delivery', asserted.status === 201 || asserted.status === 200,
    `HTTP ${asserted.status} ${asserted.reason ?? ''}`);

  const ownEvents = () => restCall(URL_, KEY, token, `events?contract_id=eq.${contract.id}&select=type,created_at`);

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
  const ack = await fn(URL_, KEY, 'log-event', {
    bearer: token,
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

  await ch.put('done.json', { contract_id: contract.id });
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
