#!/usr/bin/env node
// The counterparty's agent. A separate process, with no account.
//
// WHAT IT IS GIVEN
//   TF_SUPABASE_URL, TF_SUPABASE_ANON_KEY — public, in every request the web
//     app makes. The anon key is not an authority: it gets the gateway to
//     forward the call, nothing more.
//   TF_CHANNEL_DIR — the handover channel. The invite token arrives here
//     because the owner's agent put it there. TrustFlow does not deliver
//     invitations and this process has no way to look one up, which is the
//     operational rule in docs/api/agent-protocol.md §2 made executable.
//
// WHAT IT IS NOT GIVEN, AND THIS IS THE POINT
// The owner's email, the owner's password, the owner's JWT, any module that
// holds them, and any contract id. Its only authority is the invite token it
// was handed, and then the guest capability acceptance issues to it. There is
// no flag to switch to the other side: it has nothing to switch to.
//
// THE DIGEST IS REIMPLEMENTED HERE ON PURPOSE
// It does NOT import _shared/shownTerms.ts. The whole question Task 14 asks is
// whether an outside client can compute the v2 shown-terms digest from the
// published specification alone, and a client that imports this repository's
// implementation answers a different, easier question. Everything below under
// "the published algorithm" was written from docs/api/agent-protocol.md §1 and
// nothing else. If it disagrees with the server, the specification is wrong —
// which is exactly the failure worth finding.

import { createHash } from 'node:crypto';
import { assertE2EProject, redact } from '../lib/e2eGuard.mjs';
import { channel, fn, reporter, until } from './lib.mjs';

const URL_ = process.env.TF_SUPABASE_URL;
const KEY = process.env.TF_SUPABASE_ANON_KEY;
const DIR = process.env.TF_CHANNEL_DIR;
if (!URL_ || !KEY || !DIR) {
  console.error('counterparty: TF_SUPABASE_URL, TF_SUPABASE_ANON_KEY and TF_CHANNEL_DIR are required');
  process.exit(2);
}
assertE2EProject(URL_);

// ── The published algorithm (docs/api/agent-protocol.md §1) ─────────────────

