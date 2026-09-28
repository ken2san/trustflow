# TrustFlow — Architecture Decisions

_Last updated: 2026-09-29_

> This file records significant design decisions and the reasoning behind them.
> AI agents must read this before proposing changes to established patterns.
> Do not reverse a decision without explicit user instruction.
>
> A decision here is not evidence that the thing is built. Several older entries
> are annotated with a status line saying what the implementation actually does;
> `Protocol.md` describes the implemented protocol and `HANDOFF.md` the current
> operational state.

---

## Open Questions — recorded, deliberately not acted on

### [2026-09-27] — What trust means here, and what "Client email" is for

**Status**: a design conversation, not a decision to implement anything. Two
concrete things came out of it and are recorded below; nothing else should be
built from this entry without a separate, later decision.

**The core reframe**: if payment management is abandoned entirely (money
already moves outside TrustFlow — see the Stripe Connect entry below), what is
left is exactly one thing: a tamper-evident record of what a pseudonymous
identifier — an email address, nothing more — has agreed to and done in the
past, independent of the real person's name, age, or relationship to anyone.
That is not a missing feature; per Roadmap.md's own mission statement, it is
the whole point. The email address is the unit trust accumulates on, which is
also why a party has a live incentive to keep reusing the same one rather than
treating each transaction as truly disposable — the disposable *account
overhead* (no password, no signup) and the non-disposable *identity underneath
it* are deliberately different things.

**Identity succession — possible to record, impossible to detect.** The same
identifier can end up controlled by a different real person over time (the
inbox is sold, handed off, or compromised) — structurally the same problem as
a game account being sold, a business's 屋号 changing hands, or a verified
X/YouTube account changing who is actually posting. Two honest conclusions,
not to be conflated:

- A **voluntary, disclosed** succession is cheap to support if ever wanted: one
  new party-writable event (e.g. `identity.succeeded`), the outgoing holder
  attesting "as of time T, this identifier passes to someone else." Same
  shape as every other event in this system.
- A **silent** takeover cannot be detected from here, and no system anywhere
  reliably solves this (verified social accounts get sold and hijacked
  constantly). The honest response is not detection — it's not pretending the
  problem is solved, and making honest disclosure the easy path rather than
  building surveillance to catch the dishonest one.

**Abuse potential, assessed and currently low.** Could this be used to lend a
false air of legitimacy to a bad-faith recruitment (the pattern known in Japan
as 闇バイト)? The core mechanism is actually poorly suited to it — an
append-only, tamper-evident record is close to the opposite of what that kind
of coordination wants, which is deniability. The more realistic risk is the
platform's trust *signal* being used as a legitimacy prop for a pitch whose
real instructions live elsewhere, off-platform entirely — but that is a
generic risk shared by every reputation system (Upwork, LinkedIn, a bank's
"verified" badge included), not something content moderation would catch, and
not something the current BYOC-only, single-operator, no-stranger-discovery
shape of the product actually exposes yet. Worth real design attention only if
this ever opens to strangers finding each other.

**"Client email" (`invited_hirer_email`) stays required, not made optional.**
It was tempting to make it optional — nothing in the app uses it for delivery,
the link is copy-pasted through whatever channel regardless. But the field
earns its place a different way: asking for it up front is the natural first
step before starting real work anyway, and asking for it *deliberately* — a
human choosing to hand over the identifier that is about to become their
signature — is a stronger moment than a stranger picking whatever address
occurs to them at acceptance time with no prior commitment. Required stays
required. Revisit this if a real workflow shows up where the sender genuinely
cannot know who will open the link (e.g. a QR code posted somewhere, forwarded
through an unknown chain) — that shape does not exist yet.

---

### [2026-09-29] — An agreement cannot be called off, and CANCELLED is unreachable

**Status**: partly decided on 2026-09-25, and **not implemented**.

**What was decided**: the question splits, and only the uncontested half is in
scope. Withdrawing an invitation that has **not** been accepted is a party
retracting an offer nobody has yet relied on, and it is the case that actually
occurs — a mistyped address, a client who never answers. That may be built.

**What remains undecided**: whether a party may void an agreement the other side
has **accepted**. Nothing below approves a design for that, and the reasoning
that follows is why it is still open.

**Not built yet.** Projecting a withdrawal into the contract state means
changing `derive_contract_state()`. The reason for the delay has changed: the
deploy backlog that originally blocked it is applied and both projects are
reachable, so what remains is simply that the work has not been done.

