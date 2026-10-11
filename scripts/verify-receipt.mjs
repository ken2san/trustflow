#!/usr/bin/env node
// Verify an evidence receipt offline, trusting neither TrustFlow nor the file.
//
//   node scripts/verify-receipt.mjs <receipt.json>
//
// No network. No database. No credentials. It reads the canonical inputs the
// receipt carries, recomputes every digest through
// supabase/functions/_shared/eventCanonical.ts, and compares. If the receipt
// and this program disagree, the program is right — which is the entire reason
// a receipt must not contain its own verdict.
//
// WHAT IT PROVES
//   Each act's event_hash follows from the canonical inputs beside it.
//   Each act links to its predecessor, with no gap or reordering.
//   Every act cites the same agreement_hash.
//   That agreement_hash follows from the agreement snapshot in the file.
//
// WHAT IT CANNOT PROVE, and no amount of hashing will
//   That a statement's text matches what was committed to. v4 commits to one
//   payload_hash over a whole payload, so the preimage is not disclosable
//   field by field and is therefore not in the receipt at all.
//   That the operator did not issue a different, equally consistent history to
//   the other party. Two receipts, one per party, compared — that is the only
//   check for it, and it is why `--compare` exists.
//   Anything about identity, performance, payment, or intent.

import { readFile } from 'node:fs/promises';
import {
  GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
  deriveAgreementHash, sha256Hex, stableStringify,
} from '../supabase/functions/_shared/eventCanonical.ts';

const REQUIRED_CANONICAL = [
  'id', 'type', 'contract_id', 'actor_id', 'dod_hash', 'created_at',
  'prev_event_hash', 'payload_hash', 'agreement_hash', 'hash_version',
];

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? ' ok ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  return cond;
};

async function verify(receipt) {
  ok(receipt?.receipt_version === 1, 'receipt_version is 1', String(receipt?.receipt_version));

  const snapshot = receipt?.agreement?.snapshot;
  const claimed = receipt?.agreement?.agreement_hash;
  if (!snapshot || !claimed) {
    ok(false, 'the receipt carries an agreement snapshot and its hash');
    return;
  }

  // The snapshot is hashed as-is. deriveAgreementHash builds a snapshot from a
  // contract row, so here the stored snapshot is hashed directly — the same
  // bytes, without reconstructing a row the receipt does not contain.
  const recomputedAgreement = await sha256Hex(stableStringify(snapshot));
  ok(recomputedAgreement === claimed, 'agreement_hash follows from the snapshot in this file',
    `${recomputedAgreement.slice(0, 12)} vs ${String(claimed).slice(0, 12)}`);

  const acts = Array.isArray(receipt.acts) ? receipt.acts : [];
  ok(acts.length > 0, 'the receipt contains acts', `${acts.length}`);

  let prev = GENESIS_HASH;
  for (const [i, act] of acts.entries()) {
    const c = act?.canonical;
    const label = `[${i}] ${act?.act ?? act?.canonical?.type ?? '?'}`;

    // Without every input there is nothing to recompute, and a receipt that
    // merely restates a digest is not evidence. This is the check the first
    // version of make-receipt.mjs would have failed.
    const missing = !c ? REQUIRED_CANONICAL : REQUIRED_CANONICAL.filter(k => !(k in c));
    if (!ok(missing.length === 0, `${label} carries every canonical input`,
      missing.length ? `missing: ${missing.join(', ')}` : '')) continue;

    const version = canonicalVersionOf(c);
    const recomputed = await sha256Hex(eventCanonical(c, version));
    ok(recomputed === act.event_hash, `${label} event_hash recomputes`,
      `${recomputed.slice(0, 12)} vs ${String(act.event_hash).slice(0, 12)}`);

    const expectedPrev = i === 0 ? GENESIS_HASH : prev;
    ok((c.prev_event_hash ?? GENESIS_HASH) === expectedPrev, `${label} links to its predecessor`,
      `${String(c.prev_event_hash ?? GENESIS_HASH).slice(0, 12)} vs ${String(expectedPrev).slice(0, 12)}`);

    if (bindsWholeAgreement(version)) {
      ok(c.agreement_hash === claimed, `${label} cites this agreement`,
        `${String(c.agreement_hash).slice(0, 12)} vs ${String(claimed).slice(0, 12)}`);
    }
    prev = act.event_hash;
  }

  const limits = Array.isArray(receipt.not_verifiable_here) ? receipt.not_verifiable_here : [];
  ok(limits.length > 0, 'the receipt states its own limits rather than implying none',
    `${limits.length} stated`);
  // A receipt must not assert that it verified itself.
  ok(!('verified_here' in receipt), 'the receipt contains no self-assessed verdict');
}

/** Two parties' receipts for one agreement must agree, or the operator equivocated. */
async function compare(a, b) {
  console.log('\n--- comparing two receipts for the same agreement ---');
  ok(a.agreement?.agreement_hash === b.agreement?.agreement_hash,
    'both receipts describe the same agreement');
  const chain = (r) => (r.acts ?? []).map(x => x.event_hash).join(',');
  ok(chain(a) === chain(b), 'both parties were shown the same acts, in the same order',
    `${(a.acts ?? []).length} vs ${(b.acts ?? []).length}`);
}

async function main() {
  const files = process.argv.slice(2).filter(x => !x.startsWith('--'));
  if (!files.length) {
    console.error('usage: node scripts/verify-receipt.mjs <receipt.json> [other.json]');
    process.exit(2);
  }

  const receipts = [];
  for (const f of files) {
    console.log(`\n${f}`);
    const r = JSON.parse(await readFile(f, 'utf8'));
    receipts.push(r);
    await verify(r);
  }
  if (receipts.length === 2) await compare(receipts[0], receipts[1]);

  console.log(`\n${failures} failed check${failures === 1 ? '' : 's'}`);
  if (failures === 0) {
    console.log('RECEIPT VERIFIED — recomputed offline, from this file alone.');
    console.log('This says nothing about identity, performance, payment, intent,');
    console.log('the text behind any payload_hash, or whether the operator showed');
    console.log('the other party a different history.');
  }
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
