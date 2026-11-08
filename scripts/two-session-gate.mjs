#!/usr/bin/env node
// The strict two-session gate: a transaction held open at a named boundary.
//
//   node scripts/two-session-gate.mjs <case> <contract-id> [--at <ms>]
//   node scripts/two-session-gate.mjs sql              # print both sessions' SQL
//
// WHY THIS IS SHAPED SO ODDLY
// `scripts/race-delete-vs-append.mjs` races two real requests and sweeps the
// delay. It proved the guards fire in a real interleaving, and Codex accepted
// it as far as it goes — but it controls nothing: the window is found by
// timing, so a run that happens to miss it looks like a pass. What it asked
// for before production is the strict form: one side's transaction HELD at a
// named point, the other side demonstrably blocked on it, and the refusal
// observed after the first side commits.
//
// Holding a transaction open needs a session this repository does not have.
// There is no database password here and no `pg` dependency, by two separate
// deliberate choices (scripts/lib/tfClient.mjs explains the first). So the
// held session is SQL that an operator — or an agent with a privileged SQL
// channel — runs, printed by `… sql` and recorded in .ada/claude-report-3.md
// beside the measurements it produced. This script is the other half: the
// ordinary request that has to block, and the readback that says what landed.
//
// WHAT MAKES IT A MEASUREMENT RATHER THAN A HOPE
// The held session sleeps HOLD_SECONDS while holding the contract row. This
// side records how long its own request took. A request that returns in its
// usual ~1.2s did not wait for anything and the case is reported as NOT RUN
// rather than as a pass — the failure mode of every concurrency test is
// passing because nothing collided.
//
// THE THREE CASES, in Codex's order (2026-11-08):
//   a  delete-then-append : the DELETE is held uncommitted; the append must
//      block on the contract row and then be refused with TF002 once the
//      delete commits. Nothing may be written.
//   b  append-then-delete : an append is held uncommitted; the owner's DELETE
//      must block and then be refused with TF004 once the append commits. The
//      contract and its evidence must both survive.
//   c  acceptance clock   : an event stamped in the future is committed first;
//      the acceptance must be refused rather than recorded behind it. This one
//      needs no concurrency, which is the point — the acceptance writer had no
//      clock rule at all until 8538c32, and this is the path that proves it
//      now has one.

import { ownerSession, rest, PROJECT_REF, SUPABASE_URL } from './lib/tfClient.mjs';
import { SUPABASE_KEY } from '../tests/e2e/liveEnv.js';

// How long the held session keeps its transaction open. Must match the SQL,
// and it is BOUNDED BY statement_timeout, which is the first thing this gate
// measured: `authenticator` carries statement_timeout=8s on this project, so
// a 20s hold did not produce TF002 at all — the blocked request was cancelled
// at 11.35s with "canceling statement due to statement timeout". Nothing was
// written, so the invariant held, but by a timeout rather than by the guard,
// which is not what this case is for. Six seconds leaves the blocked request
// room to wake up and be refused.
const HOLD_SECONDS = 6;

/** Below this, the request plainly did not wait for a lock. */
const BLOCKED_THRESHOLD_MS = 1500;

const OWNER_ID = '5984f56a-ae5a-4d89-ab21-89b8fe483c27';

const SQL = `
-- ── Fixture, run first. Prints the contract id to pass to the script. ────
insert into public.contracts (
  earner_user_id, earner_display_name, project_name, dod, amount_jpy,
  currency, deadline, invited_hirer_email, performed_by, state, invite_token,
  invite_token_expires_at
) values (
  '${OWNER_ID}', 'Two-session Gate', 'two-session gate — case X',
  '["A draft used by the two-session gate"]'::jsonb, 10000, 'JPY',
  current_date + 1, 'harness-guest@example.invalid', 'creator',
  'AWAITING_ACCEPTANCE', gen_random_uuid(), now() + interval '1 day'
) returning id, invite_token;

-- ── Case a: hold the DELETE uncommitted, then commit it ──────────────────
-- Run this FIRST, then  … a <contract-id> --at 4000  within the hold window.
-- The script's request has to arrive while this transaction is open, and it
-- has to finish before statement_timeout cancels it: that is why the hold is
-- ${HOLD_SECONDS}s and not longer.
do $$ begin
  delete from public.contracts where id = '<contract-id>';
  perform pg_sleep(${HOLD_SECONDS});
end $$;

-- ── Case b: hold an append uncommitted, then commit it ───────────────────
-- Same shape, longer hold, because the script's DELETE needs the window to
-- still be open when it arrives — and it is the slower side to start. Run
-- …  b <contract-id> --at 9000  and this immediately after.
do $$ begin
  insert into public.events (type, contract_id, actor_id, created_at, event_hash)
  values ('contract.initiated', '<contract-id>', 'two-session-gate', now(), 'gate-held');
  perform pg_sleep(10);
end $$;

-- ── Case c: commit an event stamped in the future, no holding needed ─────
-- Then  … c <invite-token> --at 0 .
insert into public.events (type, contract_id, actor_id, created_at, event_hash)
values ('contract.initiated', '<contract-id>', 'two-session-gate',
        now() + interval '1 minute', 'gate-future');

-- ── Residue, and why there is no cleanup line here ──────────────────────
-- Every contract these cases leave behind carries an event, so DELETE is
-- refused by the very guard under test (TF004) — and DELETE on "events" is
-- discarded by the append-only rule. The fixtures are permanent, on purpose,
-- and findable:
--   select * from public.contracts where project_name like 'two-session gate%';
--   select * from public.events    where actor_id = 'two-session-gate';
-- Removing them would mean disabling the guard, which is not a thing to do
-- quietly on any database. Counted in .ada/claude-report-3.md instead.
`;

