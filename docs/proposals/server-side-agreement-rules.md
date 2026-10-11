# Moving meaning to the server

**Status: proposal. Nothing in here has been applied or deployed.**
Audited 2026-10-11 against production (`fqgpzhwvvfsxswlnbbgg`, 1321 contracts,
2051 dod items) and E2E (`yqjtawffpesplqyurlpj`, 145 contracts).

## What is already enforced, and what is not

The gap is narrower than "there is no server enforcement", and the real shape of
it matters for the plan.

Already enforced, verified live:

- **Column ownership.** `state`, `invite_token`, `invite_token_expires_at`,
  `guest_access_token`, `hirer_email`, `dod_hash` and the settlement columns are
  server-owned; the client's INSERT grant on them is revoked (`20260923000000`).
  Sending one makes the whole insert 403.
- **No UPDATE at all.** `PATCH /contracts` as the owner returns
  `42501 permission denied for table contracts`. The owner cannot change their
  own row.
- **Terms frozen after acceptance.** `freeze_accepted_terms()`
  (`20260927000000`) raises on any change to `project_name`, `dod`,
  `amount_jpy`, `currency`, `deadline`, `performed_by` or
  `earner_display_name` once state has left `DRAFTING`/`AWAITING_ACCEPTANCE`.
  A `BEFORE UPDATE` trigger on the table, so even a SECURITY DEFINER path hits it.
- **No chain forks.** `events_chain_no_fork_idx`, unique on
  `(contract_id, prev_event_hash)`.
- **Idempotency.** `events_idempotency_idx`, unique on
  `(contract_id, idempotency_key)`, plus `log-event`'s read-before-write which
  returns the original with `deduplicated: true`. Verified in the harness.
- **Party roles.** `ROLE_REQUIRED` in `log-event`; the performer cannot accept
  their own performance and the receiver cannot assert it. Verified, 403 both ways.
- **Append-only events.** `DO INSTEAD NOTHING` rewrite rules.

So the single unguarded moment is **creation**. The only constraints on
`contracts` are a PK, an FK, `UNIQUE (invite_token)` and the `performed_by`
CHECK. Everything else is in the React form. Ten probes, all accepted (HTTP 201):

| probe | accepted |
|---|---|
| `deadline` 2020-01-01 | yes |
| `amount_jpy` 0 / −50000 / 2,000,000,000 | yes |
| `dod` `[]` / `"just do it"` | yes |
| `project_name` `""` | yes |
| `currency` `'ZZZ'` | yes |
| malformed address | yes |
| 10,000-character display name | yes |

And because terms are frozen at acceptance and hashed into every event, a bad
value written at creation is permanent. **The window is small and what falls
through it is irreversible.** That asymmetry is the whole argument.

## v1 rules

Implemented as `supabase/functions/_shared/agreementRules.ts` (252 lines, 29
tests). In `_shared/` deliberately: the browser already imports from there
(`eventCanonical.ts`, `trustpointsRules.ts`), and the server-side creation path
will too. One definition — a rule duplicated between a React form and an Edge
Function drifts, with the UI copy becoming the lenient one, which is exactly
today's situation.

| field | rule | basis | enforceable as CHECK |
|---|---|---|---|
| `project_name` | non-blank after trim | all 1466 rows non-empty | yes |
| | ≤ 500 chars | **UNRATIFIED** — observed max 44 | yes |
| `dod` | must be a JSON array | all 1466 are arrays | yes |
| | ≥ 1 element | no row has 0 | yes |
| | ≤ 50 elements | **UNRATIFIED** — observed max 3 | yes |
| | every element a non-blank string | all 2051 elements are | yes |
| | element ≤ 1000 chars | **UNRATIFIED** — observed max 23 | yes |
| `amount_jpy` | positive integer | all 1466 ≥ 1; column is `integer`; JPY has no minor unit | yes |
| | **no upper bound** | Trust Ladder specifies `contractLimit: null` at level 10 | n/a |
| `currency` | `'JPY'` | 1466 of 1466; column is named `amount_jpy` | yes |
| `deadline` | nullable | **957 of 1321 production rows are null** | n/a |
| | ISO `YYYY-MM-DD` | — | partially |
| | `>= current_date - 1` | see below | **no** |
| `invited_hirer_email` | nullable; permissive shape | matched 100% of existing values | yes, weakly |
| `earner_display_name` | nullable; ≤ 200 chars | **UNRATIFIED** — observed max 28 | yes |
| `performed_by` | `creator` / `counterparty` | already a CHECK | already done |