Three facts, each confirmed in code:

1. `AgreementView` — the screen every database-backed agreement uses — is never
   given a cancel action. Cancellation exists only on the legacy mock
   `ContractView`, reachable through the command-palette entries already
   labelled "(legacy)".
2. `log-event` accepts `contract.cancelled` from a party, but
   `derive_contract_state()` projects only `performance.asserted`,
   `performance.accepted` and `performance.rejected`. A cancellation event would
   be recorded and the contract's state would never move.
3. The only writer of `state = 'CANCELLED'` is `cancel-payment`, which nothing
   in `src/` calls. Meanwhile `contractStatus.js` carries a full presentation for
   `CANCELLED` — a label, terminal handling, a progress reading. **The product
   renders a state it can never enter.**

**The undecided question is not plumbing.** It is whether one party may
unilaterally void an agreement the other accepted. TrustFlow's whole stance is
that a party's assertion is not a fact, so "cancelled" asserted by one side sits
awkwardly beside `performance.asserted`, which is deliberately *not* treated as
"delivered". Plausible readings — a unilateral withdrawal before performance, a
request the other side must answer, or a mutual release needing both — produce
different evidence, not just different buttons.

Do not record that any of these is the chosen model. Do not wire a cancel button
before the semantics are decided, because the event it writes is permanent.

---

### [2026-09-26] — What TrustFlow actually knows about the guest, and what it does not

**Status**: Facts about the current implementation, plus unresolved identity
questions. **No recovery mechanism has been chosen, and none is implemented.**
Nothing below approves a design.

#### 1. `hirer_email` is self-asserted

At invite acceptance, `validate-invite-token` format-validates the submitted
`hirer_email` and stores it. **Nothing proves the accepting party controls that
address.** The invitation was *sent* to `invited_hirer_email`, but the guest may
type any address when accepting — the two are recorded separately precisely
because they can differ.

The strongest accurate statement the current system supports is therefore:

> Someone possessing the invitation capability claimed email X and accepted
> agreement H at time T.

Do **not** describe this, in code, comments, UI copy or exported evidence, as:

> X accepted the agreement.

The evidence chain reflects this already: the guest actor is recorded as
`guest:<claimed email>`.

#### 2. Evidence viewing and protocol action are distinct authorities

These are two different capabilities and must stay separable:

| | Evidence viewing | Protocol action |
|---|---|---|
| Effect | Read-only, idempotent | Alters protocol position, appends attested evidence |
| Nature | Retrieval of an existing record | Creation of new record with legal weight |

**Recovering one must never automatically confer the other.** A mechanism that
restores the ability to read a historical record is not thereby a mechanism to
emit new assertions, acceptances or rejections on a live agreement.

#### 3. Later email verification must not rewrite the meaning of the acceptance

This is the subtlest point here and the easiest to lose.

If at some later time T2 a person proves control of `X@example.com` via OTP, the
system then knows one additional fact:

> At T2, an authenticated actor demonstrated control of X@example.com.

That is **not** proof that the same person possessed the invitation and accepted
the agreement at T1. Email control at T2 says nothing about who held a link at
T1. The two remain separate facts and must be recorded, displayed and reasoned
about separately.

Specifically, do not allow this reinterpretation to happen silently:

> *"the invite holder claimed X at T1"* → *"the verified owner of X performed the
> T1 acceptance"*

A future verification step may legitimately add a new attested fact. It may not
retroactively strengthen an existing one.

#### 4. Architectural facts discovered in the code

Observed while reviewing, recorded because they are currently implicit:

- The **event** read policy (`party_read_contract_events`) already recognises a
  JWT whose email matches `contracts.hirer_email`.
- The **contract** read policy (`parties_read_own_contracts`) relies on
  `hirer_user_id`, not on email.
- `contracts.hirer_user_id` exists and is referenced by that policy and by
  `_shared/partyAuth.ts`, but **nothing populates it**. It was renamed from
  `counterparty_id` in `20260921000000`.
- `log-event` resolves a JWT only against `earner_user_id`, so an authenticated
  user who merely matches `hirer_email` is **not** granted guest protocol-action
  authority.

Taken together, the architecture already contains a **partial separation between
durable identity binding, evidence reading, and protocol action authority**.
That separation is currently incidental rather than designed, which is why it is
written down here — a future change could erase it without anyone noticing.

`hirer_user_id` is an existing architectural affordance found in the code. It is
**not** an approved recovery mechanism.

