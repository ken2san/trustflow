# Where is it stuck, and what happens when the email was wrong

Read-only audit, 2026-11-08. No code was changed. Every claim below is cited to a
file and line, and where a claim is about the live database it was checked with a
read-only query against production `fqgpzhwvvfsxswlnbbgg` or E2E
`yqjtawffpesplqyurlpj`.

Reviewed by Codex after the first draft; §6 lists what the review changed and
what it still withholds. Four claims in that draft were wrong and are corrected
in place rather than quietly dropped.

Two questions, one document, because they turn out to share a root: the product
keeps an excellent record of what *happened* and almost no record of what is
*happening*, and the one place that gap bites hardest is an invitation sent to
the wrong address.

---

## 1. What the web UI shows about "stuck, waiting on whom, since when"

### 1.1 Where this is decided

One file decides it for the whole product: `src/lib/contractStatus.js`.
`nextActionFor(contract, now)` (`:115-191`) returns `{ owner, label, detail }`,
where `owner` is `'you' | 'client' | 'none'`, and `groupContracts` (`:203-223`)
splits the home screen into **Needs you / In progress / Completed** on exactly
that answer. It is pure, free of React and Supabase, and tested
(`tests/unit/contractStatus.test.js`). This is a good design and nothing below
proposes replacing it.

The detail screen does **not** use it. `src/views/AgreementView.jsx:167-173`
computes its own four-branch `waitingText` string:

```js
const waitingText = cancelled ? 'This agreement was cancelled.'
  : done ? null
  : state === 'AWAITING_ACCEPTANCE' ? 'Waiting for the other party to confirm the terms.'
  : performs && state === 'AWAITING_CONFIRMATION' ? 'You marked this delivered. Waiting for their review.'
  : !performs && (state === 'TERMS_ACCEPTED' || state === 'IN_PROGRESS')
    ? 'Waiting for them to deliver.'
    : null;
```

So the same agreement is described by two independent implementations, and the
screen a party actually acts on is the one with no timestamps, no deadline
handling and no invite-expiry awareness. It is also the screen **both** parties
use: `src/App.jsx:1210-1232` renders `AgreementView` for the owner
(`agreement.source === 'owner'`) and for the guest (`'guest'`) alike.

### 1.2 State by state, as the UI actually presents it

| State | Who it says is waiting | "Since when" | Remaining time / deadline |
| --- | --- | --- | --- |
| `DRAFTING` | you — "Send the invite" (`contractStatus.js:125-127`) | never shown | none |
| `AWAITING_ACCEPTANCE` | client, unless the invite expired or expires within 24h, when it flips to you (`:129-152`) | never shown | invite expiry only, and only inside 24h |
| `TERMS_ACCEPTED` / `IN_PROGRESS` | depends on `performed_by`; distinguishes "ready to deliver" from "correction requested" via `last_performance_type` (`:163-176`) | never shown | none |
| `AWAITING_CONFIRMATION` | the reviewing side (`:178-182`) | never shown | none |
| `PERFORMANCE_ACCEPTED` | nobody — "Completed", terminal (`:49-53`, `:154-157`) | n/a | n/a |

**`DRAFTING` is dead.** The column default was `DRAFTING` in
`supabase/migrations/20260527000000_contracts_table.sql:17` and is
`AWAITING_ACCEPTANCE` today (verified in `information_schema`), and production
holds **zero** rows in `DRAFTING` (1321 contracts: 682 `TERMS_ACCEPTED`, 461
`AWAITING_ACCEPTANCE`, 133 `AWAITING_CONFIRMATION`, 44 `PERFORMANCE_ACCEPTED`, 1
`IN_PROGRESS` — all QA data). The branch is harmless but no human will ever read
it, so it is not worth spending UI effort on.

### 1.3 "Since when" — nothing is shown anywhere, and most of it is already loaded

This is the clearest finding in the audit. **No screen in the product displays
how long anything has been waiting**, and three of the four timestamps needed to
say so are already in the browser:

- **`created_at`** is selected (`src/lib/contracts.js:105`) and used only as a
  sort tiebreaker (`contractStatus.js:229`). It is "waiting since" for
  `AWAITING_ACCEPTANCE`.