**Every rule above passes on all 1466 existing rows. No backfill, no data
repair, no exceptions list.** That is the main compatibility finding and it is
why this can be done with plain constraints rather than a migration dance.

### The two numbers we must not invent

**The amount ceiling is UNDECIDED, and an earlier draft of this document got
this wrong.** It cited `TRUST_LADDER` (`src/lib/constants.js:75-78`) — ¥100k /
¥500k / ¥2M then `contractLimit: null` at level 10 — as if that were ratified
policy, and proposed a permanent test fixing "no ceiling". It is not ratified:
`Roadmap.md:103` records "no trust ladder enforcement on the DB-backed flow"
and `:224` "no trust ladder on the real flow", and `:203` places that whole
surface in the legacy mock reachable only via command-palette entries labelled
"(legacy)". Its only consumers are `ProfileModal` (display) and
`ContractStep1` (that mock path).

Freezing "unlimited" into a test would turn a mock into a guarantee exactly as
much as adding a ceiling would invent one. So this layer enforces only the
**shape** — a positive integer — and any ceiling, flat or tiered or
per-account, is business policy, lives in the creation path against the actor's
record, and is **UNDECIDED pending your call against the product's real
history**.

**The length caps.** No prior spec sets any. The four numbers above are headroom
set an order of magnitude clear of every observed value, and they are marked
`UNRATIFIED_LIMITS` in the code for exactly that reason. They stop a
10,000-character field being hashed into a chain forever; they are not a view on
what a sensible maximum is. **Raising one later is backwards compatible; lowering
one is not** — so they start generous, and the real numbers are yours to set.

### The deadline rule is the one that cannot be a CHECK

Two independent reasons, and both would have bitten:

1. **A CHECK is re-evaluated on every later UPDATE.** `deadline >= current_date`
   would hold at creation and then fail forever afterwards: tomorrow's deadline
   becomes yesterday's, and the next state transition on that row raises. The
   rule is about *when the row is written*, which a CHECK cannot express.
2. **`current_date` is UTC on both projects** (`TimeZone = UTC`, verified). A
   user west of Greenwich is a calendar day behind it — at 00:30 UTC on the 11th
   it is 17:30 on the 10th in Vancouver, so `deadline >= current_date` refuses
   that user's *today*. This is the same off-by-one as the `toISOString()` bug
   fixed in the UI on 2026-10-11, mirrored, and worse: the server refuses the
   write instead of warning.

So: `deadline >= current_date - interval '1 day'`, checked **at creation only**,
in the creation path. One day covers UTC−12..UTC+14 (a 26-hour span) in both
directions, and costs only the ability to reject a deadline at most 24 hours
stale. Rejecting 2020-01-01 is the point; rejecting yesterday is not worth a
false refusal. Tested at the boundary, including the Vancouver case.

### Re-validation at acceptance: a decision, not an oversight

Nothing re-checks the deadline at acceptance today, and the invite lives 72
hours. So a contract created with tomorrow's deadline and accepted three days
later is accepted with a deadline already past — through the *legitimate* UI,
with no bad actor involved.

Three options, and this one is genuinely yours:

- **(a) Do nothing.** A deadline that lapsed while awaiting acceptance is a real
  situation and arguably honest to record. Zero code.
- **(b) Warn the invitee** — show "this deadline has already passed" on the
  acceptance screen and record their acceptance anyway. The record then contains
  the fact that they were told.
- **(c) Refuse acceptance.** Safest-sounding, worst outcome: it strands a real
  agreement over a date, and the owner cannot edit the row to fix it (UPDATE is
  revoked), so the only recovery is a new contract.

