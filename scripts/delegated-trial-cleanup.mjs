#!/usr/bin/env node
// Operator cleanup for the delegated-append live trial, independent of the
// Playwright worker (Codex T213 must-fix 3): for a run that was interrupted,
// whose worker died, or whose afterAll could not finish.
//
//   node scripts/delegated-trial-cleanup.mjs <attempt>
//       revoke the grant and unset ENTRY_DELEGATED_APPEND if that attempt's
//       record (tests/e2e/.delegated-trial/<attempt>.json) says it owns them,
//       confirm the 503, read the gate, check the row budget, record it all.
//
//   node scripts/delegated-trial-cleanup.mjs --grant-id <uuid> [--unset-flag]
//       a run that died before creating its record: the operator names what
//       to undo. The grant must be listed on the fixture deal.
//
// E2E only (scripts/lib/pinnedFetch.mjs, scripts/lib/tfClient.mjs). Prints
// fixed text, status codes and error words; exit 0 only when every step was
// verified.

import { cleanupTrial } from './lib/delegatedTrial.mjs'

const argv = process.argv.slice(2)
const at = flag => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] ?? null : null }
const grantId = at('--grant-id')
const attempt = argv[0] && !argv[0].startsWith('--') ? argv[0] : null
if (!attempt && !grantId) {
  console.error('usage: node scripts/delegated-trial-cleanup.mjs <attempt> | --grant-id <uuid> [--unset-flag]')
  process.exit(2)
}

try {
  const { problems, result } = await cleanupTrial({ attempt, grantId, unsetFlag: argv.includes('--unset-flag') })
  for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`)
  for (const p of problems) console.error(`PROBLEM ${p}`)
  console.log(problems.length ? 'CLEANUP INCOMPLETE' : 'CLEANUP VERIFIED')
  process.exit(problems.length ? 1 : 0)
} catch (e) {
  console.error(e?.constructor?.name === 'TrialError' ? e.message : 'cleanup failed before it could start')
  process.exit(1)
}
