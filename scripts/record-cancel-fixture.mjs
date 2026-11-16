#!/usr/bin/env node
// Record, ONCE, the contract.cancelled events that
// tests/e2e/cancellation-refusal.spec.js replays.
//
//   node scripts/record-cancel-fixture.mjs --check    preconditions only; writes nothing
//   node scripts/record-cancel-fixture.mjs            record the fixture
//   node scripts/record-cancel-fixture.mjs --resume   finish an interrupted run (cancellations only)
//
// WHY A ONE-OFF, AND WHY BEFORE THE DEPLOY
// After Task 81, log-event refuses every new contract.cancelled and only
// replays one already recorded. The replay tests therefore need cancellations
// written by the log-event that still accepts them — E2E's v14 — and this
// script refuses to run against anything else. Once the refusing version is
// deployed, a fixture can never be made again; keep the file.
//
// WHAT IT WRITES, PERMANENTLY (E2E only; events are append-only and a contract
// with events cannot be deleted): one contract, its acceptance, one owner
// cancellation and one guest cancellation. That is the successful path. An
// interrupted run can leave a contract with fewer events; see RECOVERY.
//
// THE FILE IS THE ONLY RECORD. tests/e2e/.cancel-fixture.json holds the ids,
// the two keys and the guest token the guest cancellation was made with. It is
// created with no-clobber BEFORE the first permanent write, so a second run
// cannot overwrite a first run's record (Codex Task 87), and it is updated
// after every irreversible step, so an interruption leaves the ids of what
// exists. Mode 0600; never printed. The token is revoked on every spec run.
//
// RECOVERY. On any failure the script stops; it never retries a step whose
// outcome it does not know. The file says `status: "pending"` and which step
// last completed. Do not delete it.
//   - Stopped before `contract_id` was recorded: the contract may or may not
//     exist. Find it as the owner by project name (it carries the run id).
//     Not resumable — make a new fixture only after deciding about that row.
//   - Stopped before `guest_token_at_record`: the invitation may already be
//     consumed. Not resumable; the owner can reissue guest access by hand.
//   - Stopped during a cancellation: `--resume` first reads the contract's
//     events as the owner and records any cancellation already under its key;
//     only a missing one is written, with the same key (an idempotent
//     request to v14).

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ownerSession, rest, invoke, PROJECT_REF, SUPABASE_URL } from './lib/tfClient.mjs';
import { readCredentialFile, writeCredentialFile } from './lib/credentialFile.mjs';
import { SUPABASE_KEY, EARNER_EMAIL } from '../tests/e2e/liveEnv.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = process.env.TF_CANCEL_FIXTURE
  ?? path.join(REPO_ROOT, 'tests/e2e/.cancel-fixture.json');

// E2E's log-event as deployed in Task 73: the last version that accepts a new
// contract.cancelled. Compared as the measured bundle digest, never a version
// number.
const ACCEPTING_LOG_EVENT_EZBR = 'a1f2f779fe04d3e4620414298b8f965e7875239941f3067280fdee9ed26f1b84';

const CANCELLED = 'contract.cancelled';
const GUEST_EMAIL = 'cancel.fixture@example.test';

const mode = process.argv.includes('--resume') ? 'resume'
  : process.argv.includes('--check') ? 'check' : 'record';

function stop(message) {
  console.error(`STOP: ${message}`);
  console.error(`Nothing further was written. Fixture file: ${path.relative(REPO_ROOT, FIXTURE_FILE)}`);
  process.exit(1);
}

const say = message => console.log(message);

// ── Preconditions: no writes ────────────────────────────────────────────────