I would take **(b)**. It is the only one that neither hides the problem nor
destroys a real agreement, and it fits what the product already does with a
self-claimed email: record the fact and label it honestly. Not implemented.

## Deploy plan

The ordering constraint that dominates everything: **a push to `main` deploys
the frontend to production automatically; the backend never deploys
automatically.** So every phase where the UI needs something the backend does
not yet have is a repeat of the live drift described below. Backend first, every
time.

### Phase 0 — now, no deploy *(done, local commit only)*

`agreementRules.ts` + 29 tests. Zero runtime effect: nothing imports it yet.
Lets the rules be reviewed and argued about as code rather than prose.

### Phase 1 — CHECK constraints *(migration; needs approval)*

The time-invariant rules only. Draft:
`docs/proposals/20261012000000_agreement_wellformedness.sql.draft` — kept out of
`supabase/migrations/` so it cannot be applied by accident.

- Verified to pass on all 1466 rows, so it applies without `NOT VALID`.
- Rollback is `alter table contracts drop constraint …`, no data loss.
- Apply to **E2E first**, run `npm run test:api`, then production.
- Deliberately excludes the deadline rule, for the two reasons above.

### Phase 2 — the creation path *(migration + function deploy; needs approval)*

`create_contract(...)` as SECURITY DEFINER, validating everything including the
deadline floor, returning the row. Additive: the direct INSERT keeps working, so
nothing breaks and the UI is untouched. This is also the write API an agent will
use, which is why it returns **all** violations rather than the first.

### Phase 3 — the UI moves over *(push to main = production deploy)*

`src/lib/contracts.js` calls the RPC instead of inserting. Verifiable before the
push by the API harness, since the harness drives the same RPC.

### Phase 4 — revoke the direct INSERT *(migration; needs approval; LAST)*

`revoke insert on contracts from authenticated`.

**This must not happen before Phase 3 is deployed and verified**, or contract
creation breaks in production. Rollback is a re-grant, so it is reversible —
but during the gap nobody can create a contract, so it is the one step to do
deliberately and watch.

### Why CHECK constraints alone are not enough

They close seven of the ten probes and leave the one that matters most open: the
past deadline, which is the one that already shipped as a UI-only fix. They also
cannot express "all violations at once", which an agent needs. Hence Phases 2–4.

## Release gate

Two live drifts, both of which a gate would have caught before the push:

1. **Production has the re-issue UI and not the backend.** The deployed bundle
   calls `reissue-guest-access`; production's Supabase has neither the function
   nor the `reissue_guest_access` RPC nor migration `20261011000000`. Clicking
   it cannot succeed. Shipping needs: migration → function →
   re-deploy `log-event` and `guest-contract-events` (which predate the
   `access.reissued` registration).
2. The same mechanism will produce the same drift in Phase 3 unless gated.

So extend `scripts/check-migrations.mjs`: grep `src/` for
`functions.invoke('…')` and assert every name is deployed to the project that
bundle points at, and assert no migration is pending. That one check covers both
the current drift and every future repeat, and it is ~30 lines on top of the
`--live` mode that already exists.

## Well-formedness vs business policy

Keeping these apart is now explicit in the module header, because conflating
them is how a policy ends up as a CHECK constraint — unchangeable without a
migration, and applied retroactively to rows agreed under different terms.

| | well-formedness | business policy |
|---|---|---|
| asks | can this be recorded as evidence at all? | may THIS party offer THIS deal now? |
| depends on | the proposal alone | the actor, their history, configuration |
| changes | never | whenever the business decides |
| lives in | `agreementRules.ts` + CHECK constraints | the creation path |
| examples | `dod` is an array of real strings; amount is a positive integer; the date is a date | contract value limits, tiering, per-account caps, rate limits, who may transact with whom, fees |

Everything in the v1 table is the left column. The amount ceiling is the right
column and is undecided.

## The guest's verification problem, decomposed

The earlier conclusion — "expose `hash_version`, `payload_hash` and
`agreement_hash` and the guest can verify" — was too strong, and the correction
is worth stating precisely because the two halves have completely different
costs. Measured against a live guest view:

