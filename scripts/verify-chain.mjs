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
import { classifyStoredEvent, verifyEvidenceSlice } from '../supabase/functions/_shared/eventVerifyV5.ts';
import { acceptedAgreementHashOf } from '../supabase/functions/_shared/guestEventView.ts';
import { ownerSession, rest, PROJECT_REF } from './lib/tfClient.mjs';
import { fetchAllEvents } from './lib/pagedEvents.mjs';

// Explicit, including the v5 authority pair (row 3; verified on E2E, T199).
const EVENT_COLUMNS = [
  'id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at',
  'event_hash', 'prev_event_hash', 'hash_version', 'payload_hash', 'agreement_hash',
  'credential_id', 'issuer_kind',
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

  // Paged and ordered. A read that stopped at its own cap is a prefix, and a
  // prefix is never reported as the chain.
  const { rows, read } = await fetchAllEvents(q => rest(token, q), contractId, EVENT_COLUMNS);
  if (rows.length === 0) {
    console.error('No events. An accepted contract always has at least one.');
    process.exit(1);
  }
  if (!read.tail_complete) {
    console.error(`FAIL: the read stopped at its row cap (${read.row_cap}) after ${read.pages} pages; `
      + 'a capped prefix is not the whole chain, so nothing is reported as verified.');
    process.exit(1);
  }

  // Any v5 (or v5-shaped invalid) row: the whole chain is judged by the strict
  // shared rules, with full payloads. Legacy-only chains keep the checks below.
  if (rows.some(r => ['v5', 'invalid'].includes(classifyStoredEvent(r).kind))) {
    const accepted = await acceptedAgreementHashOf(rows);
    const slice = await verifyEvidenceSlice(rows, {
      // Complete read (checked above): no acceptance act means pre-acceptance.
      startsAtChainStart: true, tailComplete: true,
      acceptance: rows.some(r => r.type === 'dod.consent_recorded') ? 'unknown' : 'none',
      // The validated accepted digest is the baseline for every act, v1–v4
      // included; today's terms are a separate drift check (Codex T174). The
      // legacy-only branch below keeps its current-terms comparison.
      acceptedAgreementHash: accepted.hash, legacyAgreementHash: accepted.hash,
    });
    const acceptanceUnproven = rows.some(r => r.type === 'dod.consent_recorded') && accepted.status !== 'ok';
    if (acceptanceUnproven) {
      console.log(`FAIL an acceptance act is present but its accepted agreement does not validate (${accepted.status})`);
    }
    for (const r of slice.rows) {
      const bad = [r.hash, r.link, r.payload, r.agreement]
        .some(v => ['mismatch', 'broken', 'invalid', 'invalid_input'].includes(v));
      console.log(`${bad ? 'FAIL' : ' ok '} [${r.index}] ${r.kind} v${r.version ?? '?'} `
        + `hash=${r.hash} link=${r.link} payload=${r.payload} agreement=${r.agreement}`
        + `${r.reason ? `  (${r.reason})` : ''}`);
    }
    console.log(`\naccepted agreement: ${accepted.status}${accepted.hash ? ` ${accepted.hash.slice(0, 16)}…` : ''}`);
    console.log(`dimensions: ${JSON.stringify(slice.dimensions)}  acceptance: ${slice.acceptance.status}`);
    if (accepted.hash) {
      console.log(accepted.hash === await deriveAgreementHash(contract)
        ? 'current terms match the accepted agreement'
        : 'current terms differ from the accepted agreement (drift since acceptance; not a failure of the record)');
    }
    if (slice.overall !== 'verified' || acceptanceUnproven) {
      console.log(`\nCHAIN NOT VERIFIED — strict result: ${slice.overall}`);
      process.exit(1);
    }
    console.log('\nCHAIN VERIFIED — recomputed independently of the app (strict v5 rules).');
    return;
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
    + `${contract.currency} ${contract.amount_minor ?? contract.amount_jpy}, deadline ${contract.deadline ?? '(none)'}, `
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