#### 5. Unresolved product and security questions

- Whether later verified control of a self-asserted email is sufficient to grant
  durable read-only access to historical records associated with that claimed
  email.
- Whether guest recovery should notify the agreement owner.
- Whether future invite acceptance should verify email ownership at acceptance
  time. This would materially strengthen actor attribution, at the cost of
  adding a step to the acceptance screen, and is a larger question than recovery
  itself.
- Whether losing access to the original email address should have any fallback.
- Custom SMTP remains a prerequisite for dependable OTP-based recovery; the
  built-in mailer caps sends at a few per hour.

---


### [2026-09-26] — Performance that unfolds across several real-world steps

**Status**: Recorded for later inspection. **No implementation. No schema,
vocabulary, or UI change was made from this.**

**The case**: the first real TrustFlow transaction is a professional certified
translation. It is not obviously a single "digital file delivered → customer
accepts" exchange. Depending on the deal it may involve preparing the certified
translation, delivering a digital version, certification/stamp/seal
requirements, preparing a physical certified copy, how the source document is
treated or attached, physical shipment, and eventual physical receipt.

**Do not encode those particular steps.** They are transaction-specific. The
general question they raise is:

> What happens when an agreement has several promised outcomes, and the
> transaction cannot honestly be described by one instantaneous
> "Mark as delivered"?

The performer may be able to say truthfully *"the certified PDF is ready and
sent"* while being unable to say truthfully *"everything promised is complete"*.
Later they may truthfully say *"the package has shipped"* — which is not the
same fact as the customer having received it.

**Why this is an Evidence Core question, not a features question.** The steps
above are different KINDS of evidence, and the existing distinction must not be
collapsed into a single stronger claim than the evidence supports:

| Statement | Kind |
|---|---|
| Performer: "I shipped it." | party assertion |
| Receiver: "I received it." | counterparty statement |
| Carrier API: "Delivered 14:32." | external/system observation |
| "The translation is correct and complete." | world fact TrustFlow cannot establish |

**The question to answer when we return** — by inspecting the implementation as
it exists at that time, not from this note:

> Can the `performance.asserted → accepted/rejected` model represent this
> naturally without making the product cumbersome?

Do not assume the answer is no. Any of these may turn out to be sufficient:
clear enough agreement terms; repeated assertions; a small vocabulary change;
lightweight deliverables or checkpoints; a genuinely justified commitment
concept; or a separate mechanism for external observations.

**Do not pre-emptively build**: a Commitment table, a deliverables framework,
milestones, workflow builders, shipment tracking, project management, a
generalised state machine, or an Exchange Socket. This is evidence for a future
design decision, not a specification.

**The method this illustrates**, and which should govern how TrustFlow evolves:

> real transaction → real friction → inspect the existing model → decide whether
> the friction is specific or general → make the smallest justified
> generalisation

The certified-translation job is simply the first concrete case showing that
real-world performance may unfold across several events rather than one digital
delivery.

---

## Decision Log

### [2026-09-29] — An export is built from rows that can be re-verified

**Invariant**: an evidence export is always built from the raw `events` rows, never
from the shaped view a screen is rendering. A document built from shaped events
would recompute each payload hash over a payload the UI had already filtered or
truncated, and report every untouched event as tampered with. **An evidence
export that falsely cries tampering is worse than no export at all.**

**Context**: `downloadAuditTrail()` has existed since early on but was reachable
only from the legacy five-step mock flow — `DisputeModal` and `ContractStep5`.
No database-backed agreement could produce one, so the single artefact TrustFlow
promises — a self-contained record a third party can verify without us — was not
obtainable by anyone actually using the product. `AgreementView` now offers it.

**Consequences future work must not undo**:

- The handler re-fetches with `fetchContractEvents()` rather than exporting
  `agreement.events`, which has been through `shapeOwnerEvents` and carries no
  hashes and reduced payloads. Wiring the export to the screen's own array is
  the obvious-looking change and is the one that breaks it.
- An empty result raises instead of producing a document. A record with nothing
  in it still looks like a signed record.
- **Only the owning account is offered the export.** A guest has no `auth.users`
  row, so RLS returns them nothing from `events`; their trail arrives already
  shaped from `guest-contract-events`. Offering them a button would produce
  either an empty document or an unverifiable one.

**Resolved 2026-09-25**: the guest now has an export. It is a different
document, not a widened version of this one — see "Two records, two things they
can claim".

