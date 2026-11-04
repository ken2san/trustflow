// A single verified-Earner session, shared by every suite that needs one.
//
// Five suites run against the live API and each used to open its own session.
// Combined with the anonymous sign-in the app performs on every page load, a
// full run pushed enough traffic at Supabase Auth to start timing out token
// grants — which failed tests that had nothing to do with authentication.
//
// The session is cached on disk and reused until it is close to expiry, so a
// whole run normally costs one grant rather than five. The file holds a live
// access token, so it is gitignored alongside the anonymous fixture.

import { readFile, writeFile, open, rm, stat } from 'node:fs/promises';
import {
  SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL, EARNER_PASSWORD,
} from './liveEnv.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = process.env.TF_TEST_EARNER_SESSION
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.earner-session.json');
const LOCK_FILE = `${CACHE}.lock`;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;

/** Re-grant this far before the token actually expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let inFlight = null;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireSessionLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const lock = await open(LOCK_FILE, 'wx');
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
        return lock;
      } catch (error) {
        await lock.close();
        await rm(LOCK_FILE, { force: true });
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      try {
        let ownerState = 'unknown';
        try {
          const { pid } = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              ownerState = 'alive';
            } catch (ownerError) {
              ownerState = ownerError?.code === 'ESRCH' ? 'dead' : 'alive';
            }
          }
        } catch { /* incomplete lock metadata falls back to its age */ }

        if (ownerState === 'dead') {
          await rm(LOCK_FILE, { force: true });
        } else if (ownerState === 'unknown') {
          const { mtimeMs } = await stat(LOCK_FILE);
          if (Date.now() - mtimeMs > STALE_LOCK_MS) await rm(LOCK_FILE, { force: true });
        }
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Earner session cache lock: ${LOCK_FILE}`);
      }
      await wait(100);
    }
  }
}

function unexpired(session) {
  if (!session?.access_token || !session?.expires_at) return false;
  return session.expires_at * 1000 - Date.now() > REFRESH_MARGIN_MS;
}

/**
 * An unexpired token is not necessarily a live one: signing out revokes the
 * session behind it, and the JWT then fails with session_not_found while still
 * looking valid by its own expiry. Checking costs one request per run and
 * lets a poisoned cache heal itself instead of failing every suite after it.
 */
async function stillLive(request, session, url, key) {
  const response = await request.fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${session.access_token}` },
  });
  return response.status() === 200;
}

/**
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<{ token: string, userId: string, session: object }>}
 */
export async function getEarnerSession(request) {
  // Read through liveEnv rather than from process.env, so that importing this
  // helper is enough to load .env.e2e and to refuse a run with no credentials.
  const [url, key, email, password] = [SUPABASE_URL, SUPABASE_KEY, EARNER_EMAIL, EARNER_PASSWORD];

  inFlight ??= (async () => {
    const lock = await acquireSessionLock();
    try {
      // `inFlight` coordinates only this worker. Re-read after locking because
      // another worker may have populated the shared cache while we waited.
      try {
        const cached = JSON.parse(await readFile(CACHE, 'utf8'));
        if (unexpired(cached) && await stillLive(request, cached, url, key)) return cached;
      } catch { /* no cache, unreadable, or unreachable */ }

      const response = await request.fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        data: { email, password },
      });
      const session = await response.json();
      if (response.status() !== 200) {
        throw new Error(`earner sign-in failed (${response.status()}): ${JSON.stringify(session)}`);
      }
      await writeFile(CACHE, JSON.stringify(session, null, 2));
      return session;
    } finally {
      await lock.close();
      await rm(LOCK_FILE, { force: true });
    }
  })();

  const session = await inFlight;
  return { token: session.access_token, userId: session.user.id, session };
}
