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

**The amount ceiling.** It is tempting and it would contradict the only
specification this project has. `TRUST_LADDER` in `src/lib/constants.js:75-78`
caps contracts by level — ¥100k, ¥500k, ¥2M — and then `contractLimit: null`,
explicitly unlimited at level 10. A database ceiling makes that tier
undeliverable. So the ¥2,000,000,000 probe stays accepted at this layer: an
amount cap is a **per-account policy check against the actor's level**, a
different layer with a different owner. There is a test asserting it stays
accepted, so nobody adds one by reflex later.

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

## Still open: the guest cannot verify

Separate from the above and arguably more important. Measured against a live
guest view: the guest **can** reproduce `agreement_hash` from their own
`accepted_agreement` snapshot (byte-identical — v4 genuinely earns its keep),
but **cannot reproduce `payload_hash` for a single event, 0 of 4**, because the
payload they are shown is allowlisted per type and so is not the payload that
was hashed. `hash_version` is not exposed either. They are handed
`hash_valid: true` — the server marking its own homework, the exact thing
`verify-chain.mjs` exists to refuse on the owner's behalf.

The fix is to expose `hash_version`, `payload_hash` and `agreement_hash` in the
guest view. No backdoor: these are hashes of data the guest is already entitled
to see, and withholding them protects nothing while costing the product its
central claim for half its users. It changes a deployed function's response
shape, so it is its own deploy and its own decision.