- **`last_performance_at`** is computed for every contract in the list by
  `withLatestPerformance` (`src/lib/contracts.js:144`) and **is never read by
  anything** — `grep` finds it in `contracts.js` and in one e2e fixture, nowhere
  in `src/views` or `src/lib/contractStatus.js`. (`last_performance_type`, its
  sibling, *is* read — `contractStatus.js:74,167`; only the timestamp is dead.)
  It is "asserted since" for `AWAITING_CONFIRMATION` and "correction requested
  since" after a rejection, and needs no new query at all.

  It can also be **null**, and A1 must not read null as a time: there may be no
  such event yet, and `withLatestPerformance` does not check its query for an
  error (`contracts.js:128`), so a failed read is null too. Null means "start
  time unknown", never "waiting since now".
- **`invite_token_expires_at`** is selected (`contracts.js:105`) and read only to
  compute the 24-hour warning (`contractStatus.js:133-150`).
- **The acceptance time** — "accepted since", for `TERMS_ACCEPTED` — is the one
  that is *not* loaded: `withLatestPerformance` filters to
  `performance.asserted | accepted | rejected` (`contracts.js:132`), so
  `dod.consent_recorded` is excluded. Adding it to that `.in()` list is a
  one-element change to an existing single query.

`contracts.updated_at` exists and is trigger-maintained
(`contracts_updated_at` → `set_updated_at`, confirmed in `pg_trigger`), and it
is tempting as a cheap "since". **It should not be used for this.** It means
"the last time any column changed", which includes a reissued guest token and a
Stripe column, so labelling it "waiting since" would state something the data
does not support. The event log is the honest source and is already fetched.

### 1.4 Contractual deadline vs token expiry — the distinction the UI loses

These are three different clocks and the product currently blurs two of them and
hides the third.

**The contractual deadline** is `contracts.deadline`, type `date` (no time of
day), bound into the hashed agreement snapshot
(`supabase/functions/_shared/eventCanonical.ts:88-101`), so it is part of what
was agreed and is tamper-evident. It is validated **only at creation**:
`validate_contract_creation_only` rejects a deadline more than a day in the past
(confirmed in `pg_proc`), and `src/App.jsx:903` blocks Send Invite on it. After
creation, **nothing in the product acts on a deadline or notices that it
passed** — `grep -i overdue` over `src/` returns nothing. The Roadmap says this
in as many words: item 9, "Deadline handling — Deadlines are stored and bound
into the snapshot; nothing acts on them" (`Roadmap.md` §3).

Presentation is also inconsistent: the home screen formats it
(`formatDeadline`, `contractStatus.js:278-283` → "due Nov 12") while
`AgreementView.jsx:205` interpolates the raw column (`due {contract.deadline}` →
"due 2026-11-12").

