// A persistent anonymous test identity shared by live-API suites.
//
// Anonymous sign-ins are capped per IP. Keep one refresh token on disk so
// security regressions test an anonymous JWT without burning the signup budget.

import { readFile, writeFile, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { SUPABASE_URL, SUPABASE_KEY } from './liveEnv.js';
import { assertE2EProject } from '../../scripts/lib/e2eGuard.mjs';

const ANON_FIXTURE = process.env.TF_TEST_ANON_FIXTURE
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.anon-fixture.json');
const LOCK_FILE = `${ANON_FIXTURE}.lock`;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;

// API-only specs do not necessarily execute 00-backend-guard.spec.js. Refuse
// before the first auth request when this shared fixture is used on production.
assertE2EProject(SUPABASE_URL);

let anonSessionPromise = null;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireFixtureLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(LOCK_FILE, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      // A cancelled test can leave its lock behind. Do not let it block every
      // later suite; a live refresh normally completes in well under a minute.
      try {
        const { mtimeMs } = await stat(LOCK_FILE);
        if (Date.now() - mtimeMs > STALE_LOCK_MS) await rm(LOCK_FILE, { force: true });
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for anonymous fixture lock: ${LOCK_FILE}`);
      }
      await wait(100);
    }
  }
}

async function api(request, path, body) {
  const response = await request.fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    data: body,
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status(), body: parsed };
}

export async function getAnonymousSession(request) {
  anonSessionPromise ??= (async () => {
    const lock = await acquireFixtureLock();
    try {
      let stored = null;
      try {
        stored = JSON.parse(await readFile(ANON_FIXTURE, 'utf8'));
      } catch { /* no fixture yet */ }

      if (stored?.refresh_token) {
        const refreshed = await api(request, '/auth/v1/token?grant_type=refresh_token', {
          refresh_token: stored.refresh_token,
        });
        if (refreshed.status === 200) {
          await writeFile(ANON_FIXTURE, JSON.stringify({ refresh_token: refreshed.body.refresh_token }, null, 2));
          expect(refreshed.body.user.is_anonymous, 'fixture identity is no longer anonymous').toBe(true);
          return { accessToken: refreshed.body.access_token, userId: refreshed.body.user.id };
        }
      }

      const { status, body } = await api(request, '/auth/v1/signup', {});
      expect(status,
        `could not establish an anonymous identity. 429 means the 30/hr per-IP signup cap is `
        + `exhausted and no reusable fixture exists at ${ANON_FIXTURE} — wait for the window to `
        + `reset and re-run once to create it. Response: ${JSON.stringify(body)}`).toBe(200);
      expect(body.user.is_anonymous).toBe(true);
      await writeFile(ANON_FIXTURE, JSON.stringify({ refresh_token: body.refresh_token }, null, 2));
      return { accessToken: body.access_token, userId: body.user.id };
    } finally {
      await lock.close();
      await rm(LOCK_FILE, { force: true });
    }
  })();
  return anonSessionPromise;
}
