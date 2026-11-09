# TrustFlow Protocol

_What the implemented evidence protocol is, as of 2026-09-26._

> This document describes the protocol **as the code implements it**. It is not a
> vision document; `Roadmap.md` holds product direction, `Decisions.md` holds the
> reasoning behind the design, and `HANDOFF.md` holds current operational state.
> If this file and the code disagree, the code is right and this file is a bug.
>
> The protocol is the `AgreementView` / `ContractsHomeView` flow backed by
> Supabase. The legacy five-step escrow / Marketplace surface in
> `ContractView.jsx` is **not** this protocol: it runs on local mock state and
> its event writes are rejected server-side. Do not read it as a specification.

## 1. What the protocol claims

TrustFlow attests **that a party said something about an agreement, at a time,
in an order that cannot be rearranged**. It does not attest that what they said
is true.

That single distinction decides the vocabulary, the state machine and the
exports. An Earner asserting performance is not the work having been delivered;
a counterparty claiming an email address is not that address having been
verified. Every place the protocol could collapse those into a stronger claim,
it deliberately does not.

## 2. Parties and authority

| Party | Credential | Where it comes from |
|---|---|---|
| Owning account | Supabase JWT, non-anonymous | sign-in (`earnerAuth.js`) |
| Invited counterparty ("guest") | `x-guest-access-token` | issued inside the acceptance transaction |
| Server | `service_role` | Edge Functions only |

The counterparty never needs an account. They hold a one-time invitation
capability, and on accepting it they are issued a durable guest credential for
that one contract.

Two authorities are kept separate and must stay separate: **reading evidence**
and **acting on the protocol**. Restoring one must never confer the other — see
`Decisions.md`, "What TrustFlow actually knows about the guest".

Being a party is not sufficient to write any event. `log-event` also enforces
which **functional role** an event belongs to, taken from
`contracts.performed_by`: whoever performs may assert performance, whoever
receives may accept or reject it, and neither can do the other's part. The role
is a property of the deal, not of the account/guest divide — the creator may be
either side.

## 3. Reachable states

State is a **projection of the attested log**, derived in one place:
`derive_contract_state()` in `20260925000000_evidence_core.sql`, applied by an
after-insert trigger on `events`.

```
DRAFTING ──▶ AWAITING_ACCEPTANCE ──▶ TERMS_ACCEPTED ──▶ AWAITING_CONFIRMATION ──▶ PERFORMANCE_ACCEPTED
                                          ▲                      │                     (terminal)
                                          └──── performance.rejected
```

- `AWAITING_CONFIRMATION` means the performer has **asserted** performance and
  the protocol is waiting on the receiver. It does not mean the work arrived.
- `performance.rejected` returns to `TERMS_ACCEPTED`. The disagreement stays in
  the log; it is not represented as a verdict, and there is no rejection limit,
  no pause, no renegotiation and no admin override.
- `SETTLED`, `DELIVERED` and `CANCELLED` are **not reachable**. Money moves
  outside TrustFlow today, so nothing settles; `DELIVERED` was never written by
  anything; `CANCELLED` has only ever been written by `cancel-payment`, which no
  code path calls. `contractStatus.js` still carries presentation for all three.

## 4. Event vocabulary

A party may record: `contract.initiated`, `contract.accepted`,
`performance.asserted`, `performance.accepted`, `performance.rejected`,
`contract.cancelled`, `contract.completed`, `dispute.opened`,
`rating.submitted`.

Only `performance.asserted`, `performance.accepted` and `performance.rejected`
move the state. The rest are recorded without changing where the protocol
stands — `contract.cancelled` in particular is accepted, stored, and projects
nothing, because whether a party may void an accepted agreement is undecided.

`dod.consent_recorded` is **server-recorded**: the authoritative acceptance,
written by `validate-invite-token` inside the acceptance transaction and refused
from a party with `type_is_server_recorded`.

`work.submitted`, `work.approved` and `work.rejected` are **retired**. Old rows
keep those names forever and still verify, but they are no longer accepted —
"work.submitted" reads as "the work arrived", which is the claim the protocol
cannot make.

`payment.*`, `trustpoints.*` and dispute verdicts are not assertable from a
browser at all.

## 5. What an event binds

Defined once in `supabase/functions/_shared/eventCanonical.ts`, imported by
every writer, reader and verifier. Assembled once in `_shared/eventRecord.ts`.

The hash covers who acted, on which agreement, under which version of its terms,
when, where it sits in the chain, a hash of its payload, and — from v4 — a hash
of the whole agreed deal.

| Version | Adds |
|---|---|
| 1 | pre-chain: `id`, `type`, `contract_id`, `actor_id`, `dod_hash`, `created_at` |
| 2 | `prev_hash` — the chain becomes a chain |
| 3 | `payload_hash` — the substance of an assertion becomes tamper-evident |
| 4 | `agreement_hash` — binds the whole deal, not only the completion criteria |

Versions are permanent. A v3 row is verified forever under v3 rules, and the
arrival of v4 does not reinterpret it; `binds_whole_agreement` tells a reader
which rows bind the whole deal.

