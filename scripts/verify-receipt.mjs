#!/usr/bin/env node
// Verify an evidence receipt offline, trusting neither TrustFlow nor the file.
//
//   node scripts/verify-receipt.mjs <receipt.json>
//
// Needs Node 22.18 or newer (or 22.6+/23.x with --experimental-strip-types),
// because it loads the server's own canonical definition rather than a copy.
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

// WHY THE CANONICAL DEFINITION IS LOADED, NOT COPIED, AND LOADED LATE
//   It is a TypeScript file because the Edge Functions that write events import
//   the same file: one definition of what a hash covers, with no second copy
//   that can drift. Node imports a `.ts` path only on a runtime that strips
//   types — 22.18 or newer, or 22.6+/23.x behind --experimental-strip-types.
//   A static import would therefore fail before any line of this program ran,
//   with a message about an unknown file extension and no mention of Node. This
//   is the one program a third party is asked to run, so it has to say so
//   itself rather than leave them with that.
const CANONICAL_URL = new URL(
  '../supabase/functions/_shared/eventCanonical.ts', import.meta.url);

let GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
  sha256Hex, stableStringify;
// Strict v5 rules (row 3), loaded the same way and for the same reason.
let classifyStoredEvent, verifyEvidenceSlice, fromV5Transport, acceptedAgreementOf;

/** Resolve the one definition of the hash, or say exactly what is needed. */
async function loadCanonicalDefinition() {
  try {
    ({
      GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
      sha256Hex, stableStringify,
    } = await import(CANONICAL_URL.href));
    ({ classifyStoredEvent, verifyEvidenceSlice, fromV5Transport } = await import(
      new URL('../supabase/functions/_shared/eventVerifyV5.ts', import.meta.url).href));
    ({ acceptedAgreementOf } = await import(
      new URL('../supabase/functions/_shared/guestEventView.ts', import.meta.url).href));
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw e;
    const v = process.versions.node;
    const [maj, min] = v.split('.').map(Number);
    const flagWouldWork = (maj === 22 && min >= 6) || maj === 23;
    console.error([
      `This verifier needs Node 22.18 or newer. This is Node ${v}.`,
      '',
      'It recomputes every digest through the same file the server hashes with',
      '— supabase/functions/_shared/eventCanonical.ts — so a receipt is checked',
      'against the real definition and not against a copy of it that could have',
      'drifted. Loading that file needs a Node that strips types.',
      '',
      flagWouldWork
        ? `On this version the flag is enough:\n  node --experimental-strip-types ${process.argv[1]} <receipt.json>`
        : 'Install Node 22.18 or newer (24 is fine), then run this again.',
    ].join('\n'));
    process.exit(2);
  }
}

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

const REQUIRED_CANONICAL_V5 = [...REQUIRED_CANONICAL, 'credential_id', 'issuer_kind'];
// Set by verifyV2 for a valid draft: the success headline must say it covers a
// pre-acceptance chain only, with the agreement status stated.
let preAcceptanceOnly = null;