---

### [2026-09-28] — Acceptance and its evidence commit together

**Invariant**: TrustFlow never records that an agreement was accepted unless the
authoritative acceptance evidence for that exact agreement — the canonical v4
event carrying the agreement snapshot, the invited recipient, the claimed
identity and the authentication method — was durably written in the same
database transaction. Neither can exist without the other.

**Context**: accepting an invitation was two independent requests.
`validate-invite-token` consumed the one-time invite and moved the contract to
`TERMS_ACCEPTED`; the browser then called `log-event` to write
`dod.consent_recorded`. Anything failing in between — a dropped connection, a
closed tab, a rejected CORS preflight — left a contract that was accepted with
no record of what had been accepted. That was tolerable while the acceptance
event added little the contract row did not already hold. It stopped being
tolerable on 2026-09-27, when the acceptance event became the only place the
agreed deal is preserved: its absence is now the absence of the evidence, not of
a log line.

**Where the boundary was drawn**: the transaction covers the invite validity
check, the single-use consumption, the state transition, the claimed identity,
the guest access credential, and the acceptance event with its snapshot, hashes
and chain link. The guest credential is inside it for free — it is a column on
the same row — but the load-bearing pair is the accepted state and the evidence.

**Why a SQL function and not SQL-side hashing**: the event hash is computed in
Deno over the canonical defined once in `_shared/eventCanonical.ts`.
Recomputing it in plpgsql would create a second implementation of that
canonical, which is exactly the drift that produced this project's one
production bug. So the hash stays in one place and the database is given only
the job it is uniquely good at — committing several writes or none.
`invite_acceptance_context()` reads the terms, the chain tip and an opaque row
version; the Edge Function builds and hashes; `accept_invitation()` re-checks
all three under a row lock and commits.

**Consequences that future work must not undo**:

- **`dod.consent_recorded` is no longer writable by a party.** `log-event`
  refuses it with `type_is_server_recorded`. A guest who could append a second
  acceptance could record a snapshot taken at a different moment, leaving two
  records and no rule for which is the agreement. Existing rows are untouched
  and verify exactly as before.
- **The client must never regain a second call on this path.** Correctness may
  not depend on the browser completing a follow-up request; a test asserts that
  nothing reaches `log-event` during acceptance.
- **The row lock is what makes concurrency safe.** `select … for update` in
  `accept_invitation` serializes concurrent accepts of one invitation. The
  previous conditional update guarded the contract row but not the event, so two
  racing accepts could each have gone on to append their own acceptance.
- **Evidence must not come to depend on the transaction succeeding quietly.**
  A refused acceptance returns a status before anything is written; a failed one
  raises and rolls back. There is no ordering that writes one half.

**Known limit, not fixed here**: a client that loses the response to a
successful acceptance cannot retry. The invitation is spent, so the retry gets
`already_used`, and the guest access credential issued to the first attempt is
lost with the response. Re-issuing it on demand would let anyone holding the
invite token mint a credential, so it is a recovery problem rather than an
atomicity one, and guest recovery remains unaddressed.

---

### [2026-09-27] — Three things an agreement record holds, kept apart

**Decision**: An acceptance binds a deterministic **agreement snapshot**, not
just the completion criteria. The snapshot, the **acceptance evidence** and the
**mutable protocol state** are three separate things and must not be merged.

**Context**: Until canonical v3, `dod_hash` was the only agreement reference an
event carried. It covers `dod` and nothing else, so TrustFlow could prove which
completion criteria an acceptance referred to while being unable to detect a
later change to the price, the deadline or which side performs. For a product
whose whole claim is transaction evidence, that is a defect in the core, not a
missing feature.

**The distinction**, now authoritative in code:

1. **Agreement snapshot** — *what was agreed*. Built by
   `buildAgreementSnapshot()` in `supabase/functions/_shared/eventCanonical.ts`
   from server-trusted contract data: `project_name`, `dod`, `amount`,
   `currency`, `deadline`, `performed_by`, `offered_by`, plus its own
   `snapshot_version`. The test for membership is semantic, not structural:
   *would a reasonable participant say they agreed to a different deal if this
   field differed?* Database ids, protocol `state`, tokens, internal timestamps
   and Stripe columns all fail that test and are excluded — binding them would
   make an ordinary state transition look like a changed agreement.