**The invite token's expiry** is `invite_token_expires_at`, defaulting to
`now() + 72h` (column default, confirmed in `information_schema`). It is not part
of the agreement — it is how long the *link* works. The UI mentions it only
inside the last 24 hours, and when it does, the wording is "The link expires in
N hours" (`contractStatus.js:148`), which is at least correctly about the link.
A guest meets it as a dedicated error screen (`InviteView.jsx:65,81` — "This
invite has expired").

**The guest access token's expiry** is `guest_access_token_expires_at`, 90 days
from acceptance or reissue (`reissue-guest-access/index.ts:62`). It is
**invisible to everyone**. `listContracts` does not select it
(`contracts.js:102-106`), so the owner cannot see when their counterparty's
access lapses; the guest learns it only when a request fails
(`GuestEvidenceView.jsx:184`, "This access link has expired"). The column is
`SELECT`-granted to `authenticated` and visible to parties under
`parties_read_own_contracts` (both verified by query), so surfacing it is a
one-string change to the select list.

So: of three clocks, one is agreed and tamper-evident but acted on by nothing,
one is shown for its last 24 hours, and one is not shown at all.

---

## 2. The wrong email

### 2.1 First, the thing that removes most of the drama: no invitation is ever emailed

**TrustFlow never emails an invitation.** (It does send mail: `signInWithOtp`
puts the owner's sign-in code in their mailbox, `src/lib/earnerAuth.js:146`.
Nothing about an agreement is emailed to anyone.) `send-acceptance-email` is the
only agreement-related mailer in the tree and it is **not deployed** — `npm run smoke:prod` asserts it stays 404, and the
source survives only as a file (`supabase/functions/send-acceptance-email/`,
unreferenced). `HANDOFF.md` §Next Priority #1 states it directly: "**Send Invite
produces a shareable URL and sends no email.** Delivery is manual, through
whatever channel the owner picks, and so is a re-issued access link."

Therefore a wrong `invited_hirer_email` **does not misdeliver anything**. It
cannot send an invitation to the wrong person. The field is a label the owner
typed, and `Decisions.md:129-140` is explicit that this is deliberate — it is
kept required not for delivery but because "asking for it *deliberately* — a
human choosing to hand over the identifier that is about to become their
signature — is a stronger moment".

The real wrong-person incident is therefore the one the task's framing implies:
the owner **pastes the link into the wrong conversation**, or types the wrong
address and then sends the link to the person that address belongs to. The
address and the link travel separately, and only the link carries authority.

### 2.2 The owner's own email

There is nothing to get wrong, and nothing to correct. The owner is an
`auth.users` row; the agreement records `earner_user_id` plus a free-text
`earner_display_name`, which is what the snapshot calls `offered_by`
(`eventCanonical.ts:99`). The owner's email address is never written to
`contracts` and never shown to the counterparty. A wrong owner email is a
Supabase-account problem (sign-in reaches the wrong mailbox), entirely outside
the evidence model. **Out of scope for this proposal**, and worth saying so
rather than designing for it.

### 2.3 What can be changed today: nothing, from the client

This is the hard constraint that shapes every option below. Checked by query
against E2E, not inferred from source:

- **`authenticated` has no `UPDATE` privilege on `contracts` at all.**
  `information_schema.column_privileges` grants it `INSERT` on nine columns
  (`amount_jpy, currency, deadline, dod, earner_display_name, earner_user_id,
  invited_hirer_email, performed_by, project_name`), plus `SELECT` and
  `REFERENCES`. No `UPDATE`, on any column.
- **There is no `UPDATE` policy either.** `pg_policies` on `public.contracts`
  returns exactly four: `creator_insert_contract` and
  `verified_earner_only_insert` (INSERT), `parties_read_own_contracts` (SELECT),
  `owner_delete_unaccepted_draft` (DELETE). No UPDATE policy exists, so even
  with a grant there would be no path.

So "let the owner fix the typo" is **not** a UI change. It requires a new
server-side writer. The precedent for exactly that shape already exists and is
good: `reissue-guest-access` verifies the owner's JWT, re-reads the row with the
service role, and calls a `SECURITY DEFINER` RPC that swaps the credential and
appends the event in one transaction
(`supabase/functions/reissue-guest-access/index.ts:95-200`,
`20261011000000_reissue_guest_access.sql`).

A second constraint, less obvious and more interesting:

- **`freeze_accepted_terms` does not protect the identity fields.** The trigger
  (confirmed via `pg_get_functiondef`) refuses post-acceptance changes to
  `project_name, dod, amount_jpy, currency, deadline, performed_by,
  earner_display_name` — and says nothing about `invited_hirer_email` or
  `hirer_email`. So a service-role writer *could* silently rewrite who was
  invited on an accepted agreement, with no database objection. The guard
  protects the terms; it does not protect the parties.

### 2.4 What is recorded about the invitation — which is less than it looks

| Fact | Where it lives | Mutable? | In a hash? |
| --- | --- | --- | --- |
| the address the owner typed | `contracts.invited_hirer_email` | only by a service-role writer | **the column is not** — but its value at acceptance is, as the next two rows |
| the address the guest typed at acceptance | `contracts.hirer_email` | only by a service-role writer | same |
| who was invited, as evidence | `_invited_recipient` in the acceptance event's payload (`_shared/eventRecord.ts:74-81`) | never — `events` is append-only | yes, via `payload_hash` → `event_hash` |
| who claimed to accept, as evidence | `_claimed_identity`, same payload, with `_claimed_identity_verified: false` | never | yes, same path |
| the agreed terms | `agreement_hash` on **every** event (`eventRecord.ts:146-150`) | n/a | yes |

Two consequences matter.

**First: `invited_hirer_email` is not in the agreement snapshot.**
`buildAgreementSnapshot` (`eventCanonical.ts:88-101`) covers `project_name, dod,
amount, currency, deadline, performed_by, offered_by` — neither email. So
changing either address later would **not** break any hash and would not change
`agreement_hash` on subsequent events. The chain would stay internally
verifiable while the row said something different from the acceptance event's
`_invited_recipient`. That is the honesty hazard: not a broken chain, a *silent
disagreement* between the screen and the evidence.

**Second, and this is a documentation defect worth fixing separately:**
`HANDOFF.md` §Open Decisions states that "`hirer_email` is inside the hashed
agreement snapshot and the log is append-only". The second half is right and the
first half is not — `hirer_email` is hashed inside the **acceptance event's
payload** (`_claimed_identity`), not in the agreement snapshot. What that decision concludes needs the same narrowing: what cannot be
repaired is the **input already hashed into an existing acceptance event** —
normalising today's row would break no hash, and comparing case-insensitively
in code while the RLS policy uses `=` remains a live design choice, not
something append-only forbids. Reported here, not changed, per the Scope Policy,
and not mixed into B2.

**Third, and the one that reshapes Kenji's preferred option:** in practice there
is *no record of the invitation* before acceptance. `createContract` writes no
event (`src/lib/contracts.js:36-78`), nothing in `src/` ever logs
`contract.initiated` (`grep` finds the constant in `eventLog.js:30` and the
labels in two views — no call site), and `HANDOFF.md` §Open Decisions still lists
"**Whether creation should be an event.** Unchanged — `createContract` still logs
nothing; acceptance is still the chain's first event."

To be exact, because the difference matters below: what is missing is a *caller*,
not a *destination*. `contract.initiated` is in `log-event`'s allowlist
(`log-event/index.ts:66-68`) and an unaccepted contract can already carry it —
`validate-invite-token/index.ts:250-254` says so, and `scripts/api-e2e.mjs`
check 29 does it. So an event *can* be appended to an unaccepted agreement
today. What cannot be done today is appending one and still being able to
withdraw the offer: the moment an event exists, `owner_delete_unaccepted_draft`
stops matching, because its predicate requires no events.

### 2.5 So what is the flow today — correct, revoke, re-invite?

**Correct: impossible.** No UPDATE path (§2.3).

**Revoke, before acceptance: only by deleting the whole contract.**
`owner_delete_unaccepted_draft` permits a DELETE by the owner when the state is
`AWAITING_ACCEPTANCE`, the invite is unused, **and** no events exist
(policy text confirmed by query; `20261104204009`, hardened under a row lock by
`20261108130000`). The client path is `deleteDraftContract`
(`contracts.js:332-345`), surfaced as "Delete draft" on the home screen
(`ContractsHomeView.jsx:86-110`, `:171-179`). `Decisions.md:191-192` records this
as the deliberate answer: "the withdraw half stays unbuilt, and
`owner_delete_unaccepted_draft` is the whole answer to 'I sent this to the wrong
person'."

There is no way to rotate `invite_token` or shorten its expiry. So if the link
reached the wrong person and the owner does *not* delete the contract, **the
wrong link stays live until it is used or until the 72 hours run out.**

**Revoke, after acceptance: `reissue-guest-access`**, which overwrites
`guest_access_token`, restarts the 90-day clock, and appends `access.reissued`
in the same transaction (`index.ts:62`, `:168-178`). It is not instant, and the
UI now says so in as many words (`AgreementView.jsx:254-259`). It replaces
*access*; it does not change who the record says was invited.

**Re-invite: create a second contract.** Nothing links the two. The new
agreement's chain starts at its own acceptance; the abandoned one is either
deleted (leaving nothing) or left in `AWAITING_ACCEPTANCE` for ever, where it
sits in "In progress" with "Waiting on your client" and no indication that it is
abandoned — which is also a §1 problem.

### 2.6 The tension that has to be named

> **Today there is no product path that keeps the agreement and its record and
> also stops the wrong link now.**

Delete the draft and the wrong link dies — and so does every trace that an offer
was ever made to the wrong person. Keep the contract and the mistake is
preserved in a mutable column that no event references, while the wrong link
stays usable until it is used or the 72 hours run out.

Stated that precisely on Codex's correction, because the absolute version is
false in two ways. Waiting is a real third path: the expiry is enforced inside
the acceptance RPC (`20260929000100_guest_token_uuid.sql:71-72`), so the link
*does* die by itself, with the record intact — it just does not die now, and
nothing stops the wrong person accepting in the meantime. And the blocker is
not that there is nowhere to write (§2.4): it is that the two things wanted here
— appending evidence to this agreement, and invalidating the credential already
handed out — have no single writer, and doing them in either order through
existing paths fails. Append first and the contract becomes undeletable; delete
first and there is nothing left to append to.

`Decisions.md:193-200` already accepts the first horn explicitly ("a
counterparty who was sent a link, opened it, and had not yet accepted gets a 404
indistinguishable from a mistyped URL, and nothing anywhere records that an
offer was made"), and flags it to be revisited "when a real second party is
confused by it". Kenji's direction of 09:28 rejects that horn on principle:
records are what this system is for. That is a change of position, and it has a
concrete consequence — **the preferred option cannot be built as a UI change,
because the record it wants to append to does not exist yet.**

---

## 3. What is already planned elsewhere

| Source | Item | Bearing on this |
| --- | --- | --- |
| `Roadmap.md` §3 item 9 | "Deadline handling — deadlines are stored and bound into the snapshot; nothing acts on them" | §1.4 is this item, scoped to display only |
| `Roadmap.md` §4 item 1 | "Withdraw before acceptance — decided 2026-09-25, not implemented. Needs `derive_contract_state()` to project the withdrawal" | the primitive the wrong-email case wants |
| `Roadmap.md` §1 state machine | Renegotiation, pause/resume, admin override are **deliberately excluded**; "re-scoping is a new agreement" | an option that adds a correction *state* is off-strategy; an option that appends an *event* is not |
| `Decisions.md` [2026-09-29] | withdrawal splits into pre/post acceptance; only the pre half is in scope; the blocker is that "was the link sent" is not knowable server-side, since `invite_token` exists from row creation and copying is client-side | the strongest argument against auto-recording an invitation at creation time |
| `Decisions.md` [2026-09-26] §1 | `hirer_email` is self-asserted; the only accurate claim is "someone possessing the invitation capability claimed email X" | any new wording about addresses must not exceed this |
| `HANDOFF.md` Open Decisions | "Whether creation should be an event" — open | §2.4; the preferred option forces this decision |
| `HANDOFF.md` Open Decisions | `hirer_email` case-sensitivity vs the RLS `=` comparison, unrepairable by normalising | adjacent; do not conflate with this proposal |
| `HANDOFF.md` Open Decisions | `AgreementView` has three near-identical textarea/confirm blocks, deferred | a fourth would make it four |

---

## 4. Options

Two independent decisions. Both lists are ranked smallest first.

### 4A — "Stuck, waiting on whom, since when"

**A1 — Render what is already loaded. Effort S. No migration. Honest.**

Entirely client-side, no new writer, no new semantics, no schema change:

1. Return `since` from `nextActionFor` and render it. `created_at` for
   `AWAITING_ACCEPTANCE`, `last_performance_at` for `AWAITING_CONFIRMATION` and
   for correction-requested — **both already in the row objects**, the latter
   currently dead (`contracts.js:144`).
2. Add `'dod.consent_recorded'` to the `.in()` filter in `withLatestPerformance`
   (`contracts.js:132`) for "accepted since" on `TERMS_ACCEPTED`. One element,
   same single query.
3. Add `guest_access_token_expires_at` to the `listContracts` select
   (`contracts.js:105`) and show the counterparty's access expiry on the owner's
   detail screen. Already granted and RLS-visible.
4. Show the invite expiry as a date at all times, not only inside 24 hours, and
   keep the wording about the *link* distinct from the deadline
   (`contractStatus.js:133-151`).
5. Mark a passed `deadline` as passed, stating it as a fact about the agreed date
   and **not** as a protocol consequence, since nothing acts on it. Use
   `formatDeadline` on the detail screen too, replacing the raw interpolation at
   `AgreementView.jsx:205`.

Honesty: strong. Every value is a server timestamp already on the row, and the
three clocks get three different sentences. Risk: the usual one for relative
times — "3 days ago" computed in the browser against a server timestamp. Say the
date alongside it.

**A2 — One "waiting on" line, computed once, shown on both screens. Effort M.
No migration. Honest.**

A1, plus delete `AgreementView`'s private `waitingText` (`:167-173`) and have
the detail screen consume `nextActionFor` like the home screen does. This is the
structural fix: today two implementations describe the same agreement and only
one knows about expiry, deadlines or timestamps. `contractStatus.js` is already
pure and already tested, so the new fields come with tests cheaply. Costs more
because `AgreementView` renders for both parties and `nextActionFor`'s `'you' |
'client'` vocabulary is written from the owner's seat — the guest path needs
checking, not just wiring.

**A3 — A projected `state_since` column. Effort L. Needs a migration. Honest but
not worth it.**

Maintain a `state_since` timestamp in `project_contract_state` so "since when"
is exact for every state rather than inferred from whichever events the list
query happens to fetch. Correct, and the only option that answers "since when"
for a state with no event of its own. Against it: it denormalises a fact the
chain already proves, adds a column that can disagree with the log, and buys
nothing A1 does not for the four states that matter. **Not recommended.**

### 4B — The wrong email

Evaluated in the order Kenji asked for: the keep-the-mistake approach first.

**B1 — Record the offer and the re-send as events; never change the row.
Effort M. No migration. Honest, with one named wart.**

This is Kenji's option, in its smallest honest form. Two new server-recorded
event types written by one new Edge Function on the owner's authority, modelled
line for line on `reissue-guest-access`:

- `invite.issued` — this agreement was offered to this address.
- `invite.resent` — it was offered again, to this address. The earlier one stays
  in the chain, unaltered, as the mistake it was.

The address goes in an **underscore-prefixed, server-derived payload field**
(`_invited_recipient`, the name `acceptanceFacts` already uses,
`eventRecord.ts:77`). That is not cosmetic: `partyAssertedOnly`
(`eventRecord.ts:56-60`) strips `_` keys from caller input, so the field can
only ever be server-written, and `filterPayload`'s allowlist never carries `_`
keys (`guestEventView.ts:60-103`, enforced by a test), so the new event's own
payload is not projected to the guest.

**That is not the same as the wrong address staying private, and an earlier
draft of this document claimed it was.** `guest-contract-events` returns
`acceptance_identity.invited_recipient` as a block of its own, lifted straight
out of the acceptance payload and deliberately outside the per-event filter
(`guest-contract-events/index.ts:227,243-245`). B1 leaves the stale row, so the
acceptance snapshots the wrong address (`eventRecord.ts:77`) and the guest reads
it there and carries it in their export. A mistyped address is usually a real
third party's, and the new counterparty should not receive it — so this is an
argument for B2 over B1, not a property of B1. Whatever is built, the
projection and the export have to be checked, not just the payload allowlist.

What it needs beyond the function: an entry in `PAYLOAD_ALLOWLIST`
(`guestEventView.ts:60`) so the type renders rather than being filtered to an
unknown with an empty payload, plus a label in both `RECORD_LABELS` maps
(`AgreementView.jsx:26-49`, `GuestEvidenceView.jsx:13`). No migration: the
`events` table has **no type allowlist in the database** (checked — no check
constraint on `events.type`), and `enforce_performance_order` returns early for
any type outside the three performance names
(`20261108121000_events_require_live_contract.sql:104-107`). Appending a new
type is an Edge Function change only.

What it does **not** do, and this is the wart: it leaves
`contracts.invited_hirer_email` holding the wrong address, so the home screen
keeps showing it (`ContractsHomeView.jsx:27-36`) and, if the right person later
accepts, the acceptance event snapshots the **stale** value into
`_invited_recipient` (`eventRecord.ts:77`) — the chain would then say the
agreement was offered to the wrong address, corrected, and then accepted by
someone who was never invited. The UI could derive "current invited address"
from the latest `invite.resent`, but the acceptance snapshot cannot be derived;
it is written by `validate-invite-token` from the row.

It also does not close the wrong link. Nothing here touches `invite_token`.

**One decision it touches, and need not settle.** An `invite.issued` on every
agreement *is* "creation is an event" by another name (`HANDOFF.md` Open
Decisions), and `Decisions.md:201-207` gives the obstacle: *whether the link was
ever sent is not knowable server-side*, because the token exists from row
creation and copying is client-side. So if it is written at all it belongs on
the `onCopyInvite` path (`App.jsx:761` → `copyInviteLink`), recording an intent
to send rather than a send, and worded as such.

But it is **not** a prerequisite, and an earlier draft of this document said it
was. A correction can carry its own history: one `invite.resent` holding the old
address, the new one and the fact of the correction is a complete record of the
mistake, whether or not anything was recorded when the agreement was created.
That keeps the permanent-event-type decision out of a UX fix — which is where it
belongs.

**B2 — B1, plus the row and the token, in one transaction. Effort M–L. Needs a
migration. Honest, and the only option that also closes the wrong link.**

B1, with the new function also writing, inside a single `SECURITY DEFINER` RPC
exactly as `reissue_guest_access` does:

- `invited_hirer_email` ← the corrected address (so screen and chain agree, and
  a later acceptance snapshots the right value);
- `invite_token` ← a fresh UUID, `invite_token_expires_at` ← `now() + 72h` (so
  the link that went to the wrong person **stops working**);
- the `invite.resent` event, carrying both the previous and the new address as
  server-derived fields.

The migration is the RPC, and it is additive and droppable. The *event* is not
reversible and nothing here should suggest it is: `no_update_events` and
`no_delete_events` discard both (`20260313000000_events_table.sql:129-133`), so
a wrong correction can only be answered by appending another one.

Four things to get right, none of which the existing guards do for you:

- **The predicate must be checked under a row lock, not before it.** This is the
  lesson Task 2 and Task 3 already paid for: `select … for update` the contract
  row first, then test owner, `state = 'AWAITING_ACCEPTANCE'` and
  `invite_token_used_at is null`, then write. A pre-check in the Edge Function
  races the acceptance RPC, which takes the same lock
  (`20260929000100_guest_token_uuid.sql:59-62`). Under the lock the two orders
  are both safe: acceptance first makes the correction refuse as already
  accepted, correction first leaves the old token unable to resolve a contract,
  and an acceptance built against the pre-correction row fails the existing
  `row_version`/`xmin` check (`:75-86`).
- **It is not the DELETE predicate.** `owner_delete_unaccepted_draft` also
  requires *no events*, and B2 must not copy that clause: an unaccepted
  agreement that already carries evidence is exactly the case B2 has to serve.
- `freeze_accepted_terms` will not stop this function from rewriting
  `invited_hirer_email` on an **accepted** agreement (§2.3), which would
  contradict a hashed `_invited_recipient`. The state test above is what
  prevents that — and it is a property of *this writer*, not a database
  guarantee about identity columns in general. Post-acceptance, the answer stays
  `reissue-guest-access` plus the existing mismatch banner.
- Rotating `invite_token` invalidates every copy of the old link, including one
  already sent to the right person. The UI must say that, in the register
  `AgreementView.jsx:254-259` already uses for reissue.

**B3 — Change nothing in code; write down the manual path. Effort S. No
migration. Honest, and does not meet the brief.**

Before acceptance: delete the draft (`ContractsHomeView.jsx:86-110`) and create a
new contract with the right address. After acceptance: leave it — the mismatch
banner (`AgreementView.jsx:270-277`) already shows invited-vs-claimed, and the
acceptance event already records both. This is the status quo
(`Decisions.md:191-192`) and the only work is a HANDOFF line and perhaps a
sentence next to Delete draft.

It is listed because it is genuinely cheapest and because "a slightly tedious
human path is OK" is in the brief. It is listed **last** because it is the one
option that resolves §2.6 by destroying the record, which is the opposite of the
instruction given at 09:28.

---

## 5. Recommendation

**Do A1 now. Do not do A3. Decide 4B separately, and if it is built, build B2.**

**A1 is a pure win and should not wait for anything.** It is client-only, adds
no concepts, removes none, and most of it is rendering values the browser has
already fetched and thrown away — `last_performance_at` has been computed for
every contract in every list load and read by nothing. It also closes the only
§1 gap that can mislead rather than merely omit: three different clocks
currently share one visual vocabulary, and the one that is *agreed and
tamper-evident* (the deadline) is the one with no behaviour behind it. A2 is the
right structural end state and is worth doing the next time `AgreementView` is
open for another reason; splitting it out is not worth a dedicated pass.

**On the wrong email, B2 — not B1 — if anything is built.** B1 is the smaller
change and I do not recommend it, for one reason: it leaves the row disagreeing
with the chain, and if the corrected counterparty then accepts, the chain
records that the agreement was offered to someone else and accepted by a person
who appears in no invitation. A record that is wrong in a *new* way is a worse
outcome than a record that is merely thin, in a product whose only claim is the
record. B1's attraction is that it needs no migration; B2's extra cost over B1 is
one `SECURITY DEFINER` RPC closely modelled on one that already exists and was
reviewed, which is the cheapest migration this project writes.

B2 is also the only option that resolves §2.6 rather than choosing a horn of it:
the mistake is kept *and* the wrong link stops working. That is what makes it
worth more than its extra cost.

**But I do not recommend scheduling B2 yet, and this is the part I would argue
for.** Three reasons:

1. **No real transaction has hit this.** `Decisions.md` [2026-09-29] put the
   same question down with "revisit when a real second party is confused by it",
   and the project's own method (`Roadmap.md` §4.2, `Decisions.md`) is real
   transaction → real friction → smallest justified generalisation. The
   wrong-email case is currently reasoned, not observed.
2. **The frequency data is unmeasured and the one banner that touches this is
   firing constantly on nothing.** `invited_hirer_email ≠ hirer_email` holds on
   723 of production's 859 accepted contracts — but all of it is QA data, where
   the harness invites `harness-guest@example.invalid` and accepts as something
   else (`scripts/api-e2e.mjs:84`). So `AgreementView`'s mismatch banner would
   show on 84% of accepted agreements in the database, and the real-world rate
   is simply unknown. Worth knowing before building a flow around it.
3. **It adds a permanent event type.** `events` cannot be updated or deleted
   (`20260313000000_events_table.sql:129-133`), so `invite.resent` is a
   vocabulary commitment for the life of the product, read by the guest
   projection and both exports. That deserves its own decision rather than
   arriving inside a UX fix. It does *not* require settling "should creation be
   an event" — see B1 — but it is the same class of choice.

So: **ship A1; adopt the keep-the-mistake stance now in the documents** — stop
recording "delete the draft is the whole answer" as the intended path, since the
owner has said records matter more — and hold B2 as the specified, costed shape
to build the first time a real invitation goes to the wrong person. If Kenji
would rather have it before that happens, B2 is the one to build, and B1 should
not be built as a stepping stone to it.

---

## 6. What the review changed

Codex reviewed the first draft (2026-11-08, static review of the working tree;
it ran no queries and did not re-verify the live catalogue readings, so those
remain this document's own measurements). It confirmed the three load-bearing
findings — no client `UPDATE` path on `contracts`, neither email column inside
the agreement snapshot, `last_performance_at` fetched and unread — and the
`HANDOFF.md` error in §2.4. It found four things wrong:

1. **The B1 privacy claim was false**, and it was the claim most likely to be
   acted on. `guest-contract-events` returns `acceptance_identity.invited_recipient`
   as its own block, outside the per-event payload filter the argument rested on
   (`index.ts:227,243-245`). Verified and rewritten in B1; it now argues *for*
   B2 instead of being a feature of B1.
2. **§2.6 was overstated.** Natural expiry is a real keep-the-record path, and
   the obstacle is not that there is nowhere to append — `contract.initiated` is
   already allowed on an unaccepted agreement. Both narrowed.
3. **"Additive and reversible" was wrong about the event**, which no rule can
   reverse, as opposed to the RPC, which can be dropped. Split.
4. **B2's predicate is not the DELETE predicate** (that one also requires no
   events, which B2 must not copy), and the state test has to happen *under the
   row lock*, not as an Edge-side pre-check — the same lesson as Task 2/3, since
   the acceptance RPC takes the same lock. B2 now specifies both, plus the two
   orders it makes safe.

Two smaller corrections: §2.1's "sends nothing" now excludes sign-in mail
(`earnerAuth.js:146`), and A1 now says what a null `last_performance_at` means.

**What the review deliberately does not grant:** it is a verdict on a proposal,
not approval of an unimplemented RPC. Its named conditions for a later
implementation review are both orders of correction-vs-acceptance, rejection of
the old token, rollback when the event write fails, refusal after acceptance,
repeated corrections, and non-disclosure of the wrong address to the guest
through every projection — including the export.