| | today | with the three fields added |
|---|---|---|
| recompute `event_hash` | 0/4 | **4/4** |
| chain links | server's verdict only | independently checked |
| agreement binding | **already possible** — `accepted_agreement` reproduces `agreement_hash` byte-identically | same |
| recompute `payload_hash` from the payload they are shown | 0/4 | **still 0/4** |

The reason the first row works is that canonical v4 hashes `payload_hash`, not
the payload. So the guest never needed the payload to verify the chain — the
digest is enough. **That half is solvable today, with no canonical change and
no new disclosure**, because those three values are digests of data the guest
already sees or already holds.

The reason the last row cannot be fixed that way is that the payload they are
shown is the allowlisted projection, not the hashed preimage. Adding the digest
lets them verify the chain; it does not let them check that the digest
corresponds to the text in front of them. **Adding hash strings cannot close a
preimage gap**, which is the correction.

### What is actually withheld, which changes the shape of the fix

Not third-party PII. The allowlist is a default-deny filter against keys nobody
has reviewed, and what it strips from a real event is the server-attested
metadata: `_actor_role`, `_auth_method`, `_role_in_agreement` on every event,
plus `_agreement`, `_claimed_identity`, `_claimed_identity_verified`,
`_invited_recipient` on acceptance. From the guest's own perspective most of
that is *about them* — `_claimed_identity` is the address they typed.

Two consequences. First, the privacy argument for withholding is weaker than
assumed and should be re-examined per field rather than defended wholesale.
Second, a real defect surfaced while checking: `performance.accepted` stores a
`note` but allowlists only `step`, so **a guest cannot read back the note they
themselves wrote**. Reported, not fixed — out of scope here.

### Four verification goals, separated

Adopting the decomposition from the research pass, because it makes clear that
one hash was being asked to carry four different jobs:

- **(A) log linkage** — the events are a chain, unbroken and unreordered.
  *Solvable now*, by exposing the three digests. No crypto work.
- **(B) proof of a disclosed claim** — the text I am shown is the text that was
  committed to. Needs a per-claim commitment; v4's single `payload_hash` over a
  whole payload cannot do it, because disclosing one field means disclosing the
  preimage of all of them.
- **(C) existence commitment for undisclosed claims** — something was committed
  here, I cannot read it, and it cannot be altered or back-dated later.
- **(D) external facts** — identity, authority, whether the work actually
  happened. **Out of cryptographic reach entirely.** No scheme makes a
  self-claimed email verified, and it would be dishonest to let (A)–(C) imply
  otherwise.

(B) and (C) together are selective disclosure, and the shape is standard:
replace one payload digest with a **per-claim salted commitment set** — each
field committed as `H(salt_i ‖ canonical(field_i))`, the payload hash becoming
the root over those commitments. The guest receives the commitments plus the
salts for disclosed fields only, recomputes the root, and so verifies the shown
text; undisclosed fields remain opaque, and the per-claim salt is what stops a
low-entropy value like an email being recovered by brute force. On dispute, a
salt can be released to disclose one field to one party without opening the
rest. `Saito/Watanabe (2021)` is this construction; `W3C VC 2.0` is the same
semantics in a credential setting; a Merkle root with inclusion proofs
(`RFC 9162`) is the variant that also keeps proof size down.

The operator-accountability half is a separate axis and worth taking seriously
given the stated goal that *the operator is also subject to verification*.
TrustFlow currently attests to its own log with no external witness, so an
operator could in principle present different histories to the two parties and
nothing in the record would reveal it. `CONIKS` and `RFC 9162` both address
exactly that — consistency proofs and equivocation detection — and the cheap
first step in that direction is not a Merkle tree but **publishing signed chain
heads somewhere the operator cannot retroactively change**, so that two parties
can compare what they were each shown. `TAP (2023)` is the closest published
combination of privacy with independent verifiability.

`Asokan/Shoup/Waidner (1998)` maps onto a different part of the product: the
third party is involved *only on dispute*, and is itself accountable. That is
already the implicit shape of TrustFlow's dispute story, and it is an argument
for keeping the happy path free of any third party rather than for adding one.

