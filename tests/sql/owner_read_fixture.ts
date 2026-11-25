// Test helper for tests/sql/delegated_owner_read.sh: runs the REAL TypeScript
// writer and reader code, so the owner read is checked against rows and tables
// the product produces rather than against shapes typed twice.
//
//   acceptance  stdin {contract, email} -> the dod.consent_recorded row exactly
//               as validate-invite-token builds it (guest actor, invite bearer
//               assurance, recorded snapshot and its digest)
//   allowlist   -> guestEventView.ts PAYLOAD_ALLOWLIST without its one contact
//               key, the table the SQL statement-key map must equal
//   digest      stdin a JSON value -> sha256 of its stableStringify form, the
//               agreement_hash preimage rule
//
// Local only; reads stdin, writes stdout, no network.
import { ACCEPTANCE_TYPE, buildEventRecord } from '../../supabase/functions/_shared/eventRecord.ts'
import { bearerAssurance } from '../../supabase/functions/_shared/authAssurance.ts'
import { GENESIS_HASH, SNAPSHOT_VERSION, sha256Hex, stableStringify } from '../../supabase/functions/_shared/eventCanonical.ts'
import { PAYLOAD_ALLOWLIST } from '../../supabase/functions/_shared/guestEventView.ts'

const mode = Deno.args[0]
const stdin = async () => JSON.parse(await new Response(Deno.stdin.readable).text())

if (mode === 'acceptance') {
  const input = await stdin()
  const contract = { ...input.contract, hirer_email: input.email }
  const event = await buildEventRecord({
    type: ACCEPTANCE_TYPE,
    agreementSnapshotVersion: SNAPSHOT_VERSION,
    contract,
    actorId: `guest:${input.email}`,
    party: 'guest_hirer',
    assurance: bearerAssurance('invite_token'),
    payload: { counterparty_name: 'Guest Canary', counterparty_email: input.email, dod_items: contract.dod ?? [] },
    prevEventHash: GENESIS_HASH,
    idempotencyKey: `acceptance:${contract.id}`,
    shownTermsCheck: { presented: true, verified: true, version: 1 },
  })
  console.log(JSON.stringify(event))
} else if (mode === 'allowlist') {
  const table = structuredClone(PAYLOAD_ALLOWLIST)
  table['dod.consent_recorded'] = table['dod.consent_recorded'].filter(k => k !== 'counterparty_email')
  console.log(JSON.stringify(table))
} else if (mode === 'digest') {
  console.log(await sha256Hex(stableStringify(await stdin())))
} else {
  throw new Error(`unknown mode ${mode}`)
}
