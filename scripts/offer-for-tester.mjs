#!/usr/bin/env node
// One agreement, offered, so an AI tester can be handed the link and nothing else.
//
//   npm run offer:tester -- "the brief in one line" 20000
//
// WHY THIS EXISTS
// The exploratory half of Next Priority #1 needs a counterparty that does not
// know how this is built. Everything else in scripts/ drives BOTH sides: the
// tester would be reading its own script. This creates the owner's half and
// stops, printing a URL — which is exactly what a real invited party receives,
// because Send Invite sends no email and delivery is manual.
//
// WHAT THE TESTER MUST NOT BE GIVEN
// This repository, the API shape, the expected sequence, previous findings, or
// the fact that any particular screen is under suspicion. The link and a
// situation. That is the whole point; a counterparty told where to look is a
// second opinion about our own assumptions.
//
// E2E ONLY. tfClient's import of e2eGuard refuses any other project before the
// first request, and the events a tester writes are indistinguishable in the
// record from real ones.

import { ownerSession, rest, PROJECT_REF } from './lib/tfClient.mjs';
import { formatMinor } from '../supabase/functions/_shared/money.ts';

const BRIEF = process.argv[2] ?? 'Translate a two-page document into Japanese';
const AMOUNT = Number(process.argv[3] ?? 20000);
const PERFORMED_BY = process.argv[4] ?? 'creator';
const APP = process.env.TF_APP_URL ?? 'http://localhost:5173';

/** Far enough out that an expiry is never the thing being measured. */
function deadlineISO(days = 21) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

const { token, userId } = await ownerSession();

const created = await rest(token, 'contracts?select=*', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    earner_user_id: userId,
    earner_display_name: 'Acme Translations',
    project_name: BRIEF,
    dod: ['Deliver the translated document', 'Return it as a stamped PDF'],
    amount_jpy: AMOUNT,
    amount_minor: AMOUNT,
    amount_minor: AMOUNT,
    currency: 'JPY',
    deadline: deadlineISO(),
    invited_hirer_email: 'invited@example.invalid',
    performed_by: PERFORMED_BY,
  }),
});

const contract = Array.isArray(created.body) ? created.body[0] : null;
if (created.status !== 201 || !contract) {
  console.error(`Could not offer the agreement: HTTP ${created.status}`);
  console.error(JSON.stringify(created.body, null, 2));
  process.exit(1);
}

// The token is printed in full ON PURPOSE: it is the capability the tester is
// meant to hold, and redacting it would leave nothing to hand over. It grants
// access to this one agreement on the E2E project and nothing else.
console.log(`
Offered on ${PROJECT_REF}

  contract   ${contract.id}
  brief      ${contract.project_name}
  amount     ${formatMinor(contract.amount_minor ?? contract.amount_jpy, contract.currency)}
  deadline   ${contract.deadline}
  performer  ${contract.performed_by}

Hand the tester this link and nothing else:

  ${APP}/?token=${contract.invite_token}

Afterwards, read what it actually wrote:

  node scripts/verify-chain.mjs ${contract.id}
`);