2. **Acceptance evidence** — *who accepted, with what authority, and what they
   claimed*. Recorded in the acceptance event's payload as `_invited_recipient`
   (who the invitation was addressed to), `_claimed_identity` (the address the
   accepting party gave), `_claimed_identity_verified` (always `false` today)
   and `_auth_method` (`invite_capability` for a guest). These are deliberately
   separate fields: an invitation can legitimately be forwarded, the divergence
   is itself evidence, and neither address has ever been verified.
3. **Mutable protocol state** — *where the transaction currently is*. Lives on
   the `contracts` row and must keep changing. It is not evidence of anything
   that was agreed.

**Canonical v4** adds `agreement_hash` to the hashed event. Versions are
permanent: a v1, v2 or v3 row is verified forever under the rules that created
it, and the arrival of v4 does not reinterpret it. `bindsWholeAgreement()` and
the `binds_whole_agreement` flag in the guest trail and the audit export say
which rows bind the whole deal and which bind only the criteria, so a reader is
never left assuming the newer rule applied throughout.

**The snapshot is embedded as well as hashed.** A hash proves that content
matches; it cannot reproduce content that has since changed. The acceptance
event therefore carries the snapshot itself, which is what lets TrustFlow *show*
the accepted terms years later without consulting the contract row.

**Two independent protections, not one.** The evidence stands on its own. The
`contracts_freeze_accepted_terms` trigger, added alongside it, refuses a change
to an agreed term once the contract is past `DRAFTING`/`AWAITING_ACCEPTANCE`,
including from a privileged role. It is defence in depth, deliberately
term-specific so that protocol state can still move. **Do not let a future
change make the evidence depend on that trigger** — a mutation that somehow
occurs must leave the historical record intact and detectable, which is why
`guest-contract-events` reports `terms_changed_since_acceptance` by re-deriving
the snapshot from the current row rather than by trusting it.

**The server owns its own namespace.** `log-event` strips underscore-prefixed
keys from any client-supplied payload. Everything under one is a fact TrustFlow
derived; a caller could never forge `agreement_hash`, but without this it could
leave a reader looking at terms nobody agreed to.

**Known gap, not fixed here**: the acceptance *evidence* is a second write. The
browser calls `validate-invite-token` (which consumes the invitation and moves
the contract to `TERMS_ACCEPTED`) and then calls `log-event` to record
`dod.consent_recorded`. If the second call fails, the contract is accepted with
no acceptance event, and therefore no agreement snapshot — the UI warns the
user, but the evidence is simply absent. Making acceptance and its record a
single server-side act is the obvious repair and has not been done.

---

### [2026-09-25] — Two records, two things they can claim

**Decision**: both parties can export the record, and they are given **different
documents**. The owner gets the self-contained, re-verifiable audit trail
(`auditExport.js`). The counterparty gets a **server-verified record**
(`guestRecordExport.js`) that reports what TrustFlow checked and does not invite
the reader to recompute anything.

**Context**: the guest is the party who most needs the record and was the only
one unable to obtain it. The obvious repair — hand them the same document — is
the one that breaks: a guest has no `auth.users` row, so their trail arrives
from `guest-contract-events` with every payload allowlist-filtered. A document
instructing its reader to recompute each hash would mismatch on **every
untouched event**, and an export that falsely cries tampering is worse than no
export at all.

**The alternative considered and rejected**: widening what the guest may see so
their document could be re-verified like the owner's. Rejected for now because
it moves an access-control boundary that exists deliberately, to solve a problem
that does not require moving it.

**What makes the guest document honest**:

- It is named `trustflow_counterparty_record`, never `trustflow_audit_trail`, so
  the two cannot be confused by a reader or by a future code path.
- The verdicts are the server's, carried through untouched. The client only
  names the *reason* for a verdict from the same per-event results.
- It states in the document that its results **cannot be reproduced from the
  file**, and why. The absence of verification instructions is not a statement a
  reader will notice.
- `truncated` is surfaced: if the record was cut short, the absence of an event
  means nothing.
- A record with no events raises instead of producing a document, exactly as the
  owner's export does.
- A chain with nothing server-attested reports `NOT_SERVER_ATTESTED`, not
  "unverified" — there was never an attestation to check, which is a different
  statement.

**Consequences future work must not undo**: do not converge these two documents.
The damaging regression is not a missing button, it is a guest handed the
owner's document — one that would cry tampering on an intact record.

---


### [2026-05-27] — Payment rail: Stripe Connect (no internal payment token)

