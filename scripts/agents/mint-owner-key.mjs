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

import { readCredentialFile, writeCredentialFile } from '../lib/credentialFile.mjs';
import { SUPABASE_URL } from '../../tests/e2e/liveEnv.js';
import { assertE2EProject } from '../lib/e2eGuard.mjs';
import { DEFAULT_KEY_FILE } from '../lib/ownerKey.mjs';

const ref = assertE2EProject(SUPABASE_URL);
const SOURCE = process.env.TF_TEST_EARNER_SESSION ?? 'tests/e2e/.earner-session.json';

// Both the read and the write go through ../lib/credentialFile.mjs: the read so
// that a parse error names its reason and never its content (a parse error can
// quote its input, and this input is a session), and the write so the key lands
// as a fresh owner-only file however the previous one was created.
let session;
try {
  session = await readCredentialFile(SOURCE, { onExposed: m => console.warn(`  ${m}`) });
} catch (err) {
  console.error(`cannot read ${SOURCE}: ${err.message}`);
  console.error('Run npm run test:api once to populate it.');
  process.exit(1);
}
if (!session?.refresh_token) {
  console.error(`${SOURCE} carries no refresh_token — run npm run test:api once to populate it.`);
  process.exit(1);
}

await writeCredentialFile(DEFAULT_KEY_FILE, {
  refresh_token: session.refresh_token,
  minted_at: new Date().toISOString(),
  note: 'One opaque credential for an agent. An exchange may return a '
    + 'different token and scripts/lib/ownerKey.mjs persists it; the previous '
    + 'string is not promptly revoked, so treat every copy as live.',
});

console.log(`minted ${DEFAULT_KEY_FILE} for project ${ref}, mode 600`);
// Not even a redacted prefix. `redact()` keeps the first six characters, which
// is fine for a 36-character token and half the secret for a Supabase refresh
// token, which is short — the first run of this script printed six of twelve
// characters to a terminal and a scrollback. Nothing about the value is
// printed now; the file is the only place it exists.
console.log(`  ${session.refresh_token.length} characters, not shown`);
console.log('\nThe agent now needs no address, password, mailbox or CAPTCHA.');
console.log('It is the whole account, not a scoped key — see scripts/lib/ownerKey.mjs.');
