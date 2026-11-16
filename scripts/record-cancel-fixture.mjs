#!/usr/bin/env node
// Record, ONCE, the contract.cancelled events that
// tests/e2e/cancellation-refusal.spec.js replays.
//
//   node scripts/record-cancel-fixture.mjs --check    read-only preflight (see READ-ONLY below)
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
// READ-ONLY. `--check` makes no request that writes and changes no local file:
// it uses the cached owner session as it is (no sign-in, no refresh, no cache
// write, no chmod — a loose cache file is refused, not narrowed), takes no
// lock, and reads E2E with GET /auth/v1/user and `supabase functions list`.
// With no live cached session it fails; it does not make one.
// record and --resume DO sign in if the cache is stale (tfClient's password
// grant, which rewrites tests/e2e/.earner-session.json).
//
// ONE LOCK. record and --resume take the same lock as the spec
// (scripts/lib/fixtureLock.mjs) before touching anything, and hold it to the
// end. An existing lock — even a dead process's — stops the run; it is never
// taken over. Every update of the record file is made under it, and checks
// that the file is still this run's, at the revision this run last wrote.
//
// THE FILE IS THE ONLY RECORD. tests/e2e/.cancel-fixture.json holds the ids,
// the two keys and the guest token the guest cancellation was made with. It is
// created with no-clobber BEFORE the first permanent write, so a second run
// cannot overwrite a first run's record, and it is updated after every step,
// so an interruption leaves the ids of what exists. Mode 0600; never printed.
// The token is revoked on every spec run.
//
// UNKNOWN OUTCOMES (Codex Task 88). A cancellation is marked `unknown` before
// it is sent, and becomes `recorded` only on a success response carrying the
// event id. Anything else — a timeout, a 5xx, a dropped connection, an
// unexpected status — leaves it `unknown` and stops: the request may still be
// running. `--resume` then only RECONCILES: it reads the contract's events as
// the owner and records a cancellation found under the key, if its type and
// actor are the expected ones (a mismatch stops). If none is found it stops
// again. The script NEVER re-sends an attempt whose outcome is unknown:
// nothing here proves the earlier request has finished, or that a second one
// could not add a second event (Codex Task 89). Settling it is manual —
// reconcile what E2E actually holds — and any re-send needs Kenji's explicit
// approval and is done by hand, outside this script.
//
// RECOVERY. On any stop the file says `status: "pending"`, the last completed
// `step`, and any `*_outcome: "unknown"`. Do not delete it.
//   - Stopped before `contract_id` was recorded: the contract may or may not
//     exist. Find it as the owner by project name (it carries the run id).
//     Not resumable.
//   - Stopped before `guest_token_at_record`: the invitation may already be
//     consumed. Not resumable; the owner can reissue guest access by hand.
//   - Stopped at a cancellation: `--resume` as above.

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readCredentialFile, writeCredentialFile } from './lib/credentialFile.mjs';
import { CANCEL_FIXTURE_FILE, CANCEL_FIXTURE_LOCK, acquireFixtureLock } from './lib/fixtureLock.mjs';
import { FIXTURE_USAGE, parseFixtureArgs } from './lib/fixtureArgs.mjs';

// Arguments first, before anything that reads configuration, signs in, locks
// or writes. tfClient and liveEnv are imported only after this, dynamically.
const mode = parseFixtureArgs(process.argv.slice(2));
if (mode === null) {
  console.error(`STOP: unrecognised arguments; nothing was done. ${FIXTURE_USAGE}`);
  process.exit(2);
}