**Status: decided, not built.** Nothing in the live flow opens `PaymentModal`,
`VITE_STRIPE_PUBLISHABLE_KEY` is unset, and money moves outside TrustFlow. The
three payment Edge Functions are deployed but unreachable from the app. This
decision is not reversed — it is what should be implemented when payment is
wired — and `SETTLED` being unreachable is a direct consequence of it being
unbuilt.

**A marker for whenever this is picked back up (2026-09-27):** every security
posture built so far — the email mismatch surfaced rather than blocked,
identity succession left disclosable rather than preventable, payment left as
an unverified party assertion — shares one shape: *record, don't gatekeep*,
because TrustFlow has neither the authority nor the information to gatekeep
honestly. That shape is only correct as long as nothing is actually held.
Wiring Stripe Connect is the one place it must be abandoned on purpose: real
escrow means blocking and holding in the moment, not attesting after the fact.
Treat that as a genuinely different category of engineering from everything
built so far, not an extension of it — the day this is built is the day the
"record, don't block" posture gets its one deliberate exception.

**Decision**: All contract payments flow through Stripe Connect. TrustFlow never holds funds. The platform account holds payments and transfers to Earner's Connected Account on DoD confirmation.

**Context**: Internal payment token ("deposit PTS and exchange for cash") would require 資金移動業 or 前払式支払手段 registration under Japanese payment law. Stripe is already a licensed 資金移動業 operator.

**Alternatives considered**:

- Stripe manual capture — rejected: 7-day auth hold limit makes it unsuitable for long contracts
- Immediate capture + platform balance — selected: funds sit in Stripe platform account; Transfer issued at completion. No hold expiry.
- Internal escrow token — rejected: regulatory registration required

**Consequences**:

- `supabase/functions/create-payment-intent` must be deployed before payment flows work
- `VITE_STRIPE_PUBLISHABLE_KEY` must be set in `.env`
- Contract amounts are in JPY integers (Stripe uses smallest currency unit = 円 = no subunit)

---

### [2026-05-27] — Reputation layer: TrustPoints (non-redeemable)

**Status: not part of the evidence core, and not on the DB-backed flow.**
`src/lib/trustpoints.js`, `WalletView` and `ProfileModal` operate on local mock
profile state; the `trustpoints_ledger` table exists in migrations but nothing in
`src/` writes to it. Non-redeemability stands and is binding if a reputation
layer is ever wired — it is a regulatory constraint, not a feature preference.

**Decision**: TrustPoints are a non-redeemable reputation score. They cannot be converted to cash or fiat equivalents. Earned through good behavior; spent on platform benefits (fee discounts, priority arbitration).

**Context**: Redeemable points would trigger 前払式支払手段 registration. Non-redeemable system (like airline miles) has no such requirement as long as points cannot be exchanged for legal tender.

**Alternatives considered**:

- Redeemable PTS — rejected: regulatory overhead
- Pure Trust Score (no spend mechanic) — deferred; spend mechanic adds a loop that makes score meaningful

**Consequences**:

- TrustPoints logic in `src/lib/trustpoints.js`
- Ledger persisted in Supabase `trustpoints_ledger` table (append-only)
- WalletView now shows Trust Passport (TrustPoints + Trust Score + badges) instead of fiat wallet

---

### [2026-05-27] — Counterparty onboarding: asymmetric guest model (Type 2)

**Status: partly implemented, partly superseded. Read these corrections before
the decision below.**

- **Implemented**: the counterparty needs no account; a one-time invite token
  with an expiry is consumed inside the acceptance transaction; the identity
  anchor is an email address. But that address is **self-asserted and never
  verified** — the guest-identity note under Open Questions is authoritative on
  exactly what the system may and may not claim from it.
- **"Hirer has no dispute rights in-app" no longer describes the product, and
  the offsets named for it never existed.** The counterparty reads the full
  evidence trail (`GuestEvidenceView` / `guest-contract-events`) and exports
  their own record (see the 2026-09-25 entry). When they are the receiver they
  may also record `performance.accepted` / `performance.rejected`; `log-event`'s
  role check is what grants that, and a rejection is recorded disagreement, not
  an adjudicated dispute. There is no timeout auto-refund and no escrow, because
  no money flows. **Whether a formal dispute mechanism should exist at all is
  OPEN and undesigned.**
- Stripe card data as a secondary identity does not exist; that path is unwired.
- The upgrade path — prior contracts attributed to an account created later — is
  **not implemented**. `contracts.hirer_user_id` exists and nothing populates it,
  and it is explicitly not an approved recovery mechanism.