async function logEvent(ownerToken, body) {
  const started = Date.now();
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
    ms: Date.now() - started,
    status: r.status,
    reason: parsed?.error ?? null,
    detail: parsed?.detail ?? null,
  };
}

async function acceptInvite(inviteToken) {
  const started = Date.now();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/validate-invite-token`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      invite_token: inviteToken,
      accept: true,
      hirer_email: 'gate-guest@example.invalid',
      counterparty_name: 'Two-session Gate',
    }),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return {
    ms: Date.now() - started,
    status: r.status,
    reason: parsed?.error ?? null,
    detail: parsed?.detail ?? null,
  };
}

function say(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  const [kase, arg, ...rest_] = process.argv.slice(2);

  if (kase === 'sql') {
    console.log(SQL);
    return;
  }

  if (!['a', 'b', 'c'].includes(kase) || !arg) {
    console.error('usage: two-session-gate.mjs <a|b|c> <contract-id|invite-token> [--at ms]');
    process.exit(2);
  }

  const atIndex = rest_.indexOf('--at');
  const fireAfterMs = atIndex >= 0 ? Number.parseInt(rest_[atIndex + 1], 10) : 6000;

  console.log(`\ntwo-session gate — case ${kase}, project ${PROJECT_REF}`);
  const { token: ownerToken } = await ownerSession();

  console.log(`  waiting ${fireAfterMs}ms for the held session to take the row…`);
  await new Promise((r) => setTimeout(r, fireAfterMs));

  if (kase === 'c') {
    const accept = await acceptInvite(arg);
    console.log('');
    say('acceptance', `HTTP ${accept.status} ${accept.reason ?? ''} (${accept.ms}ms)`);
    say('detail', accept.detail ?? '(none)');
    const refused = accept.status !== 200;
    const namedTheClock = /TF003|does not follow the chain|clock_behind_chain/
      .test(`${accept.reason ?? ''} ${accept.detail ?? ''}`);
    console.log('');
    console.log(refused && namedTheClock
      ? 'PASS — the acceptance was refused, and the refusal names the clock rule.'
      : refused
        ? 'PASS, partly — refused, but the reason does not name the clock rule.'
        : 'FAIL — the acceptance was recorded behind an event stamped after it.');
    process.exit(refused && namedTheClock ? 0 : 1);
  }

  const contractId = arg;

  if (kase === 'a') {
    const append = await logEvent(ownerToken, {
      contract_id: contractId, type: 'contract.initiated', payload: { gate: 'a' },
    });
    const events = await rest(ownerToken, `events?contract_id=eq.${contractId}&select=id`);
    const contract = await rest(ownerToken, `contracts?id=eq.${contractId}&select=id`);
    const eventCount = Array.isArray(events.body) ? events.body.length : -1;
    const gone = Array.isArray(contract.body) && contract.body.length === 0;

    console.log('');
    say('append', `HTTP ${append.status} ${append.reason ?? ''} (${append.ms}ms)`);
    say('detail', append.detail ?? '(none)');
    say('blocked on the lock', append.ms >= BLOCKED_THRESHOLD_MS ? `yes, ${append.ms}ms` : 'NO');
    say('events after', eventCount);
    say('contract after', gone ? 'deleted' : 'still there');

    const blocked = append.ms >= BLOCKED_THRESHOLD_MS;
    const namedTF002 = /TF002|does not exist/.test(`${append.detail ?? ''}`);
    const invariant = !(eventCount > 0 && gone);

    console.log('');
    if (!blocked) {
      console.log('NOT RUN — the append did not wait, so the held session was not holding.');
      process.exit(1);
    }
    console.log(invariant && eventCount === 0 && gone && namedTF002
      ? 'PASS — the append blocked on the held DELETE, was refused with TF002, and wrote nothing.'
      : invariant
        ? 'PASS, partly — the invariant held, but not by the refusal this case is about.'
        : 'FAIL — evidence exists and its agreement does not.');
    process.exit(invariant && eventCount === 0 && gone && namedTF002 ? 0 : 1);
  }

  // case b: the owner's DELETE must block on the held append and be refused.
  const started = Date.now();
  const remove = await rest(ownerToken, `contracts?id=eq.${contractId}`, { method: 'DELETE' });
  const ms = Date.now() - started;
  const body = typeof remove.body === 'string' ? remove.body : JSON.stringify(remove.body ?? '');
  const events = await rest(ownerToken, `events?contract_id=eq.${contractId}&select=id`);
  const contract = await rest(ownerToken, `contracts?id=eq.${contractId}&select=id`);
  const eventCount = Array.isArray(events.body) ? events.body.length : -1;
  const gone = Array.isArray(contract.body) && contract.body.length === 0;

  console.log('');
  say('delete', `HTTP ${remove.status} (${ms}ms)`);
  say('body', body.slice(0, 300));
  say('blocked on the lock', ms >= BLOCKED_THRESHOLD_MS ? `yes, ${ms}ms` : 'NO');
  say('events after', eventCount);
  say('contract after', gone ? 'deleted' : 'still there');

  const blocked = ms >= BLOCKED_THRESHOLD_MS;
  const namedTF004 = /TF004|carries evidence/.test(body);
  const invariant = !(eventCount > 0 && gone);

  console.log('');
  if (!blocked) {
    console.log('NOT RUN — the delete did not wait, so the held session was not holding.');
    process.exit(1);
  }
  console.log(invariant && eventCount > 0 && !gone && namedTF004
    ? 'PASS — the delete blocked on the held append, then was refused with TF004.'
    : invariant && eventCount > 0 && !gone
      ? 'PASS, partly — the evidence and its agreement both survived, but the refusal does not name TF004.'
      : 'FAIL — evidence exists and its agreement does not.');
  process.exit(invariant && eventCount > 0 && !gone ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