The chain links on `prev_event_hash`, with the sentinel `GENESIS` for a
contract's first event. Nothing is recorded when an agreement is *created*, so
the acceptance is always the first event.

The **agreement snapshot** (`snapshot_version`, `project_name`, `dod`, `amount`,
`currency`, `deadline`, `performed_by`, `offered_by`) is both hashed and embedded
in the acceptance event, so the accepted terms can be shown years later without
consulting the contract row. Membership is semantic: a field belongs if changing
it means a different deal. Ids, protocol state, tokens and internal timestamps
are excluded by that test.

The acceptance additionally records `_invited_recipient`, `_claimed_identity`,
`_claimed_identity_verified` (always `false` today) and `_auth_method`. The
server owns the underscore namespace: `log-event` strips underscore-prefixed
keys from anything a caller sends.

## 6. Invariants

- **Append-only.** `events` carries `no_delete_events` / `no_update_events`.
  Note they are `DO INSTEAD NOTHING` rules: a `DELETE` succeeds and deletes
  nothing.
- **Acceptance and its evidence commit together.** `accept_invitation()` checks
  the invitation, consumes it, moves the state, issues the guest credential and
  appends the acceptance event in one transaction, under a row lock. Neither
  half can exist without the other, and the client has no second call on this
  path.
- **Terms are frozen once accepted.** `contracts_freeze_accepted_terms` refuses
  a change to an agreed term past `DRAFTING`/`AWAITING_ACCEPTANCE`, including
  from a privileged role. This is defence in depth; the evidence must never come
  to depend on it, which is why `guest-contract-events` re-derives the snapshot
  and reports `terms_changed_since_acceptance`.
- **`dod_hash` is the server's.** Client `INSERT` on that column is revoked.

## 7. Evidence out

Two documents, deliberately different, and they must not converge:

| | Owner | Counterparty |
|---|---|---|
| Built by | `src/lib/auditExport.js` | `src/lib/guestRecordExport.js` |
| Named | `trustflow_audit_trail` | `trustflow_counterparty_record` |
| Claim | self-contained, re-verifiable by a third party | event hashes and the chain are recomputable from the file; `payload_hash` is not, because the detail shown is an allowlisted part of what it covers |

Both are built from raw `events` rows, never from the shaped arrays a screen
renders. A document built from shaped events would report every untouched event
as tampered with, and an export that falsely cries tampering is worse than none.

## 8. Not part of the protocol

Present in the repository, not in the live flow:

- **Payment.** Gone, in both halves this bullet used to claim. The three
  functions — `create-payment-intent`, `capture-payment`, `cancel-payment` —
  were un-deployed on 2026-11-06 and their source was deleted in Task 20;
  `scripts/smoke-production.mjs` asserts all three stay 404 on every release.
  `PaymentModal` never existed: the sentence pointed at an empty directory.
  Stripe Connect remains the decided rail if settlement is ever wired
  (`Decisions.md`), and nothing about it is built. What the protocol does carry
  is a party's *claim* about payment — `payment.reported`,
  `payment.acknowledged`, `payment.disputed` — and no verified payment fact.
- **RFC 3161 timestamping.** `timestamp-event` was deleted from Supabase on
  2026-09-26, the client that called it (`src/lib/tsa.js`) was removed in
  Task 17 once nothing imported it, and the function's source went in Task 20.
  There is no external notarisation today; the chain and the server's
  attestation are the whole guarantee. `tsa_token` columns and the
  `tsa_token_present` field in the exports remain, always null — they say a
  token was never obtained, which is a fact worth keeping.
- **AI scoping.** No Gemini integration exists anywhere in the code.
- **Trust Score / TrustPoints / Trust Passport.** `src/lib/trustpoints.js` is
  a rules module — numeric constants and labels — and nothing calls it except
  its unit test. `WalletView` and `ProfileModal` do **not** exist: this bullet
  used to say they "operate on local mock profile state", and they were only
  ever names in comments in `src/App.jsx`, now removed. The
  `trustpoints_ledger` table exists and has **no writer at all** since Task 20
  deleted the two functions that inserted into it; it has never held a row.
  None of this is part of the evidence protocol.
- **Client-side HMAC invites.** Gone. `src/lib/invite.js` was the legacy
  implementation and this bullet described it as "dead"; the file itself no
  longer exists.

## 9. Open protocol questions

Recorded in `Decisions.md`, not settled here, and not to be settled by
implementation:

- Whether a party may void an **accepted** agreement. Withdrawing an invitation
  that has not been accepted is decided and not yet built.
- Whether performance that unfolds across several real-world steps fits
  `performance.asserted → accepted/rejected`.
- Whether a counterparty can recover access, and what later verification of a
  self-asserted email may and may not mean.
- Whether creation should be recorded as an event. It currently is not.

## 10. Shared formatting utilities

One convention that belongs nowhere else: all number, date, string and array
presentation goes through `src/lib/utils.js` — `formatNumber`, `formatDate`,
`truncate`, `uniqueArray` — so formatting stays consistent and locale handling
lives in one place.
