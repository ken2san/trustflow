// One lock for everything that touches the cancellation fixture: the writer
// (scripts/record-cancel-fixture.mjs, record and --resume alike) and the spec
// that replays it (tests/e2e/cancellation-refusal.spec.js).
//
// FAIL CLOSED, INCLUDING ON A STALE LOCK
// An earlier version took over a lock whose PID was dead. Codex showed the
// race (Task 88): two contenders read the same dead PID, the first removes it
// and takes a fresh lock, and the second then removes that LIVE lock and takes
// its own. Two holders, and the fixture's guest token reissued under both.
// Every repair of that — re-reading, comparing inodes, a second lock — is a
// new protocol to get right, for a lock that is taken a few times a month by
// one person. So an existing lock is never removed here, live or not. The
// message says who held it and whether that process still runs; a human
// verifies and deletes it.
//
// MANUAL CLEANUP: ONLY AFTER THE HOLDER HAS FULLY EXITED
// Each acquisition writes a random token, and release unlinks only if the
// file still carries it. That is a best-effort check, not a guarantee: the
// read and the unlink are two steps, so if a lock is deleted by hand and a new
// holder creates one between them, the old holder's release deletes the new
// lock (Codex Task 89). The rule that makes it sound is the operator's: delete
// a lock by hand only after verifying its holder process has exited. A plain
// file lock is enough under that rule; an OS lock would only be needed to
// support removing a lock while its holder still runs, which nothing here does.
//
// Same precondition as credentialFile.mjs: the directory is writable only by
// the owning user. O_EXCL makes creation exclusive; nothing here defends a
// pathname against another principal who can write the directory.

import { randomBytes } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Fixed, not configurable. The writer and the spec must agree on these, and an
// override on one side would put them on two locks (Codex Task 88 asked for the
// override to be validated; removing it is simpler).
export const CANCEL_FIXTURE_FILE = path.join(REPO_ROOT, 'tests/e2e/.cancel-fixture.json');
export const CANCEL_FIXTURE_LOCK = `${CANCEL_FIXTURE_FILE}.lock`;

/** What a lock file records. Nothing secret. */
function lockBody(purpose) {
  return {
    pid: process.pid,
    purpose,
    token: randomBytes(16).toString('hex'),
    created_at: new Date().toISOString(),
  };
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'not running' : 'unknown';
  }
}

/**
 * Take the lock, or throw. Never waits and never removes an existing lock.
 * Returns `release()`, which removes the lock only while it is still ours.
 */
export async function acquireFixtureLock(lockFile, purpose) {
  const body = lockBody(purpose);
  let handle;
  try {
    handle = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // Only fixed text and a validated pid: the lock file's other fields are
    // whatever is on disk, and are not printed (Codex Task 90).
    let pid = null;
    try { pid = JSON.parse(await readFile(lockFile, 'utf8'))?.pid ?? null; } catch { /* unreadable or half-written */ }
    const holder = Number.isSafeInteger(pid) && pid > 0
      ? `process ${pid} (${processState(pid)})`
      : 'an unidentified holder';
    throw Object.assign(new Error(
      `the fixture lock is held by ${holder}; it is never taken over. `
      + 'Delete it by hand only after verifying that process has fully exited and nothing else uses the fixture.',
    ), { code: 'ELOCKED', cause: error });
  }
  try {
    await handle.writeFile(JSON.stringify(body));
  } finally {
    await handle.close();
  }

  let released = false;
  return async function release() {
    if (released) return false;
    released = true;
    let current = null;
    try { current = JSON.parse(await readFile(lockFile, 'utf8')); } catch { return false; }
    if (current?.token !== body.token) return false;
    await unlink(lockFile);
    return true;
  };
}
