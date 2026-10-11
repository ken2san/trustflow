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
// statement matches what was committed to, because canonical v4 commits to a
// single `payload_hash` over the whole payload: disclosing one field would mean
// disclosing the preimage of all of them, so the parties are shown an
// allowlisted projection instead and cannot reproduce that digest from it —
// measured, 0 of 4 events.
//
// That gap is real, is not closed by this script, and is therefore stated in
// the emitted JSON under `not_verifiable_here`. Closing it needs per-claim
// salted commitments, which is a canonical v5 and a separate decision. Writing
// a receipt that implied otherwise would be the exact failure this product is
// supposed to be against.
//
// Owner-side only for now: the guest's endpoint does not yet return the three
// digests their half would need. No deploy is implied by this file.

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  GENESIS_HASH, eventCanonical, canonicalVersionOf, bindsWholeAgreement,
  buildAgreementSnapshot, deriveAgreementHash, sha256Hex,
} from '../supabase/functions/_shared/eventCanonical.ts';
import { assuranceMeaning, bearerAssurance } from '../supabase/functions/_shared/authAssurance.ts';
import { ownerSession, rest, PROJECT_REF, SUPABASE_URL } from './lib/tfClient.mjs';

const COLUMNS = [
  'id', 'type', 'contract_id', 'actor_id', 'payload', 'dod_hash', 'created_at',
  'event_hash', 'prev_event_hash', 'hash_version', 'payload_hash',
  'agreement_hash', 'idempotency_key', 'tsa_token',
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

  const rows = (await rest(token,
    `events?contract_id=eq.${encodeURIComponent(contractId)}&select=${COLUMNS}`
    + '&order=created_at.asc,id.asc')).body ?? [];
  if (!rows.length) { console.error('No events.'); process.exit(1); }

  const agreementHash = await deriveAgreementHash(contract);

  // Recompute rather than copy. A receipt asserting a digest it did not verify
  // is the "integrity_status: VERIFIED" problem in a new file.
  let prev = GENESIS_HASH;
  let chainIntact = true;
  const acts = [];
  for (const [i, r] of rows.entries()) {
    const version = canonicalVersionOf(r);
    const recomputed = await sha256Hex(eventCanonical(r, version));
    const linked = (r.prev_event_hash ?? GENESIS_HASH) === (i === 0 ? GENESIS_HASH : prev);
    const sameAgreement = !bindsWholeAgreement(version) || r.agreement_hash === agreementHash;
    if (!(recomputed === r.event_hash && linked && sameAgreement)) chainIntact = false;

    acts.push({
      sequence: i,

      // ── EVERY CANONICAL INPUT, so a reader can recompute event_hash from
      // this file and nothing else. An earlier version of this script omitted
      // id, contract_id, actor_id and dod_hash and asserted a `checks` object
      // instead — which made the receipt a statement that TrustFlow had
      // verified itself, exactly the `integrity_status: VERIFIED` problem in a
      // new file. These are identifiers and digests only; no payload preimage.
      canonical: {
        id:              r.id,
        type:            r.type,
        contract_id:     r.contract_id,
        actor_id:        r.actor_id,
        dod_hash:        r.dod_hash ?? null,
        created_at:      r.created_at,
        prev_event_hash: r.prev_event_hash ?? null,
        payload_hash:    r.payload_hash ?? null,
        agreement_hash:  r.agreement_hash ?? null,
        hash_version:    r.hash_version ?? null,
      },
      // The digest as stored. The verifier recomputes and compares; this file
      // claims nothing about whether they match.
      event_hash: r.event_hash,

      // Context for a human reader, not inputs to any hash.
      recorded_at: r.created_at,
      actor_role: r.payload?._actor_role ?? null,
      role_in_agreement: r.payload?._role_in_agreement ?? null,
      // Carried verbatim, both of them. The string is the coarse legacy value
      // two stored values wide; the object is what the server observed from
      // the credential actually presented, and is absent on every event
      // written before it existed. Neither is a verdict and neither is
      // recomputable here — they are what the record says about how the actor
      // got in. No JWT, `amr` entry or absolute authentication timestamp is
      // copied into this file; the server does not store one.
      authentication_as_recorded: r.payload?._auth_method ?? null,
      authentication: r.payload?._authentication ?? null,
      claimed_identity_verified: r.payload?._claimed_identity_verified ?? null,
      idempotency_key: r.idempotency_key ?? null,
      timestamp_token_present: Boolean(r.tsa_token),
    });
    prev = r.event_hash;
  }

  const receipt = {
    receipt_version: 1,
    issued_at: new Date().toISOString(),
    source: { project_ref: PROJECT_REF, api: SUPABASE_URL, issued_for_role: 'owner' },

    // The deal, in the exact shape its hash is taken over, so a reader can
    // recompute agreement_hash from this file alone.
    agreement: {
      contract_id: contract.id,
      snapshot: buildAgreementSnapshot(contract),
      agreement_hash: agreementHash,
      state: contract.state,
    },

    acts,

    // Deliberately NOT a verdict. The issuer of a receipt asserting its own
    // correctness is the thing a receipt is supposed to make unnecessary.
    how_to_verify: {
      command: 'node scripts/verify-receipt.mjs <this-file>',
      offline: true,
      recomputes: ['event_hash per act', 'chain linkage', 'agreement_hash from the snapshot'],
      canonical_definition: 'supabase/functions/_shared/eventCanonical.ts',
      note: 'The verifier needs no network and no access to TrustFlow. If it '
        + 'disagrees with this file, believe the verifier.',
    },

    // The honest half. A machine reader has no README to consult.
    not_verifiable_here: [
      'That the text of any statement matches what was committed to. Canonical v4 '
      + 'commits to one payload_hash over the whole payload, and the parties are shown '
      + 'an allowlisted projection, so the digest cannot be reproduced from what they see.',
      'The identity of any party. The counterparty holds a transferable bearer '
      + 'capability and their address is self-claimed and recorded unverified.',
      'How any account holder authenticated, beyond what the record states. From '
      + 'the change that added the `authentication` field this is observed from the '
      + 'credential presented rather than inferred from the role, but it is still '
      + 'the server\'s own report of its own check: nothing in this file lets a '
      + 'reader confirm independently that the described session existed. Events '
      + 'written earlier carry only the coarse legacy string, or nothing at all.',
      'That the work described was performed, or that any payment moved. TrustFlow '
      + 'records that a party said so.',
      'That TrustFlow showed both parties the same history. There is no external '
      + 'witness to its log, so an operator presenting two different consistent '
      + 'histories to the two parties would not be detectable from this file — '
      + 'only by comparing it against the other party\'s receipt.',
      'That anyone authenticated in order to perform an act. Authentication is '
      + 'not bound to the act: there is no challenge tied to this agreement_hash '
      + 'and action, so even a login seconds beforehand shows recency, not intent. '
      + 'Consent given through an authenticated session is not a signature.',
    ],

    counterparty_authority: assuranceMeaning(bearerAssurance('guest_access_token')),
  };

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