function deployedLogEventDigest() {
  let listing;
  try {
    listing = JSON.parse(execFileSync('supabase',
      ['functions', 'list', '--project-ref', PROJECT_REF, '-o', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (error) {
    stop(`could not list E2E functions with the supabase CLI (${error.code ?? error.name})`);
  }
  return listing.find(f => f.slug === 'log-event')?.ezbr_sha256 ?? null;
}

async function verifiedOwner() {
  const { token, userId } = await ownerSession();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = r.status === 200 ? await r.json() : null;
  const ok = user?.id === userId && user?.is_anonymous !== true
    && String(user?.email ?? '').toLowerCase() === String(EARNER_EMAIL ?? '').toLowerCase();
  if (!ok) stop('the owner session is not the configured E2E test account');
  return { token, userId };
}

async function fixtureExists() {
  try { await lstat(FIXTURE_FILE); return true; } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/** The contract's events as the owner reads them. */
async function ownerEvents(token, contractId) {
  const r = await rest(token,
    `events?select=id,type,idempotency_key,actor_id&contract_id=eq.${contractId}&order=id`);
  if (r.status !== 200) stop(`owner event read failed (${r.status})`);
  return r.body;
}

// ── The record file ─────────────────────────────────────────────────────────

let record = null;

/** Update this run's own file. Refuses a file that belongs to another run. */
async function save(changes) {
  const onDisk = await readCredentialFile(FIXTURE_FILE);
  if (onDisk.run_id !== record.run_id) stop('the fixture file now belongs to another run');
  record = { ...record, ...changes, updated_at: new Date().toISOString() };
  await writeCredentialFile(FIXTURE_FILE, record);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function cancel(label, auth, keyField, idField, owner) {
  if (record[idField]) return;
  // On resume, reconcile before writing: an earlier attempt may have landed.
  const existing = (await ownerEvents(owner.token, record.contract_id))
    .find(e => e.idempotency_key === record[keyField]);
  if (existing) {
    if (existing.type !== CANCELLED) stop(`${label} key is held by a ${existing.type} event`);
    await save({ [idField]: existing.id, step: idField });
    say(`  ${label} cancellation already recorded: ${existing.id}`);
    return;
  }
  const r = await invoke('log-event', {
    ...auth,
    body: { type: CANCELLED, contract_id: record.contract_id, idempotency_key: record[keyField] },
  });
  if (!(r.status === 201 || (r.status === 200 && r.data?.deduplicated === true)) || !r.data?.event?.id) {
    stop(`${label} cancellation answered ${r.status} ${r.reason ?? ''}; its outcome must be reconciled with --resume`);
  }
  await save({ [idField]: r.data.event.id, step: idField });
  say(`  ${label} cancellation recorded: ${r.data.event.id}`);
}

async function finish(owner) {
  const events = await ownerEvents(owner.token, record.contract_id);
  const has = (id, key) => events.some(e => e.id === id && e.type === CANCELLED && e.idempotency_key === key);
  if (!has(record.owner_event_id, record.owner_key) || !has(record.guest_event_id, record.guest_key)) {
    stop('the recorded cancellations are not both visible to the owner');
  }
  await save({ status: 'complete', step: 'complete' });
  say(`Fixture complete: contract ${record.contract_id}. Keep ${path.relative(REPO_ROOT, FIXTURE_FILE)}.`);
}

// ── Main ────────────────────────────────────────────────────────────────────

say(`Target: ${PROJECT_REF} (E2E). Mode: ${mode}.`);

const digest = deployedLogEventDigest();
if (digest !== ACCEPTING_LOG_EVENT_EZBR) {
  stop(`E2E log-event is not the version that accepts ${CANCELLED} (ezbr ${String(digest).slice(0, 16)}…)`);
}
say('  log-event: v14 artifact, still accepts the type');

const owner = await verifiedOwner();
say('  owner session: the E2E test account');

if (mode === 'check') {
  say(await fixtureExists()
    ? '  fixture file EXISTS: a record run would refuse; inspect it before doing anything'
    : '  fixture file absent: a record run may proceed');
  say('Check only: nothing was written.');
  process.exit(0);
}

if (mode === 'resume') {
  try { record = await readCredentialFile(FIXTURE_FILE); } catch (e) {
    stop(`no fixture file to resume (${e.code ?? e.name})`);
  }
  if (record.project_ref !== PROJECT_REF) stop('the fixture file was made for another project');
  if (record.status === 'complete') { say('Already complete: nothing to do.'); process.exit(0); }
  if (!record.contract_id) stop('no contract_id recorded: not resumable (see RECOVERY in this file)');
  if (!record.guest_token_at_record) stop('no guest token recorded: not resumable (see RECOVERY in this file)');
} else {
  const runId = randomUUID();
  record = {
    status: 'pending',
    step: 'started',
    run_id: runId,
    project_ref: PROJECT_REF,
    owner_key: `cancel-fixture:owner:${runId}`,
    guest_key: `cancel-fixture:guest:${runId}`,
    created_at: new Date().toISOString(),
  };
  // The guard against a second run: link(2) refuses an existing file
  // atomically, and nothing permanent has been written yet.
  try {
    await writeCredentialFile(FIXTURE_FILE, record, { noClobber: true });
  } catch (e) {
    if (e.code === 'EEXIST') stop('a fixture file already exists; it may be the only record of permanent rows');
    throw e;
  }
  say(`  run ${runId}: record file created`);

  // Permanent from here on.
  const created = await rest(owner.token, 'contracts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      earner_user_id: owner.userId,
      earner_display_name: 'Cancellation Fixture',
      project_name: `Cancellation fixture ${runId}`,
      dod: ['fixture'],
      amount_jpy: 1000,
      amount_minor: 1000,
      currency: 'JPY',
      invited_hirer_email: GUEST_EMAIL,
    }),
  });
  const contract = created.status === 201 && Array.isArray(created.body) ? created.body[0] : null;
  if (!contract?.id) stop(`contract creation answered ${created.status}; find it by its project name before anything else`);
  await save({ contract_id: contract.id, invite_token: contract.invite_token, step: 'contract_id' });
  say(`  contract created: ${contract.id}`);

  const accept = await invoke('validate-invite-token', {
    body: { invite_token: contract.invite_token, accept: true, hirer_email: GUEST_EMAIL, counterparty_name: 'Fixture Guest' },
  });
  if (accept.status !== 200 || !accept.data?.guest_access_token) {
    stop(`acceptance answered ${accept.status} ${accept.reason ?? ''}; the invitation may be consumed`);
  }
  await save({ guest_token_at_record: accept.data.guest_access_token, invite_token: null, step: 'guest_token_at_record' });
  say('  invitation accepted (guest token stored, not shown)');
}

await cancel('owner', { ownerToken: owner.token }, 'owner_key', 'owner_event_id', owner);
await cancel('guest', { guestToken: record.guest_token_at_record }, 'guest_key', 'guest_event_id', owner);
await finish(owner);
