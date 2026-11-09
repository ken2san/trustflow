#!/usr/bin/env node
// Turn a session a human already signed in to into the one string an agent
// needs. Run once, by a human; after that the agent holds only the key.
//
//   node scripts/agents/mint-owner-key.mjs
//
// It reads the refresh token out of the harness session cache and writes it,
// alone, to tests/e2e/.owner-api-key.json. Nothing else is copied: not the
// access token, not the user row, not the address.
//
// This stands in for the real onboarding, which is a human completing the OTP
// and CAPTCHA once in a browser and then handing the token over. The harness
// cache happens to be where this machine already has one.
//
// E2E ONLY, like everything in this directory.

import { readFile, writeFile } from 'node:fs/promises';
import { SUPABASE_URL } from '../../tests/e2e/liveEnv.js';
import { assertE2EProject } from '../lib/e2eGuard.mjs';
import { DEFAULT_KEY_FILE } from '../lib/ownerKey.mjs';

const ref = assertE2EProject(SUPABASE_URL);
const SOURCE = process.env.TF_TEST_EARNER_SESSION ?? 'tests/e2e/.earner-session.json';

// Parsed inside a try, because a JSON parse error can quote its input and the
// input here may be a credential — Codex's finding 4: point TF_TEST_EARNER_SESSION
// at a file holding a bare token and the unhandled exception prints part of it.
let session;
try {
  session = JSON.parse(await readFile(SOURCE, 'utf8'));
} catch (err) {
  console.error(`cannot read ${SOURCE} as JSON (${err.code ?? err.name ?? 'parse error'}).`);
  console.error('Not printing it: that file holds a session.');
  process.exit(1);
}
if (!session?.refresh_token) {
  console.error(`${SOURCE} carries no refresh_token — run npm run test:api once to populate it.`);
  process.exit(1);
}

// 0600 at creation, not afterwards. Under the usual umask 022 a plain write
// lands as 0644, which is the account's whole authority readable by group and
// other; a chmod after the fact leaves a window. Codex's P1.
await writeFile(DEFAULT_KEY_FILE, JSON.stringify({
  refresh_token: session.refresh_token,
  minted_at: new Date().toISOString(),
  note: 'One opaque credential for an agent. A new one is returned on every '
    + 'exchange and scripts/lib/ownerKey.mjs persists it; the previous string '
    + 'is not promptly revoked, so treat every copy as live.',
}, null, 2), { mode: 0o600 });

console.log(`minted ${DEFAULT_KEY_FILE} for project ${ref}, mode 600`);
// Not even a redacted prefix. `redact()` keeps the first six characters, which
// is fine for a 36-character token and half the secret for a Supabase refresh
// token, which is short — the first run of this script printed six of twelve
// characters to a terminal and a scrollback. Nothing about the value is
// printed now; the file is the only place it exists.
console.log(`  ${session.refresh_token.length} characters, not shown`);
console.log('\nThe agent now needs no address, password, mailbox or CAPTCHA.');
console.log('It is the whole account, not a scoped key — see scripts/lib/ownerKey.mjs.');