**Nothing here is proposed for implementation.** The sequencing that follows
from it: keep v4 exactly as it is, do (A) as a small additive change, and treat
(B)/(C) as a canonical **v5** that applies to new events only — historical v4
rows remain owner-verifiable and must be *described* that way rather than
upgraded, since `hash_version` exists precisely so a v4 row stays a v4 row. The
prerequisite for choosing among the schemes is a written threat model: who is
the adversary, is it the counterparty, the operator, or a later reader, and what
does each need to be convinced of. Picking a construction before that is how
you end up with a Merkle tree that answers a question nobody asked.

## `create_contract()` — the security design, since SECURITY DEFINER is the risk

A SECURITY DEFINER function is a privilege boundary, and the function's purpose
is to write a row whose `earner_user_id` decides who owns an agreement. So:

- **`earner_user_id` is derived, never accepted.** It comes from `auth.uid()`
  inside the function. Taking it as a parameter would let any caller create a
  contract owned by someone else — the whole vulnerability in one argument.
- **`auth.uid()` must be present**: null means no JWT, so raise rather than
  insert an orphan row.
- **Anonymous sessions refused.** `(auth.jwt() ->> 'is_anonymous')::boolean`
  must be false, matching `verified_earner_only_insert` on the table today. The
  app signs in anonymously on page load, so without this the function is
  strictly more permissive than the policy it replaces.
- **`set search_path = ''`** and every object schema-qualified, as the existing
  functions in this repo already do, so a caller-controlled `search_path`
  cannot substitute a shadowing object.
- **`revoke execute … from public, anon`; grant to `authenticated` only** —
  following `reissue_guest_access`, which revokes from `public`, `anon` and
  `authenticated` because it is called by a function with its own key. This one
  is called by the browser, so `authenticated` keeps it.
- **No RLS bypass beyond the insert itself.** It must not read or return rows
  the caller could not read anyway, and it must not touch `events`. Acceptance
  already has its own atomic RPC; widening this one to write evidence would
  give it two reasons to be privileged.
- **`freeze_accepted_terms()` and the append-only rules stay intact.** This
  function only ever INSERTs a `contracts` row in `AWAITING_ACCEPTANCE`, so it
  never meets the freeze trigger, and it writes no events.
- **Idempotency.** The browser double-click and the agent retry are the same
  problem. An optional caller-supplied key with a partial unique index on
  `contracts`, returning the existing row on a repeat, mirroring what
  `log-event` already does. Without it a retry silently creates a second
  agreement with a second invite.
- **Validation returns all violations**, as an array, so one round trip is
  enough for a caller fixing several fields.
- **Audit before Phase 4**: enumerate every INSERT path on `contracts` and
  confirm the function is the only one left, otherwise revoking the direct grant
  moves the hole rather than closing it.

## A lapsed deadline needs evidence, not a toast

Option (b) — warn and record anyway — was right in direction and too thin as
described. "The UI shows a warning" is not a fact anyone can later verify, and
an agent reading the API would never see it.

What makes it real:

- **The condition is machine-readable.** The acceptance context RPC returns
  something like `deadline_lapsed: true` with the dates, so an agent acting for
  the counterparty encounters the same fact as a human reading the screen,
  rather than the warning living in JSX.
- **Acceptance of a lapsed deadline is a distinct, explicit act.** Not an extra
  sentence above the same button: the acknowledgement is its own input, and the
  server re-checks the condition at write time rather than trusting a flag the
  client sends.
- **The evidence is the acknowledgement, not the person.** What belongs in the
  record is that *this* lapsed deadline was disclosed and accepted — the two
  dates and a boolean — written into the existing acceptance event. **No new
  personal data**, no second copy of an address, nothing that makes the
  append-only log a worse place to have been. The guest already appears in that
  event; this adds a field about the terms, not about them.
- **Rejected:** a separate `disclosure.shown` event. It doubles the rows,
  invites a "we displayed a warning" event for every future warning, and proves
  less than a field inside the acceptance it qualifies — acceptance is the act
  with legal weight, so the qualification belongs in it.