let ownerSession, rest, invoke, PROJECT_REF, SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL;
try {
  ({ ownerSession, rest, invoke, PROJECT_REF, SUPABASE_URL } = await import('./lib/tfClient.mjs'));
  ({ SUPABASE_KEY, EARNER_EMAIL } = await import('../tests/e2e/liveEnv.js'));
} catch {
  // Its message can name configuration values; say only what failed.
  console.error('STOP: could not load the E2E configuration (details not shown); nothing was done.');
  process.exit(1);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOWN_FILE = path.relative(REPO_ROOT, CANCEL_FIXTURE_FILE);
// The same cache tfClient.ownerSession() uses.
const SESSION_CACHE = process.env.TF_TEST_EARNER_SESSION
  ?? path.join(REPO_ROOT, 'tests/e2e/.earner-session.json');

// E2E's log-event as deployed in Task 73: the last version that accepts a new
// contract.cancelled. Compared as the measured bundle digest, never a version
// number.
const ACCEPTING_LOG_EVENT_EZBR = 'a1f2f779fe04d3e4620414298b8f965e7875239941f3067280fdee9ed26f1b84';

const CANCELLED = 'contract.cancelled';
const GUEST_EMAIL = 'cancel.fixture@example.test';
const GUEST_ACTOR = `guest:${GUEST_EMAIL}`;

/** A server-issued id, printed only if it is a UUID. */
const safeId = id => (typeof id === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : '(id not shown)');

class Stop extends Error {}
const stop = (message) => { throw new Stop(message); };
const say = message => console.log(message);

// The error codes log-event and validate-invite-token are known to return.
// Only these are ever printed; any other server-supplied text is not, however
// harmless it looks (Codex Task 89: a format filter would pass a token).
const KNOWN_REASONS = new Set([
  'accept_failed', 'already_used', 'chain_contention', 'clock_behind_chain', 'contract_deleted',
  'contract_not_found', 'dod_hash_is_server_derived', 'expired', 'guest_append_unavailable',
  'guest_credential_expired', 'guest_credential_revoked', 'idempotency_key_in_use', 'insert_failed',
  'internal_error', 'invalid_body', 'invalid_idempotency_key', 'invalid_payload', 'lookup_failed',
  'missing_contract_id', 'not_a_party', 'not_found', 'payload_too_large', 'terms_changed',
  'terms_check_unsupported', 'type_is_server_recorded', 'type_not_allowed', 'type_retired',
  'wrong_party_for_event_type', 'wrong_state_for_event_type',
]);
const safeReason = reason => (KNOWN_REASONS.has(reason) ? reason : 'unrecognised_reason');

// ── Preconditions: no writes ────────────────────────────────────────────────

function deployedLogEventDigest() {
  let listing;
  try {
    listing = JSON.parse(execFileSync('supabase',
      ['functions', 'list', '--project-ref', PROJECT_REF, '-o', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    stop('could not list E2E functions with the supabase CLI');
  }
  return listing.find(f => f.slug === 'log-event')?.ezbr_sha256 ?? null;
}

async function checkIdentity(token, userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = r.status === 200 ? await r.json() : null;
  const ok = user?.id === userId && user?.is_anonymous !== true
    && String(user?.email ?? '').toLowerCase() === String(EARNER_EMAIL ?? '').toLowerCase();
  if (!ok) stop('the owner session is not the configured E2E test account');
}

/** The cached session as it is, for --check: no grant, no refresh, no write. */
async function cachedOwnerReadOnly() {
  let session;
  try {
    session = await readCredentialFile(SESSION_CACHE, { readOnly: true });
  } catch {
    stop('no usable cached owner session (missing, unreadable or loosely permitted); --check does not sign in');
  }
  if (!session?.access_token || !session?.user?.id || !(session.expires_at * 1000 > Date.now())) {
    stop('the cached owner session is missing or expired; --check does not sign in or refresh');
  }
  await checkIdentity(session.access_token, session.user.id);
  return { token: session.access_token, userId: session.user.id };
}

/** For record and --resume: may sign in and rewrite the session cache. */
async function verifiedOwner() {
  const { token, userId } = await ownerSession();
  await checkIdentity(token, userId);
  return { token, userId };
}

const exists = p => lstat(p).then(() => true, e => {
  if (e.code === 'ENOENT') return false;
  throw e;
});

/** The contract's events as the owner reads them. */
async function ownerEvents(token, contractId) {
  const r = await rest(token,
    `events?select=id,type,idempotency_key,actor_id&contract_id=eq.${contractId}&order=id`);
  if (r.status !== 200) stop(`owner event read failed (${r.status})`);
  return r.body;
}

// ── The record file (only ever touched under the lock) ──────────────────────

let record = null;

/** Update this run's own file, at the revision this run last wrote. */
async function save(changes) {
  const onDisk = await readCredentialFile(CANCEL_FIXTURE_FILE);
  if (onDisk.run_id !== record.run_id || onDisk.revision !== record.revision) {
    stop('the fixture file changed underneath this run; not overwriting it');
  }
  record = { ...record, ...changes, revision: record.revision + 1, updated_at: new Date().toISOString() };
  await writeCredentialFile(CANCEL_FIXTURE_FILE, record);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function cancel(label, auth, expectedActor, owner) {
  const keyField = `${label}_key`;
  const idField = `${label}_event_id`;
  const outcomeField = `${label}_outcome`;
  const attemptedField = `${label}_attempted_at`;
  if (record[idField]) return;

  // Reconcile first: a request whose outcome was never known may have landed.
  const found = (await ownerEvents(owner.token, record.contract_id))
    .find(e => e.idempotency_key === record[keyField]);
  if (found) {
    if (found.type !== CANCELLED || found.actor_id !== expectedActor) {
      stop(`the ${label} key is held by an event of another type or actor; reconcile by hand`);
    }
    await save({ [idField]: found.id, [outcomeField]: 'recorded', step: idField });
    say(`  ${label} cancellation found and recorded: ${safeId(found.id)}`);
    return;
  }

  if (record[outcomeField] === 'unknown') {
    stop(`the earlier ${label} cancellation's outcome is unknown and no event is visible; `
      + 'this script will not re-send it (see UNKNOWN OUTCOMES)');
  }

  await save({ [outcomeField]: 'unknown', [attemptedField]: new Date().toISOString() });
  let r;
  try {
    r = await invoke('log-event', {
      ...auth,
      body: { type: CANCELLED, contract_id: record.contract_id, idempotency_key: record[keyField] },
    });
  } catch {
    stop(`${label} cancellation request failed; its outcome is unknown, reconcile with --resume`);
  }
  const ok = (r.status === 201 || (r.status === 200 && r.data?.deduplicated === true)) && r.data?.event?.id;
  if (!ok) {
    stop(`${label} cancellation answered ${r.status} ${safeReason(r.reason)}; its outcome is unknown, reconcile with --resume`);
  }
  await save({ [idField]: r.data.event.id, [outcomeField]: 'recorded', step: idField });
  say(`  ${label} cancellation recorded: ${safeId(r.data.event.id)}`);
}

async function finish(owner) {
  const events = await ownerEvents(owner.token, record.contract_id);
  const has = (id, key, actor) => events.some(e =>
    e.id === id && e.type === CANCELLED && e.idempotency_key === key && e.actor_id === actor);
  if (!has(record.owner_event_id, record.owner_key, owner.userId)
    || !has(record.guest_event_id, record.guest_key, GUEST_ACTOR)) {
    stop('the recorded cancellations are not both visible to the owner as expected');
  }
  await save({ status: 'complete', step: 'complete' });
  say(`Fixture complete: contract ${safeId(record.contract_id)}. Keep ${SHOWN_FILE}.`);
}

async function startRecord(owner) {
  const runId = randomUUID();
  record = {
    status: 'pending',
    step: 'started',
    revision: 0,
    run_id: runId,
    project_ref: PROJECT_REF,
    owner_key: `cancel-fixture:owner:${runId}`,
    guest_key: `cancel-fixture:guest:${runId}`,
    created_at: new Date().toISOString(),
  };
  // The guard against a second run's record: link(2) refuses an existing file
  // atomically, and nothing permanent has been written yet.
  try {
    await writeCredentialFile(CANCEL_FIXTURE_FILE, record, { noClobber: true });
  } catch (e) {
    if (e.code === 'EEXIST') stop('a fixture file already exists; it may be the only record of permanent rows');
    if (e.code === 'EPUBLISHED_CLEANUP_FAILED') {
      stop(`the record file was created but a staging copy remains${e.orphan ? ` (${path.relative(REPO_ROOT, e.orphan)})` : ''}. `
        + `Nothing permanent was written: remove that copy and ${SHOWN_FILE}, then run again`);
    }
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
  say(`  contract created: ${safeId(contract.id)}`);

  const accept = await invoke('validate-invite-token', {
    body: { invite_token: contract.invite_token, accept: true, hirer_email: GUEST_EMAIL, counterparty_name: 'Fixture Guest' },
  });
  if (accept.status !== 200 || !accept.data?.guest_access_token) {
    stop(`acceptance answered ${accept.status} ${safeReason(accept.reason)}; the invitation may be consumed`);
  }
  await save({ guest_token_at_record: accept.data.guest_access_token, invite_token: null, step: 'guest_token_at_record' });
  say('  invitation accepted (guest token stored, not shown)');
}

async function loadForResume() {
  try { record = await readCredentialFile(CANCEL_FIXTURE_FILE); } catch {
    stop('no readable fixture file to resume');
  }
  if (record.project_ref !== PROJECT_REF) stop('the fixture file was made for another project');
  if (record.status === 'complete') return false;
  if (!Number.isSafeInteger(record.revision)) stop('the fixture file has no revision; not resuming it');
  if (!record.contract_id) stop('no contract_id recorded: not resumable (see RECOVERY in this file)');
  if (!record.guest_token_at_record) stop('no guest token recorded: not resumable (see RECOVERY in this file)');
  return true;
}

async function main() {
  say(`Target: ${PROJECT_REF} (E2E). Mode: ${mode}.`);

  if (deployedLogEventDigest() !== ACCEPTING_LOG_EVENT_EZBR) {
    stop(`E2E log-event is not the v14 artifact that accepts ${CANCELLED}`);
  }
  say('  log-event: v14 artifact, still accepts the type');

  if (mode === 'check') {
    await cachedOwnerReadOnly();
    say('  owner session (cached, unchanged): the E2E test account');
    say(`  fixture file ${await exists(CANCEL_FIXTURE_FILE) ? 'EXISTS: a record run would refuse' : 'absent'}`);
    say(`  fixture lock ${await exists(CANCEL_FIXTURE_LOCK) ? 'EXISTS: any run would refuse' : 'absent'}`);
    say('Check only: nothing was written.');
    return;
  }

  const release = await acquireFixtureLock(CANCEL_FIXTURE_LOCK, `record-cancel-fixture ${mode}`)
    .catch(e => stop(e?.code === 'ELOCKED' ? e.message : 'could not take the fixture lock'));
  try {
    const owner = await verifiedOwner();
    say('  owner session: the E2E test account');
    if (mode === 'resume') {
      if (!await loadForResume()) { say('Already complete: nothing to do.'); return; }
    } else {
      await startRecord(owner);
    }
    await cancel('owner', { ownerToken: owner.token }, owner.userId, owner);
    await cancel('guest', { guestToken: record.guest_token_at_record }, GUEST_ACTOR, owner);
    await finish(owner);
  } finally {
    await release();
  }
}

try {
  await main();
} catch (error) {
  // Only this script's own fixed messages are printed. Anything unexpected
  // may carry a request, a response or a credential, so it is not.
  console.error(error instanceof Stop
    ? `STOP: ${error.message}`
    : 'STOP: unexpected failure (details not shown, they may carry credentials).');
  console.error(`Nothing further was written. Record file: ${SHOWN_FILE}`);
  process.exitCode = 1;
}
