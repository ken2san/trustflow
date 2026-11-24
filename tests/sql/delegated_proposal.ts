// Test helper for tests/sql/delegated_append*.sh: runs the REAL TypeScript
// builders and readers against rows the local database produced, so the SQL
// suites prove TS/SQL parity on actual data rather than on fixtures typed twice.
//
//   build    stdin {contract, tip, credentialId, type, payload, key, acceptedVersion}
//            -> {performed_by, hashed_inputs, event}: exactly what log-event sends
//   verify   stdin a stored events row as JSON -> "<v5 verdict>|<payload hash ok>"
//   receipt  stdin {contract, rows} -> the last act of buildReceiptV2, plus the
//            v5 verdict of its strict canonical block
//
// Local only; reads stdin, writes stdout, no network.
import { buildDelegatedEventV5, finalRecordedTree } from '../../supabase/functions/_shared/delegatedEvent.ts'
import { verifyEventHashV5 } from '../../supabase/functions/_shared/eventCanonicalV5.ts'
import { payloadHash } from '../../supabase/functions/_shared/eventCanonical.ts'
import { buildReceiptV2 } from '../../scripts/lib/receiptV2.mjs'

const input = JSON.parse(await new Response(Deno.stdin.readable).text())
const mode = Deno.args[0]

if (mode === 'build') {
  const performedBy = input.contract.performed_by === 'counterparty' ? 'counterparty' : 'creator'
  const tree = finalRecordedTree(input.payload ?? {}, performedBy)
  if (!tree) throw new Error('payload outside the delegated domain')
  const p = await buildDelegatedEventV5({
    type: input.type,
    contract: input.contract,
    ownerId: String(input.contract.earner_user_id),
    credentialId: input.credentialId,
    issuerKind: 'owner_account',
    tree,
    prevEventHash: input.tip ?? null,
    idempotencyKey: input.key ?? null,
    acceptedVersion: input.acceptedVersion ?? null,
  })
  console.log(JSON.stringify({ performed_by: p.performedBy, hashed_inputs: p.hashedInputs, event: p.event }))
} else if (mode === 'verify') {
  const v = await verifyEventHashV5(input, input.event_hash)
  console.log(`${v.verdict}|${(await payloadHash(input.payload)) === input.payload_hash}`)
} else if (mode === 'receipt') {
  const receipt = await buildReceiptV2({
    contract: input.contract, rows: input.rows, read: { complete: true }, source: 'local-test',
  })
  const act = receipt.acts[receipt.acts.length - 1]
  const v = await verifyEventHashV5({ ...act.canonical }, act.event_hash)
  console.log(JSON.stringify({ act, canonical_verdict: v.verdict }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