async function verify(receipt) {
  if (receipt?.receipt_version === 2) return verifyV2(receipt);
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

    // A v1 receipt has no room for the authority pair and verifies under legacy
    // rules, so a v5 act (or one carrying v5 authority values) cannot be
    // verified inside it — it fails rather than being checked as legacy.
    if (c && typeof c === 'object') {
      const kind = classifyStoredEvent(c).kind;
      if (kind === 'v5' || kind === 'invalid') {
        ok(false, `${label} is not a legacy act`, 'a v5 act, or v5 authority values, in a v1 receipt');
        continue;
      }
    }

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

// Receipt v2 `canonical_withheld` (docs/v5-receipt-format.md): the one
// omission a reader may declare, on the one surface that makes it. The
// delegated owner read withholds a legacy guest actor (`guest:<address>`)
// under the no-contact rule. A declaration only turns that act's hash check
// into "unavailable"; it never satisfies any check, and anything else about it
// is a failure.
const WITHHELD_SOURCE_API = 'delegated-owner-read';
const WITHHOLDABLE = new Set(['actor_id']);

/** null when the declaration is the supported omission, else why it is not. */
function withheldDeclarationProblem(receipt, kind, declared, missing) {
  if (receipt?.source?.api !== WITHHELD_SOURCE_API) return 'only the delegated owner read may declare a withheld input';
  if (!Array.isArray(declared) || declared.length === 0 || !declared.every(k => typeof k === 'string')) {
    return 'not a non-empty list of input names';
  }
  if (new Set(declared).size !== declared.length) return 'duplicate entries';
  const unknown = declared.filter(k => !WITHHOLDABLE.has(k));
  if (unknown.length) return `not a withholdable input: ${unknown.join(', ')}`;
  if (kind !== 'legacy') return `only a legacy act may withhold an input (this act is ${kind})`;
  const present = declared.filter(k => !missing.includes(k));
  if (present.length) return `declared but present: ${present.join(', ')}`;
  const undeclared = missing.filter(k => !declared.includes(k));
  if (undeclared.length) return `absent but undeclared: ${undeclared.join(', ')}`;
  return null;
}

/**
 * Receipt v2 (docs/v5-receipt-format.md). Classify first, require each act's
 * own canonical inputs, prove the accepted agreement from its snapshot and the
 * acceptance act, then judge the whole slice with the shared strict rules.
 *
 * A receipt carries no payloads (a stated limit), so the payload dimension is
 * at best unavailable: RECEIPT VERIFIED needs hash, link, agreement and
 * completeness to pass and payload not to fail.
 */
async function verifyV2(receipt) {
  ok(true, 'receipt_version is 2');
  const acts = Array.isArray(receipt.acts) ? receipt.acts : [];
  ok(acts.length > 0, 'the receipt contains acts', `${acts.length}`);
  const read = receipt.read;
  ok(Boolean(read) && ['first_event', 'unknown'].includes(read.start) && typeof read.tail_complete === 'boolean',
    'the receipt states what its read can prove');

  // The receipt is bound to ONE deal: the envelope names it and every act's
  // canonical inputs (which its hash covers) must name the same one. A label
  // that can be changed alone would verify a receipt under another deal.
  const dealId = receipt.agreement?.contract_id;
  ok(typeof dealId === 'string' && dealId.length > 0, 'the receipt names the deal it is for', String(dealId));

  const current = receipt.agreement?.current;
  let currentHash = null;
  if (current?.snapshot && current?.agreement_hash) {
    const h = await sha256Hex(stableStringify(current.snapshot));
    if (ok(h === current.agreement_hash, 'the current-terms digest follows from its snapshot',
      `${h.slice(0, 12)} vs ${String(current.agreement_hash).slice(0, 12)}`)) currentHash = h;
  } else {
    ok(false, 'the receipt carries the current terms and their digest');
  }

  const blocks = [];
  const withheldInputs = [];
  for (const [i, act] of acts.entries()) {
    const c = act?.canonical;
    const label = `[${i}] ${c?.type ?? '?'}`;
    if (!c || typeof c !== 'object') { ok(false, `${label} carries canonical inputs`); blocks.push({}); withheldInputs.push(null); continue; }
    if (Object.prototype.hasOwnProperty.call(c, 'prev_hash')) {
      ok(false, `${label} uses only prev_event_hash`, 'a prev_hash alias is not part of the format');
    }
    ok(c.contract_id === dealId, `${label} belongs to the deal this receipt names`,
      c.contract_id === dealId ? '' : `${String(c.contract_id)} vs ${String(dealId)}`);
    const kind = classifyStoredEvent(c).kind;
    const required = kind === 'v5' || kind === 'invalid' ? REQUIRED_CANONICAL_V5 : REQUIRED_CANONICAL;
    const missing = required.filter(k => !(k in c));
    const declared = Object.prototype.hasOwnProperty.call(act, 'canonical_withheld') ? act.canonical_withheld : undefined;
    let honoured = null;
    if (declared !== undefined) {
      const problem = withheldDeclarationProblem(receipt, kind, declared, missing);
      if (ok(problem === null, `${label} declares a supported withheld input`, problem ?? declared.join(', '))) honoured = declared;
    }
    const undeclared = honoured ? missing.filter(k => !honoured.includes(k)) : missing;
    ok(undeclared.length === 0, `${label} carries every canonical input for its version`,
      undeclared.length ? `missing: ${undeclared.join(', ')}` : honoured ? `withheld by the reader: ${honoured.join(', ')}` : '');
    withheldInputs.push(honoured);
    const copy = fromV5Transport({ ...c, event_hash: act.event_hash });
    blocks.push(copy.ok ? copy.row : c);
  }

  // The agreement baseline is the ACCEPTED digest, proven here from its
  // snapshot and the acceptance act — never the current terms (Codex T174).
  // Current terms are a drift comparison only.
  let acceptedHash = null;
  const accepted = receipt.agreement?.accepted;
  const hasAcceptanceAct = blocks.some(b => b?.type === 'dod.consent_recorded');
  if (accepted) {
    const ag = await acceptedAgreementOf(blocks, () => accepted.snapshot);
    const same = ag.status === 'ok' && ag.hash === accepted.agreement_hash
      && blocks[ag.acceptance_index]?.id === accepted.acceptance_event_id;
    ok(same, 'the accepted agreement follows from its snapshot and the acceptance act', ag.status);
    ok(accepted.snapshot_version === accepted.snapshot?.snapshot_version,
      'the accepted snapshot_version matches the snapshot it describes',
      `${String(accepted.snapshot_version)} vs ${String(accepted.snapshot?.snapshot_version)}`);
    if (same) acceptedHash = ag.hash;
  } else if (hasAcceptanceAct) {
    // An acceptance happened, so the record must carry what was accepted. A
    // missing or unprovable block cannot be read as "nothing to check".
    ok(false, 'an acceptance act is present, so the receipt carries its validated accepted agreement',
      receipt.agreement?.accepted_status ?? 'accepted block missing');
  } else {
    console.log(` --  no accepted agreement in this receipt (${receipt.agreement?.accepted_status ?? 'unstated'})`);
  }
  if (acceptedHash && currentHash) {
    console.log(acceptedHash === currentHash
      ? ' --  current terms match the accepted agreement'
      : ' --  current terms differ from the accepted agreement (drift since acceptance; not a failure of the record)');
  }

  const slice = await verifyEvidenceSlice(blocks, {
    withheldInputs,
    startsAtChainStart: read?.start === 'first_event',
    tailComplete: read?.tail_complete === true,
    // A whole, complete read with no acceptance act is provably pre-acceptance.
    acceptance: read?.start === 'first_event' && read?.tail_complete === true
      && !blocks.some(b => b?.type === 'dod.consent_recorded') ? 'none' : 'unknown',
    acceptedAgreementHash: acceptedHash,
    // v1–v4 acts are checked against the accepted digest too. With no proven
    // acceptance there is no baseline, so their agreement check is
    // indeterminate rather than passed against today's terms.
    legacyAgreementHash: acceptedHash,
  });
  for (const r of slice.rows) {
    const failed = r.kind === 'invalid'
      || ['mismatch', 'invalid_input'].includes(r.hash)
      || ['broken', 'invalid_input'].includes(r.link)
      || ['mismatch', 'invalid', 'invalid_input'].includes(r.agreement);
    ok(!failed, `[${r.index}] ${r.kind} hash=${r.hash} link=${r.link} agreement=${r.agreement}`,
      r.reason ?? '');
  }
  const d = slice.dimensions;
  const verified = ['hash', 'link', 'agreement', 'completeness'].every(k => d[k] === 'pass') && d.payload !== 'fail';
  if (verified && !accepted && !hasAcceptanceAct) {
    preAcceptanceOnly = receipt.agreement?.accepted_status ?? 'no_acceptance';
  }

  const limits = Array.isArray(receipt.not_verifiable_here) ? receipt.not_verifiable_here : [];
  ok(limits.length > 0, 'the receipt states its own limits rather than implying none', `${limits.length} stated`);
  ok(!('verified_here' in receipt), 'the receipt contains no self-assessed verdict');
  return verified ? null : `dimensions ${JSON.stringify(d)}; acceptance ${slice.acceptance.status}`;
}

/** Two parties' receipts for one agreement must agree, or the operator equivocated. */
async function compare(a, b) {
  console.log('\n--- comparing two receipts for the same agreement ---');
  // Only validated receipts for the same deal are compared: two consistent
  // histories under different deal labels are not an equivocation check.
  const deal = r => r.agreement?.contract_id;
  if (!ok(deal(a) != null && deal(a) === deal(b), 'both receipts name the same deal',
    `${String(deal(a))} vs ${String(deal(b))}`)) return;
  // v2 compares the ACCEPTED agreement; v1 carried only one digest.
  const agreementOf = r => (r.receipt_version === 2 ? r.agreement?.accepted?.agreement_hash : r.agreement?.agreement_hash);
  ok(agreementOf(a) != null && agreementOf(a) === agreementOf(b),
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
  await loadCanonicalDefinition();

  const receipts = [];
  for (const f of files) {
    console.log(`\n${f}`);
    const receipt = JSON.parse(await readFile(f, 'utf8'));
    const previousFailures = failures;
    const incomplete = await verify(receipt);
    receipts.push({ receipt, incomplete, failed: failures > previousFailures });
  }
  const indeterminate = receipts.find(result => result.incomplete)?.incomplete;
  if (receipts.length === 2) {
    if (receipts.some(result => result.failed)) {
      ok(false, 'both receipts verified on their own before comparing');
    } else if (indeterminate) {
      console.log('Comparison skipped: both receipts must verify individually.');
    } else {
      await compare(receipts[0].receipt, receipts[1].receipt);
    }
  }

  console.log(`\n${failures} failed check${failures === 1 ? '' : 's'}`);
  if (failures === 0 && indeterminate) {
    console.log(`RECEIPT NOT VERIFIED — incomplete: ${indeterminate}`);
    console.log('Nothing in it was found to be wrong, but this file does not prove a whole, complete history.');
    process.exit(3);
  }
  if (failures === 0 && preAcceptanceOnly) {
    console.log(`RECEIPT VERIFIED — pre-acceptance chain only (agreement: ${preAcceptanceOnly}).`);
    console.log('Recomputed offline over the read boundary the issuer asserts. No agreement was');
    console.log('accepted in it, so it proves nothing about accepted terms. The hashes cannot');
    console.log('show that no later valid act was left out of this file.');
    process.exit(0);
  }
  if (failures === 0) {
    console.log('RECEIPT VERIFIED — recomputed offline, from this file alone.');
    if (receipts.some(({ receipt }) => receipt?.receipt_version === 2)) {
      console.log('Completeness is the issuer\'s asserted read boundary: the hashes cannot show');
      console.log('that no later valid act was left out of this file.');
    }
    console.log('This says nothing about identity, performance, payment, intent,');
    console.log('the text behind any payload_hash, or whether the operator showed');
    console.log('the other party a different history.');
  }
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