**Decision**: The invited counterparty (Hirer) does not need a TrustFlow account. They participate via a one-time invite link: review DoD → enter email → pay via Stripe. Email address is the identity anchor.

**Context**: Requiring the Hirer to register creates friction that kills adoption. The DocuSign/HoneyBook/Bonsai pattern proves "sign/pay without account" is legally and practically accepted. The core guarantee (Stripe escrow + DoD hash) does not require both parties to be registered users.

**Trade-offs accepted**:

- Hirer earns no TrustPoints (no reputation stake) — offset by financial stake in escrow
- Hirer has no dispute rights in-app — offset by timeout auto-refund and email token access to a confirmation page
- Hirer identity is email only — offset by Stripe card data (real name / billing address) as secondary identity

**Upgrade path**: If Hirer creates a TrustFlow account later (or on next contract), all prior contracts linked by email are attributed to that account.

**Alternatives considered**:

- Full registration required for both parties — rejected: adoption barrier too high for counterparty
- Guest checkout (card only, no email) — rejected: no DoD confirmation path, no audit record, TrustFlow's core value proposition disappears

**Consequences**:

- `contracts` table needs `hirer_email` and `invite_token` (one-time, 72h expiry) fields
- Invite token must be invalidated after first use
- DoD acceptance confirmation email must be sent to Hirer's email on payment (timestamped, DoD hash included)
- Guest Hirer needs an email-token-gated confirmation page to approve DoD or trigger dispute

---

### [2026-05-27] — Threat model: guest Hirer flows

**Status: the baseline stands; three parts have since been settled by fact.**

- **T2 ("Edge Function called directly", marked ❓ Verify) was verified, and
  failed.** `send-acceptance-email` and `timestamp-event` were public and
  unauthenticated; both were deleted from Supabase on 2026-09-26. `verify_jwt` is
  on for every remaining function. Being unreachable from `src/` protects
  nothing: an Edge Function is a public HTTPS endpoint and the anon key ships in
  the bundle.
- **T1 (invite reuse) is implemented, and more strongly than written here.** The
  invitation is consumed inside `accept_invitation()` under a row lock, so
  concurrent accepts serialise.
- **H1, H2, E1 and every auto-capture / auto-refund mitigation presuppose escrow
  that is not wired.** None of them is implemented and none can be while money
  moves outside TrustFlow. Do not read "❌ MVP required" as a live to-do list.
- The **"cancel + new contract" scope-change policy** has no cancel half: there
  is no reachable cancellation. In practice an agreed term cannot change at all
  once accepted — `contracts_freeze_accepted_terms` refuses it — so a change
  means a new agreement while the old one stays open.

**Decision**: Document accepted risks, required mitigations, and deferred items for the guest Hirer architecture. This is the binding security baseline for all Type 2 implementation.

**Threats and mitigations:**

| ID  | Threat                          | Actor     | Severity  | Mitigation                                                                                     | Status          |
| --- | ------------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------- | --------------- |
| H1  | Chargeback after delivery       | Hirer     | 🔴 High   | DoD acceptance email (timestamped + DoD hash) sent on payment; used as Stripe Dispute evidence | ❌ MVP required |
| H2  | Deliberate DoD non-confirmation | Hirer     | 🔴 High   | Timeout auto-capture: N days after Earner's delivery declaration → auto-release to Earner      | ❌ MVP required |
| H3  | Retroactive scope expansion     | Hirer     | 🟡 Medium | DoD hash is immutable; additional scope = new contract                                         | ✅ Design       |
| H4  | Disposable email + chargeback   | Hirer     | 🟡 Medium | Stripe card data is real identity; disposable domain blocklist as secondary filter             | ⚠️ Partial      |
| T1  | Invite URL reuse / interception | 3rd party | 🔴 High   | Invite token is one-time + 72h expiry; used_at recorded in DB                                  | ❌ MVP required |
| T2  | Edge Function called directly   | 3rd party | 🟡 Medium | All Edge Functions require Supabase Auth; unauthenticated requests → 401                       | ❓ Verify       |
| T3  | URL parameter tampering         | 3rd party | 🟢 Low    | Amount/DoD sanitized in App.jsx BYOC parsing                                                   | ✅ Implemented  |
| E1  | Earner ghost after payment      | Earner    | 🟢 Low    | Escrow: Earner cannot receive funds until DoD confirmed or timeout                             | ✅ Design       |
| E2  | Fraudulent quality claim        | Earner    | 🟡 Medium | DoD granularity guidance in UI (acceptance criteria templates)                                 | ⚠️ UX task      |
| E3  | TrustPoints self-dealing        | Earner    | 🟢 Low    | Real Stripe payment required (fee cost) makes self-dealing economically irrational             | ✅ Design       |

