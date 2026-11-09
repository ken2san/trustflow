// What both agent processes need, and deliberately nothing else.
//
// There is no client object here and no credential. Each process supplies its
// own authority on every call, because the point of splitting them across two
// OS processes is that neither can reach the other's. scripts/lib/tfClient.mjs
// holds both credentials in one module scope, which is right for a harness
// asserting refusals on purpose and wrong here.

import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** Poll until `probe` returns something truthy, or give up. */
export async function until(label, probe, { timeoutMs = 90_000, everyMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/**
 * The handover channel, standing in for "whatever channel those two agents
 * already use". A directory, because the rule being exercised is that
 * TrustFlow is not in this path at all — so the channel has to be something
 * TrustFlow knows nothing about.
 */
export function channel(dir) {
  return {
    async put(name, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/${name}`, JSON.stringify(value, null, 2));
    },
    /** Resolves once the other side has left `name` there. */
    get(name, opts) {
      return until(`${name} on the handover channel`, async () => {
        try { return JSON.parse(await readFile(`${dir}/${name}`, 'utf8')); }
        catch { return null; }
      }, opts);
    },
  };
}

/** One step, reported in a form the orchestrator can prefix and a human can read. */
export function reporter(who) {
  let n = 0;
  const failures = [];
  return {
    ok(label, condition, detail = '') {
      n += 1;
      const line = `${condition ? ' ok ' : 'FAIL'} ${who} ${String(n).padStart(2)}. ${label}`;
      console.log(detail ? `${line}  — ${detail}` : line);
      if (!condition) failures.push(label);
      return condition;
    },
    get failures() { return failures; },
  };
}

/**
 * PostgREST, under whichever bearer the caller holds.
 *
 * Here rather than borrowed from scripts/lib/tfClient.mjs because that module
 * imports tests/e2e/liveEnv.js, which THROWS when the earner address and
 * password are absent. A process that is meant to hold only a key must not
 * import a module that refuses to load without a password — otherwise
 * "it holds no password" is a claim about intent rather than about the process.
 */
export async function rest(url, key, bearer, pathAndQuery, init = {}) {
  const r = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

/** A POST to an Edge Function under whichever headers the caller holds. */
export async function fn(url, key, name, { body, bearer = null, guestToken = null }) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${bearer ?? key}`,
    'Content-Type': 'application/json',
  };
  if (guestToken) headers['x-guest-access-token'] = guestToken;
  const r = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return {
    status: r.status,
    data: r.ok ? parsed : null,
    reason: r.ok ? (parsed?.error ?? null) : (parsed?.error ?? `http_${r.status}`),
  };
}
