#!/usr/bin/env node
// Re-verify one agreement's evidence chain from the raw rows, outside the app.
//
//   node scripts/verify-chain.mjs <contract-id>
//
// WHY THIS EXISTS AS A SCRIPT
// The exported record says `integrity_status: VERIFIED`. That is the product
// marking its own homework, and a reader who is being asked to rely on the
// record is exactly the reader who should not accept it. On 2026-10-11 the
// whole chain was recomputed by hand to settle that — twice. This is that
// check, repeatable: it reads the stored rows, recomputes every hash through
// the same _shared/eventCanonical.ts the writer used, and compares.
//
// It is deliberately NOT a test of the app. It never calls the app's verifier,
// never reads `integrity_status`, and would still work against a database dump
// with no TrustFlow running at all. The one production bug this chain has ever
// had was two implementations of the canonical drifting apart, so sharing the
// canonical is the point: one definition, and a verifier that fails loudly if
// a writer ever stops matching it.
//
// What it proves: the rows are internally consistent and unbroken, and every
// event is bound to the same agreement terms. What it cannot prove: that any
// assertion in them is true. TrustFlow attests that a party said something.

import {
  GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
  payloadHash, deriveDodHash, deriveAgreementHash, sha256Hex,
} from '../supabase/functions/_shared/eventCanonical.ts';
import { ownerSession, rest, PROJECT_REF } from './lib/tfClient.mjs';

const EVENT_COLUMNS = [
  'id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at',
  'event_hash', 'prev_event_hash', 'hash_version', 'payload_hash', 'agreement_hash',
].join(',');

/**
 * Every check for one row, named. Returning them rather than printing keeps
 * the counting honest: a check that is skipped must say so, because "30 checks
 * passed" means nothing if the failing one silently was not among them.
 */
export async function checksFor(row, index, prevHash, expectedAgreementHash) {
  const version = canonicalVersionOf(row);
  const out = [];

  const recomputed = await sha256Hex(eventCanonical(row, version));
  out.push(['event_hash', row.event_hash === recomputed,
    `stored ${row.event_hash?.slice(0, 12)} vs recomputed ${recomputed.slice(0, 12)}`]);

  const expectedPrev = index === 0 ? GENESIS_HASH : prevHash;
  const actualPrev = row.prev_event_hash ?? GENESIS_HASH;
  out.push(['chain_link', actualPrev === expectedPrev,
    `points at ${actualPrev?.slice(0, 12)}, predecessor is ${expectedPrev?.slice(0, 12)}`]);

  if (version >= 3) {
    const ph = await payloadHash(row.payload ?? {});
    out.push(['payload_hash', row.payload_hash === ph,
      `stored ${row.payload_hash?.slice(0, 12)} vs recomputed ${ph.slice(0, 12)}`]);
  }

  if (bindsWholeAgreement(version)) {
    // Every v4 event must cite the SAME agreement. One row citing a different
    // snapshot is how a changed price would show up, and it is the check the
    // whole v4 canonical exists for.
    out.push(['agreement_hash', row.agreement_hash === expectedAgreementHash,
      `cites ${row.agreement_hash?.slice(0, 12)}, agreement is ${expectedAgreementHash?.slice(0, 12)}`]);
  }

  return { version, checks: out };
}

async function main() {
  const contractId = process.argv[2];
  if (!contractId) {
    console.error('usage: node scripts/verify-chain.mjs <contract-id>');
    process.exit(2);
  }

  const { token } = await ownerSession();
  console.log(`project ${PROJECT_REF}  contract ${contractId}\n`);

  const c = await rest(token, `contracts?id=eq.${encodeURIComponent(contractId)}&select=*`);
  const contract = Array.isArray(c.body) ? c.body[0] : null;
  if (!contract) {
    // RLS makes "not yours" and "not there" the same answer on purpose.
    console.error(`No contract readable at that id (HTTP ${c.status}).`);
    process.exit(1);
  }

  const e = await rest(token,
    `events?contract_id=eq.${encodeURIComponent(contractId)}`
    + `&select=${EVENT_COLUMNS}&order=created_at.asc,id.asc`);
  const rows = Array.isArray(e.body) ? e.body : [];
  if (rows.length === 0) {
    console.error('No events. An accepted contract always has at least one.');
    process.exit(1);
  }

  // Derived from the contract row, not read from any event: an expected value
  // taken from the thing being checked proves nothing.
  const expectedAgreementHash = await deriveAgreementHash(contract);
  const expectedDodHash = await deriveDodHash(contract.dod);

  let passed = 0;
  const failures = [];
  let prevHash = GENESIS_HASH;

  for (const [i, row] of rows.entries()) {
    const { version, checks } = await checksFor(row, i, prevHash, expectedAgreementHash);
    const bad = checks.filter(([, ok]) => !ok);
    passed += checks.length - bad.length;
    for (const [name, , detail] of bad) failures.push(`${i} ${row.type} — ${name}: ${detail}`);

    console.log(
      `${bad.length ? 'FAIL' : ' ok '} [${i}] v${version} ${row.type.padEnd(24)} `
      + `${row.created_at}  ${checks.length} checks`);
    prevHash = row.event_hash;
  }

  // The terms the events cite must still be the terms on the contract.
  const dodMatch = rows.every(r => r.dod_hash === null || r.dod_hash === expectedDodHash);
  if (dodMatch) passed += 1;
  else failures.push(`dod_hash: an event cites terms that are not this contract's`);

  console.log();
  console.log(`agreement_hash ${expectedAgreementHash.slice(0, 16)}… over `
    + `${contract.currency} ${contract.amount_jpy}, deadline ${contract.deadline ?? '(none)'}, `
    + `performed_by ${contract.performed_by}`);
  console.log(`${rows.length} events, ${passed} checks passed, ${failures.length} failed`);

  if (failures.length) {
    console.log('\nFAILURES');
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('\nCHAIN VERIFIED — recomputed independently of the app.');
}

// Importable so the checks can be proved to fail on tampered input. A test
// for a failure path that has never once gone red is not yet a test — this
// chain's own unit test passed for two weeks while the real path was broken.
if (import.meta.main) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
