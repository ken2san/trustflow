#!/usr/bin/env node
// Two sessions, one contract, both orders, many times.
//
//   npm run test:race          20 trials
//   npm run test:race -- 50    50
//
// WHY THIS EXISTS
// Everything else written on 2026-11-08 to close the orphaned-evidence race
// is either an argument about PostgreSQL or a refusal measured at a single
// write boundary. Codex passed the design under READ COMMITTED and named the
// one thing still missing: a two-session test, including the reverse order.
// This is that test, with the smallest possible apparatus.
//
// WHAT IT DOES NOT DO
// It does not control the interleaving. There is no test-only pause hook and
// no service_role here, by the same policy that governs scripts/api-e2e.mjs —
// both sides are ordinary requests under the owner's own JWT, exactly what the
// browser sends. So it fires `log-event` and `DELETE /contracts` at the same
// moment, repeatedly, and reports which orders actually occurred.
//
// AND IT SWEEPS THE DELAY, because firing both at once does not race.
// Measured on the first run: twenty trials, twenty times the delete won, with
// `log-event` answering 404 before it had read anything — a PostgREST DELETE
// completes in a fraction of an Edge Function's round trip, so "simultaneous"
// means the append starts after the contract is already gone. That is a
// legitimate outcome and no test at all. So the DELETE is held back by a few
// tens of milliseconds, sweeping the range, to arrive while the append is
// actually in flight.
//
// THE ASSERTION IS THE INVARIANT, NOT THE TIMING
// For every trial, whatever order the two requests happened to take:
//
//     NOT (an event exists AND the contract is gone)
//
// A trial in which the delete won and no event was written is a pass. A trial
// in which the event was written and the delete was refused is a pass. The
// only failure is evidence whose agreement no longer exists — which is the
// defect, stated as a property rather than as a sequence. Trials that resolve
// without contention are reported separately so the number of genuine races
// is visible rather than assumed; a run of twenty that never collided is a
// weak result, and says so.
//
// Not in `npm run test:api`: it writes a contract per trial and its value is
// in repetition, which is not what a one-transaction smoke test is for.

import { ownerSession, rest, PROJECT_REF, SUPABASE_URL } from './lib/tfClient.mjs';
// The same loader tfClient uses, so this script cannot end up pointed
// somewhere else: the guard in e2eGuard.mjs has already run by then.
import { SUPABASE_KEY } from '../tests/e2e/liveEnv.js';

/**
 * `log-event`, read in full rather than through tfClient's `invoke`.
 *
 * The detail is the evidence here: a 500 proves only that the insert was
 * refused, while the message names WHICH guard refused it, and the whole
 * point of this script is which one.
 */