/** Rules 1–5: sorted keys, no whitespace, undefined dropped, order kept. */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(v => canonical(v === undefined ? null : v)).join(',')}]`;
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** The eight keys the specification names, and no others. */
function shownTermsV2(invitation) {
  return {
    v: 2,
    project_name: invitation.project_name ?? null,
    dod: invitation.dod ?? [],
    amount_minor: invitation.amount_minor ?? invitation.amount_jpy ?? null,
    currency: invitation.currency ?? null,
    deadline: invitation.deadline ?? null,
    performed_by: invitation.performed_by ?? 'creator',
    earner_display_name: invitation.earner_display_name ?? null,
  };
}

function digestV2(invitation) {
  return createHash('sha256').update(canonical(shownTermsV2(invitation)), 'utf8').digest('hex');
}

// ── The transaction, from this side ─────────────────────────────────────────

const r = reporter('guest');

async function main() {
  const ch = channel(DIR);

  // Nothing here is discovered. The token arrives over a channel TrustFlow is
  // not part of, because there is no invitation lookup and should not be one.
  const handed = await ch.get('invite.json');
  r.ok('received an invitation over the agents\' own channel', Boolean(handed?.invite_token),
    redact(handed?.invite_token));

  const token = handed.invite_token;

  const preview = await fn(URL_, KEY, 'validate-invite-token', { body: { invite_token: token } });
  r.ok('read the terms holding only the link', preview.status === 200,
    `HTTP ${preview.status} ${preview.data?.currency ?? ''}`);
  const invitation = preview.data ?? {};

  // The specification's reference vector is in CAD, and so is this agreement,
  // because the digest is MANDATORY off JPY and that path had no automated
  // coverage of any kind before this run.
  r.ok('the agreement is not in yen, so the digest is mandatory',
    invitation.currency && invitation.currency !== 'JPY', String(invitation.currency));
  r.ok('the amount arrives as an integer in minor units',
    Number.isInteger(invitation.amount_minor),
    `${invitation.amount_minor} ${invitation.currency}`);

  // Both refusals the specification promises, before the one that works. They
  // are also the proof that a refused acceptance does not spend the
  // invitation: the token below is the same token.
  const noDigest = await fn(URL_, KEY, 'validate-invite-token', {
    body: { invite_token: token, accept: true, hirer_email: 'agent-guest@example.invalid' },
  });
  r.ok('a non-JPY acceptance with no digest is refused',
    noDigest.status === 409 && noDigest.reason === 'terms_check_unsupported',
    `HTTP ${noDigest.status} ${noDigest.reason}`);

  const v1 = await fn(URL_, KEY, 'validate-invite-token', {
    body: {
      invite_token: token, accept: true, hirer_email: 'agent-guest@example.invalid',
      shown_terms_digest: digestV2(invitation), shown_terms_version: 1,
    },
  });
  r.ok('a non-JPY acceptance below version 2 is refused',
    v1.status === 409 && v1.reason === 'terms_check_unsupported',
    `HTTP ${v1.status} ${v1.reason}`);

  const accepted = await fn(URL_, KEY, 'validate-invite-token', {
    body: {
      invite_token: token, accept: true,
      hirer_email: 'agent-guest@example.invalid',
      counterparty_name: 'Counterparty Agent',
      shown_terms_digest: digestV2(invitation),
      shown_terms_version: 2,
    },
  });
  r.ok('ACCEPTED with a digest computed from the published spec alone',
    accepted.status === 200, `HTTP ${accepted.status} ${accepted.reason ?? ''}`);
  if (accepted.status !== 200) throw new Error(`acceptance refused: ${accepted.reason}`);

  const guestToken = accepted.data?.guest_access_token;
  r.ok('acceptance issued a capability for this one agreement', Boolean(guestToken),
    redact(guestToken));

  const trail = () => fn(URL_, KEY, 'guest-contract-events', { guestToken });

  const seen = await until('the performer to assert delivery', async () => {
    const got = await trail();
    return got.data?.events?.some(e => e.type === 'performance.asserted') ? got : null;
  });
  r.ok('saw the delivery asserted, over the capability', true,
    `${seen.data.events.length} events`);

  // The only judgement this process makes. It is a fixed policy, not a
  // decision — see scripts/sim-counterparty.mjs on what that does and does
  // not demonstrate.
  const acceptDelivery = await fn(URL_, KEY, 'log-event', {
    guestToken,
    body: {
      type: 'performance.accepted', contract_id: seen.data.contract?.id ?? null,
      payload: { note: 'Checked against the agreed list' },
    },
  });
  r.ok('accepted the delivery', acceptDelivery.status === 201 || acceptDelivery.status === 200,
    `HTTP ${acceptDelivery.status} ${acceptDelivery.reason ?? ''}`);

  // Whoever receives the work is the one who pays, so reporting the transfer
  // is this side's act (log-event ROLE_REQUIRED). It is a claim about a rail
  // TrustFlow cannot see, which is why the type is named `reported`.
  const paid = await fn(URL_, KEY, 'log-event', {
    guestToken,
    body: {
      type: 'payment.reported', contract_id: seen.data.contract?.id ?? null,
      idempotency_key: `agent-pay-${handed.run}`,
      payload: { note: 'Sent by bank transfer — a statement, not a receipt' },
    },
  });
  r.ok('reported the payment', paid.status === 201 || paid.status === 200,
    `HTTP ${paid.status} ${paid.reason ?? ''}`);

  const final = await until('the payee to acknowledge', async () => {
    const got = await trail();
    return got.data?.events?.some(e => e.type === 'payment.acknowledged') ? got : null;
  });
  r.ok('saw the payment acknowledged by the other side', true,
    `${final.data.events.length} events`);
}

main()
  .then(() => {
    if (r.failures.length) {
      console.error(`counterparty: ${r.failures.length} failed`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error(`counterparty ABORTED: ${err.message}`);
    process.exit(1);
  });
