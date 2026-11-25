// Test helper for tests/sql/delegated_owner_read_receipt.sh: the REAL writer
// and the REAL Edge shaping module, so the receipt the route would emit is the
// one handed to scripts/verify-receipt.mjs.
//
//   trail  stdin {contract, ownerId, notes: string[]} -> owner rows exactly as
//          log-event's account-session path builds them, chained from genesis,
//          one per note, each a distinct millisecond
//   shape  stdin a read_delegated_owner_deal `ok` result -> the 200 envelope
//          (shapeOwnerRead), compact JSON, as the route serializes it
//
// Local only; reads stdin, writes stdout, no network.
import { buildEventRecord } from '../../supabase/functions/_shared/eventRecord.ts'
import { assuranceFromClaims } from '../../supabase/functions/_shared/authAssurance.ts'
import { GENESIS_HASH, SNAPSHOT_VERSION } from '../../supabase/functions/_shared/eventCanonical.ts'
import { shapeOwnerRead } from '../../supabase/functions/_shared/ownerReadResponse.ts'

const mode = Deno.args[0]
const input = JSON.parse(await new Response(Deno.stdin.readable).text())

if (mode === 'trail') {
  const rows = []
  let prev = GENESIS_HASH
  for (const note of input.notes as string[]) {
    // A distinct created_at per row, so (created_at, id) order is chain order.
    await new Promise(r => setTimeout(r, 2))
    const now = Math.floor(Date.now() / 1000)
    const row = await buildEventRecord({
      type: 'payment.reported',
      agreementSnapshotVersion: SNAPSHOT_VERSION,
      contract: input.contract,
      actorId: input.ownerId,
      party: 'earner',
      assurance: assuranceFromClaims({ aal: 'aal1', is_anonymous: false, amr: [{ method: 'otp', timestamp: now }] }),
      payload: { note },
      prevEventHash: prev,
    })
    prev = row.event_hash as string
    rows.push(row)
  }
  console.log(JSON.stringify(rows))
} else if (mode === 'shape') {
  console.log(JSON.stringify(await shapeOwnerRead(input)))
} else {
  throw new Error(`unknown mode ${mode}`)
}
