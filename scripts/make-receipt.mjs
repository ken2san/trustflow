#!/usr/bin/env node
// A portable evidence receipt for one agreement.
//
//   npm run receipt -- <contract-id> [--out receipt.json]
//
// WHAT A RECEIPT IS FOR
// Something a party keeps, outside TrustFlow, that another person can check
// without trusting TrustFlow and without TrustFlow being reachable. So it
// carries the agreement, the acts, and every digest needed to recompute the
// chain — and `scripts/verify-chain.mjs` can be run against the same contract
// to confirm it independently.
//
// THE LIMIT, WHICH IS INSIDE THE FILE AND NOT IN A README
// A receipt verifies that the log is internally consistent and that every act
// is bound to the same agreement terms. It does NOT verify that the text of a
// statement matches what was committed to, because the event hash (v3 and
// later) commits to a single `payload_hash` over the whole payload: disclosing
// one field would mean disclosing the preimage of all of them, so the parties
// are shown an allowlisted projection instead and cannot reproduce that digest
// from it — measured, 0 of 4 events.
//
// That gap is real, is not closed by this script, and is therefore stated in
// the emitted JSON under `not_verifiable_here`. Closing it needs per-claim
// salted commitments: a separate, undecided commitment format. It is NOT the
// event-hash v5 of row 3 (`hash_version` 5, which binds the credential id and
// issuer kind; docs/v5-preimage-review.md) and does not use that number.
// Writing a receipt that implied otherwise would be the exact failure this
// product is supposed to be against.
//
// Owner-side only for now: the guest's endpoint does not yet return the three
// digests their half would need. No deploy is implied by this file.

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deriveAgreementHash } from '../supabase/functions/_shared/eventCanonical.ts';
import { verifyEvidenceSlice } from '../supabase/functions/_shared/eventVerifyV5.ts';
import { ownerSession, rest, PROJECT_REF, SUPABASE_URL } from './lib/tfClient.mjs';
import { fetchAllEvents } from './lib/pagedEvents.mjs';
import { buildReceiptV2 } from './lib/receiptV2.mjs';

// Explicit, including the v5 authority pair (row 3; the additive columns are
// verified on E2E, T199). tfClient refuses any project but E2E.
const COLUMNS = [
  'id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at',
  'event_hash', 'prev_event_hash', 'hash_version', 'payload_hash',
  'agreement_hash', 'idempotency_key', 'tsa_token', 'credential_id', 'issuer_kind',
].join(',');

async function main() {
  const contractId = process.argv[2];
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;
  if (!contractId) {
    console.error('usage: node scripts/make-receipt.mjs <contract-id> [--out receipt.json]');
    process.exit(2);
  }

  const { token } = await ownerSession();
  const contract = (await rest(token, `contracts?id=eq.${encodeURIComponent(contractId)}&select=*`)).body?.[0];
  if (!contract) { console.error('No contract readable at that id.'); process.exit(1); }

  // Paged and ordered; a capped read is recorded as such in `read`.
  const { rows, read } = await fetchAllEvents(q => rest(token, q), contractId, COLUMNS);
  if (!rows.length) { console.error('No events.'); process.exit(1); }

  const receipt = await buildReceiptV2({
    contract, rows, read,
    source: { project_ref: PROJECT_REF, api: SUPABASE_URL, issued_for_role: 'owner' },
  });

  // The issuer's own recomputation over the FULL rows (payloads included)
  // decides only the exit code and is not written into the artifact.
  const slice = await verifyEvidenceSlice(rows, {
    startsAtChainStart: read.start === 'first_event',
    tailComplete: read.tail_complete,
    // A whole, complete read with no acceptance act is provably pre-acceptance.
    acceptance: read.start === 'first_event' && read.tail_complete
      && !rows.some(r => r.type === 'dod.consent_recorded') ? 'none' : 'unknown',
    acceptedAgreementHash: receipt.agreement.accepted?.agreement_hash ?? null,
    legacyAgreementHash: await deriveAgreementHash(contract),
  });
  const chainIntact = slice.overall === 'verified';
  const acts = receipt.acts;

  // A receipt carries the agreement terms, both parties' roles and an address
  // in the acceptance act, so it is not stdout material. Writing to a file is
  // the default, 0600, and never over something that already exists.
  const json = JSON.stringify(receipt, null, 2);
  const target = outPath ?? `receipt-${contract.id.slice(0, 8)}.json`;

  if (process.argv.includes('--stdout')) {
    console.log(json);
  } else {
    if (existsSync(target)) {
      console.error(`Refusing to overwrite ${target}. Pass --out <path> with a new name.`);
      process.exit(2);
    }
    await writeFile(target, json, { mode: 0o600, flag: 'wx' });
    console.log(`receipt written to ${target} (mode 0600)`);
  }

  console.log(`${acts.length} acts, ${receipt.not_verifiable_here.length} stated limits`);
  console.log(`\nVerify it offline, without trusting this file:\n  node scripts/verify-receipt.mjs ${target}`);
  // The issuer's own recomputation decides only the exit code, and is not
  // written into the artifact.
  process.exit(chainIntact ? 0 : 1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