**DoD scope change policy (MVP)**: Changes handled as cancel + new contract. Amendment flow deferred to Phase 4.

**Stripe fee burden policy (MVP)**: Fees absorbed by Earner (deducted from transfer amount). Must be disclosed in PaymentModal and invite page before Hirer pays.

**Delivery deadline**: ContractStep1 must include a required `deadline` field. This is the trigger reference for timeout auto-refund (deadline + grace period).

**Deferred**:

- Disposable email domain blocklist
- Earner Stripe Connect KYC state check before contract creation
- Multi-milestone guest payment flows
- Guest Hirer in-app chat (replaced by email notifications for MVP)

---

### [2026-03-14] — Timestamp integrity: Supabase Edge Function + RFC 3161 TSA

**Status (2026-09-26): superseded by removal, not by a replacement.**
`timestamp-event` was deleted from Supabase — it was a public, unauthenticated
endpoint that nothing in `src/` called — and `src/lib/tsa.js` is now imported by
nothing. **There is no external timestamping today**, and no decision has been
taken to restore it. The reasoning below still governs *how* it would have to be
done if it returns (server-side; never browser → TSA). The consequence that
matters now: with no external notary, the operator is inside the trust boundary.

**Decision**: Contract lifecycle events timestamped via the `timestamp-event` Supabase Edge Function, which calls an RFC 3161-compliant TSA (FreeTSA.org) server-side. Clients must never call the TSA directly.

**Context**: Core protocol requirement — the event log must be tamper-evident and verifiable by third parties without trusting TrustFlow servers. Direct browser → TSA calls are blocked by CORS in production environments. The Edge Function acts as a transparent proxy: it receives `{ hashHex }` from the client, forwards the DER-encoded TimeStampReq to FreeTSA, and returns the base64 token.

**Implementation (2026-05-28)**:
- `supabase/functions/timestamp-event/index.ts` — proxy function deployed to Supabase (Mumbai)
- `src/lib/tsa.js` — `requestTimestamp()` now calls Edge Function first (`isSupabaseEnabled`); falls back to direct freetsa.org call in dev mode (Node/Vite dev server, where CORS is not enforced)

**Alternatives considered**:

- Client-side timestamps — rejected; trivially forgeable
- DB `created_at` only — rejected; mutable by DB admin, not independently verifiable
- Direct browser → freetsa.org — rejected; CORS-blocked in production browsers
- On-chain timestamping — deferred to Phase 4+ (cost and complexity unjustified at prototype stage)

**Consequences**: All contract events must go through the Edge Function. `src/lib/tsa.js` handles client-side TSA interaction and selects the correct path automatically.

---

---

### [2026-03-06] — State management: App.jsx + custom hooks

**Status: still the decision, and now at its limit.** `src/App.jsx` is ~1,740
lines with two hooks extracted. Decomposing it is on the priority list in
`HANDOFF.md`; no external state library has become necessary.

**Decision**: All state centralized in `src/App.jsx`; logic exceeding ~50 lines extracted into custom hooks in `src/hooks/`. No external state library.

**Context**: Prototype-phase solo dev project. External libraries add a dependency with no benefit at current scale (<10 stores).

**Alternatives considered**:

- Zustand — rejected because it adds a dependency without solving any current problem
- Redux — rejected because overhead is unjustifiable for a prototype

**Consequences**: Simple and auditable now. If state grows beyond ~10 stores, migrate to Zustand.

---

### [2026-03-06] — Modal system: single ModalDialog component

**Decision**: All modal dialogs rendered through `src/components/ui/ModalDialog.jsx`. No ad-hoc modal markup anywhere else.

**Context**: Early development saw z-index stacking conflicts from inline modal markup. Centralizing ensures consistent backdrop, animation, and keyboard behavior.

**Alternatives considered**:

- Inline ad-hoc modal markup — rejected; caused z-index conflicts in early development
- React portals per component — rejected; harder to audit and test

**Consequences**: All modal content must flow through ModalDialog. New modal UI belongs in `src/components/modals/`.

---

_Add new decisions above this line, newest first._
