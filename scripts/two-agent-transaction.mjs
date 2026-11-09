#!/usr/bin/env node
// One real transaction between two independent agent processes.
//
//   npm run sim:two-agents
//
// WHAT THIS ADDS OVER THE EXISTING HARNESSES
// `scripts/api-e2e.mjs` drives both sides as one straight line of assertions.
// `scripts/sim-counterparty.mjs` gives the counterparty a policy instead of a
// script, but still inside one process, where isolation is a closure. Here the
// two sides are two OS processes:
//
//   - no shared memory, no shared module scope, no shared client object;
//   - each side selects and sends its own credential, and the counterparty
//     process is handed none of the owner's. Neither child is given the
//     earner's address or password: the owner exchanges a handed-over key
//     (./lib/ownerKey.mjs), which is the credential a real agent could hold;
//   - the counterparty gets no contract id — only an invite token, handed over
//     on a channel TrustFlow is not part of;
//   - the counterparty computes the mandatory non-JPY shown-terms digest from
//     the published spec at public/agent-protocol.md, importing none of this
//     repo's crypto.
//
// After the handover the two coordinate ONLY through the evidence record: each
// side polls what it is allowed to read and acts when its turn arrives.
//
// WHAT THIS IS NOT: AN AUTHORITY BOUNDARY
// An earlier version of this comment said neither credential is reachable from
// the other process. That is false and Codex's review blocked it. Both children
// run as the same OS user, in the same working directory, with the same
// filesystem rights: the counterparty process could simply read `.env.e2e`, or
// the owner's cached session at `tests/e2e/.earner-session.json`, and act as the
// owner without importing anything. Nothing here prevents that, and blanking
// another environment variable would not either.
//
// So what the split buys is real but narrow: separate process memory, and two
// deliberately separate request credentials, so a step cannot be driven by the
// wrong authority BY ACCIDENT. Real isolation would need a sandbox — separate
// users, containers, or machines — and its own review. Do not cite this harness
// as evidence that a counterparty cannot overreach.
//
// E2E ONLY. Both children import scripts/lib/e2eGuard.mjs, which refuses any
// other project before the first request. The events this writes are
// indistinguishable in the record from real ones, which is the reason for that
// guard and the reason this must never be pointed anywhere else.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL, SUPABASE_KEY } from '../tests/e2e/liveEnv.js';
import { assertE2EProject } from './lib/e2eGuard.mjs';
import { DEFAULT_KEY_FILE } from './lib/ownerKey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ref = assertE2EProject(SUPABASE_URL);

function run(label, file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'agents', file)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const show = (stream, prefix) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) console.log(`${prefix}${line}`);
      });
    };
    show(child.stdout, '');
    show(child.stderr, `[${label}] `);
    child.on('close', code => resolve(code ?? 1));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), 'tf-two-agents-'));
console.log(`\nTwo independent agents — project ${ref}`);
console.log(`handover channel: ${dir}\n`);

// Started together, on purpose. The counterparty begins by waiting for an
// invitation that does not exist yet, which is the real shape of the thing:
// neither side is a step in the other's script.
// Deliberately absent from BOTH children: TF_TEST_EARNER_EMAIL and
// TF_TEST_EARNER_PASSWORD. They inherit this process's environment, so the two
// are cleared rather than merely not mentioned. The owner now authenticates
// from a handed-over key instead, which is the point of this run — neither
// process holds the product's sign-in material.
//
// It stops the credential being HANDED over. It does not stop a child that
// wants it from reading .env.e2e off disk. See "WHAT THIS IS NOT" above.
const noSignInMaterial = { TF_TEST_EARNER_EMAIL: '', TF_TEST_EARNER_PASSWORD: '' };

const [ownerCode, guestCode] = await Promise.all([
  run('owner', 'owner-agent.mjs', {
    ...noSignInMaterial,
    TF_CHANNEL_DIR: dir,
    TF_SUPABASE_URL: SUPABASE_URL,
    TF_SUPABASE_ANON_KEY: SUPABASE_KEY,
    TF_OWNER_KEY_FILE: process.env.TF_OWNER_KEY_FILE ?? DEFAULT_KEY_FILE,
  }),
  run('guest', 'counterparty-agent.mjs', {
    ...noSignInMaterial,
    TF_CHANNEL_DIR: dir,
    TF_SUPABASE_URL: SUPABASE_URL,
    TF_SUPABASE_ANON_KEY: SUPABASE_KEY,
  }),
]);

await rm(dir, { recursive: true, force: true });

const failed = ownerCode !== 0 || guestCode !== 0;
console.log(`\nowner exit ${ownerCode}, counterparty exit ${guestCode}`);
if (failed) {
  console.log('\nSomething broke. The record of whatever did commit is permanent —');
  console.log('read the trail before re-running, and verify the chain:');
  console.log('  node scripts/verify-chain.mjs <contract-id>');
} else {
  console.log('\nVerify the chain independently:');
  console.log('  node scripts/verify-chain.mjs <contract-id printed above>');
}
process.exit(failed ? 1 : 0);