async function logEvent(ownerToken, body) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/log-event`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return {
    status: r.status,
    reason: parsed?.error ?? null,
    detail: parsed?.detail ?? null,
  };
}

const TRIALS = Number.parseInt(process.argv[2] ?? '20', 10);

/** Milliseconds to hold the DELETE back by, swept across the trials. */
// Walked past `log-event`'s own latency (~1.2s against E2E) on purpose: below
// it the delete always commits first, above it the append does, and the two
// orders are the two halves of the test.
// The values near 1100 are there to hunt the narrowest case of all: a DELETE
// whose scan begins before the append commits, so that it waits on the row and
// has to refuse with TF004 after the wait. Below that band RLS has already
// rowed the contract out of scope and the delete is refused silently, which is
// also correct but is a different refusal.
const DELAYS = [
  0, 50, 100, 200, 400, 700,
  1000, 1050, 1100, 1150, 1200, 1250, 1300,
  1800, 2500,
];
const RUN = `race ${new Date().toISOString()}`;

/** Tomorrow, locally — a deadline in the past is refused at creation. */
function tomorrowLocalISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}

async function makeDraft(ownerToken, ownerId, n) {
  const created = await rest(ownerToken, 'contracts?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      earner_user_id: ownerId,
      earner_display_name: 'Race Harness Owner',
      project_name: `${RUN} — trial ${n}`,
      dod: ['A draft raced against its own evidence'],
      amount_jpy: 10000,
      currency: 'JPY',
      deadline: tomorrowLocalISO(),
      invited_hirer_email: 'harness-guest@example.invalid',
      performed_by: 'creator',
    }),
  });
  return (Array.isArray(created.body) ? created.body[0] : null)?.id ?? null;
}

async function main() {
  console.log(`\nDELETE vs append — ${TRIALS} trials, project ${PROJECT_REF}\n`);
  const { token: ownerToken, userId: ownerId } = await ownerSession();

  const tally = { bothRefused: 0, appendWon: 0, deleteWon: 0 };
  let tf004 = 0;
  const orphaned = [];

  for (let n = 1; n <= TRIALS; n++) {
    const id = await makeDraft(ownerToken, ownerId, n);
    if (!id) {
      console.error(`trial ${n}: could not create a draft`);
      process.exit(1);
    }

    // The append starts first and the delete arrives mid-flight. The sweep
    // walks the delay across the append's own latency, which is where the
    // window is; a single fixed sleep would test one point of it and call
    // that the answer.
    const delayMs = DELAYS[(n - 1) % DELAYS.length];
    const startedAt = Date.now();
    const [append, remove] = await Promise.all([
      logEvent(ownerToken, { contract_id: id, type: 'contract.initiated', payload: { trial: n } }),
      (async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return rest(ownerToken, `contracts?id=eq.${id}`, { method: 'DELETE' });
      })(),
    ]);
    const appendMs = Date.now() - startedAt;

    // What is actually on the record afterwards. Read as the owner, which is
    // the only authority this script has — and enough: an event that exists
    // while its contract does not is precisely what the owner cannot see.
    const events = await rest(ownerToken, `events?contract_id=eq.${id}&select=id,type`);
    const contract = await rest(ownerToken, `contracts?id=eq.${id}&select=id`);
    const eventCount = Array.isArray(events.body) ? events.body.length : -1;
    const contractGone = Array.isArray(contract.body) && contract.body.length === 0;

    if (eventCount > 0 && contractGone) {
      orphaned.push({ id, append: append.status, remove: remove.status });
    }

    if (eventCount > 0 && !contractGone) tally.appendWon += 1;
    else if (eventCount === 0 && contractGone) tally.deleteWon += 1;
    else if (eventCount === 0 && !contractGone) tally.bothRefused += 1;

    const verdict = eventCount > 0 && contractGone ? 'ORPHANED'
      : eventCount > 0 ? 'append won, contract kept'
      : contractGone ? 'delete won, nothing written'
      : 'neither landed';
    // Which guard refused, when one did. TF002 is the parent-existence check
    // added today; anything else here is a different fault and should be read
    // as one.
    const guard = /TF002|does not exist/.test(append.detail ?? '') ? ' [TF002]' : '';
    const deleteBody = typeof remove.body === 'string'
      ? remove.body : JSON.stringify(remove.body ?? '');
    const deleteGuard = /TF004|carries evidence/.test(deleteBody) ? ' [TF004]' : '';
    if (deleteGuard) tf004 += 1;
    console.log(` ${String(n).padStart(3)}. +${String(delayMs).padStart(4)}ms`
      + `  log-event ${append.status}${append.reason ? ` ${append.reason}` : ''}${guard}`
      + ` (${appendMs}ms) / delete ${remove.status}${deleteGuard}  → ${verdict}`);

    // A draft that survived its own race is left behind otherwise.
    if (!contractGone && eventCount === 0) {
      await rest(ownerToken, `contracts?id=eq.${id}`, { method: 'DELETE' });
    }
  }

  console.log(`\nappend won: ${tally.appendWon}   delete won: ${tally.deleteWon}`
    + `   neither: ${tally.bothRefused}   TF004 refusals: ${tf004}`);
  if (tf004 === 0) {
    console.log('No TF004: in every trial where the append won, RLS had already');
    console.log('rowed the contract out of scope before the delete scanned it, so');
    console.log('the delete-side trigger was never the thing that refused. Correct,');
    console.log('and not a test of that trigger.');
  }

  if (orphaned.length > 0) {
    console.error(`\nFAIL: ${orphaned.length} orphaned event(s) — evidence whose contract is gone:`);
    for (const o of orphaned) console.error(`  contract ${o.id}`);
    process.exit(1);
  }

  if (tally.appendWon === 0 || tally.deleteWon === 0) {
    console.log('\nPASS, weakly: the invariant held in every trial, but only one');
    console.log('of the two orders occurred, so the other is untested here.');
    process.exit(0);
  }

  console.log('\nPASS: both orders occurred and no trial left evidence without its agreement.');
}

main().catch((err) => { console.error(err); process.exit(1); });
