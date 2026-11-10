# HANDOFF

Last updated: **2026-11-09**, at commit `408a809`.

**This file says where the project is**, not what each session did — that is
what `git log` and `.ada/claude-report-*.md` are for. It was a session log of
~2,300 lines until Task 21; if it starts growing dated narrative again, that is
the thing to cut.

`.github/instructions/global.custom.instructions.md` tells the next agent to
check this file's freshness against `git log -1 -- HANDOFF.md` before trusting
it. Keep the line above accurate or that check becomes theatre.

`Decisions.md` is the source of truth for decisions. If this file disagrees with
it, this file is wrong.

---

## What TrustFlow is

An append-only, hash-chained record of what two parties said they agreed,
delivered and paid.

**It attests** that a party *said* something, at a server-recorded time, in an
order, bound to the terms as the server held them at that moment.

**It does not attest** that work was delivered, that money moved, or who anyone
really is. `performance.asserted` is a claim by the performer,
`payment.reported` a claim by the payer. The names are deliberate. The operator
is inside the trust boundary: no timestamping authority, no external anchor, so
the chain is tamper-evidence against later edits — not proof that anything
claimed is true.

**It never holds money.** Not as a limitation to be fixed: `Decisions.md`
(2026-11-06) records it as the owner's decision, and the settlement surface was
retired because of it.

---

## What is deployed, where

Two Supabase projects, both Mumbai. **Never point a writer at the wrong one.**

| | ref | role |
| --- | --- | --- |
| production | `fqgpzhwvvfsxswlnbbgg` | the live app at `https://project-trustflow.vercel.app` |
| E2E | `yqjtawffpesplqyurlpj` | every live test writes here; the CLI link stays on it |

### Edge Functions — four, and only four

Production and E2E each hold exactly these, all `verify_jwt: true`:
`log-event`, `validate-invite-token`, `guest-contract-events`,
`reissue-guest-access`.

Both projects run the **same artifacts, byte for byte**, as of the Task 36
rollout (2026-11-10, built from `4b571bf`). Production versions and digests:
`log-event` v15 (`8e834b9214e30c1d…`), `validate-invite-token` v16
(`6ae1e8dd42362aa4…`), `guest-contract-events` v13 (`b2bcab62be6a4266…`),
`reissue-guest-access` v6 (`4c063dd2d16609121…`), identical to E2E's. The
previous production artifacts (Task 17, from `be4287f`) are the rollback target:
`931793338b5a4234…`, `4724b50d9229cf18…`, `84884fa66c4a38c3…`,
`65e12b06b05361c1…`. Compare **measured `ezbr_sha256`**, never `updated_at` or
version numbers, which differ between projects for ordinary reasons.

**Deploy with Docker running.** Without it, `supabase functions deploy` silently
falls back to server-side bundling, which embeds a per-project path in the
bundle (`file:///tmp/user_fn_<ref>_…`). The digests then cannot match across
projects, and the comparison above proves nothing. Check that the entrypoint
path reads `file:///Users/…` after deploying.

**Five slugs are retired and must stay 404**: `create-payment-intent`,
`capture-payment`, `cancel-payment`, `send-acceptance-email`,
`timestamp-event`. They were un-deployed on 2026-11-06 and their **source was
deleted in Task 20**. `scripts/smoke-production.mjs` asserts the gateway's
`NOT_FOUND` for each on every release, and `tests/e2e/evidence-core.spec.js`
asserts it for `capture-payment` on E2E. Do not resurrect them;
`supabase functions deploy` with no function name deploys every directory it
finds, which is why the source is gone.

### Frontend

A static Vite bundle on Vercel. **A push to `main` deploys it; the backend
never follows.** A push is already a production action.

### Database

45 migrations. `check-migrations.mjs` runs offline in CI. The CLI link is
deliberately on E2E, so **every migration command names its target explicitly**
(`supabase db push --db-url <...>`; `db push` has no `--project-ref`).

### Published protocol

`/llms.txt` and `/agent-protocol.md` are served from `public/`. The second is
**normative**: a client that computes the shown-terms digest differently cannot
accept an agreement in any currency but JPY.
`tests/unit/shownTerms.test.js` reads the published file, so it cannot drift
from the implementation unnoticed.

---

## Local, committed, unpushed

Two commits ahead of `origin/main`:

| | |
| --- | --- |
| `690cab6` | `test(e2e)` — the mixed-surface suite (report 19) |
| `408a809` | `chore(functions)` — deleting the retired source (report 20) |

`408a809` is under Codex review. Nothing in either touches a deployed surface:
no Edge Function, no schema, and the web bundle hash is unchanged.

---

## Active constraints

- **Re-issuing guest access is not instant revocation**, and nothing
  user-facing may imply it is. Overwriting `guest_access_token` is the only
  credential withdrawal this system has, and `log-event` re-reads the credential
  one round trip before the insert — a guest request already in flight can still
  land.
- **Deploy one named function at a time, at a named project.** Never the bare
  `supabase functions deploy`.
- **A shared module change means the functions that bundle it deploy together.**
  A narrow one-function deploy is valid only when the changed shared definition
  is byte-identical or the new dependency is exclusive to that function.
- **Never use the management API or `execute_sql` to apply a migration.** It
  mints timestamp versions and rewrites bodies; it has caused ledger drift twice.
  `supabase db push` only.
- **Production writes are individually approved.** Reads of production are
  cheap; writes are not, because `events` is append-only — `UPDATE` and `DELETE`
  are discarded by rewrite rule, so nothing written can be removed by anyone.
- **The live suites write real, permanent events, and refuse to run anywhere but
  E2E.** The allowed project is pinned in source, not read from the environment
  it is meant to validate.
- **CAPTCHA is on in production.** It covers sign-in, sign-up and password
  reset — so no agent can complete the product's own sign-in. `updateUser` is
  not covered.
- **Vite inlines `VITE_*` at build time**, so a Vercel bundle hash can never
  equal a local build's. Comparing them is a meaningless gate.
- **Never print a secret or export a key into the environment**, and don't read
  `.env*`.

---

## Credentials an agent can hold

Accepted **for now** (Kenji, Task 16 — his own agents, testing phase): the owner
agent authenticates from a handed-over Supabase **refresh token**
(`scripts/lib/ownerKey.mjs`), exchanged with `grant_type=refresh_token`, which
is a token refresh rather than a sign-in and so is outside CAPTCHA's scope.

Two weaknesses, recorded rather than softened:

1. **It carries the whole account, and old copies stay live.** Not scoped, not
   listable, not individually revocable. The smallest revocable unit is the
   session family it was copied out of, which also signs out the client it came
   from. Measured on E2E: one token was accepted five times over ~3.5 minutes,
   upper bound not found — **rotation buys nothing against a leak.** Containment
   is: revoke the session, sign in again for a *distinct* one, provision that.
   Re-minting from the same session is not containment.
2. **The record cannot tell an agent from the human.** Every event it writes
   carries `_auth_method: account_session` and names the owner. That is honest
   and permanent.

**A first-party scoped API key is deferred until there are outside users.** Its
cost is priced in `.ada/claude-report-15.md` §3. Do not build it from this note.

---

## Next Priority (in order)

Referenced by name from `scripts/sim-counterparty.mjs` and two proposals, so the
heading keeps its old wording even though the file around it changed.

1. **An acting counterparty on the real guest path, without a real second
   human.** Nobody has driven this product as an independent party who does not
   know how it is built. `sim:counterparty` has two hand-written policies, so it
   only walks branches someone anticipated.

   **The owner's decision, so it stops being re-asked:** waiting on another
   person's availability costs the development loop far more than it buys. He
   has hired testers before; the value against the cost was poor and the
   findings needed heavy distillation anyway. A real person may be used when
   there is something only they can answer. **A real person is never a required
   gate, and "when do we do the second-human test" is the wrong question.**

2. **The first non-JPY acceptance in production has still never happened.**
   Open since Task 10. The mandatory-digest branch and
   `_shown_terms_check {version: 2}` are exercised on E2E in every two-agent
   run; production has never written one. The smoke does not create a contract
   or accept an invitation, so the first real one is worth inspecting by hand.

3. **Cancellation is underspecified, and the shape of the gap is known.**
   A `contract.cancelled` event leaves the projection untouched, so an accepted
   agreement keeps displaying as live. Reviewed by Claude and Codex in Task 12
   and judged **NOT CRITICAL** under the one criterion that mattered — no
   irrecoverable evidence loss, no wrong payment forced — so it is deliberately
   left alone. **Re-examine if an operating mode is ever built that pays from
   displayed state alone.** The withdraw-before-acceptance half is still
   unspecified: an invitation stays acceptable until it expires, and acceptance
   does not consult cancellation events.

4. **`App.jsx` decomposition.** It is still the largest file by far and holds
   most of the view switching. A refactor of working code, so it waits behind
   anything that changes what the record says.

5. **An MCP server over the published protocol.** The prerequisite that was
   missing — a specification an outside client can read — now exists.

6. **Act on the visual-review findings** that remain from the blind-review
   passes.

---

## Open decisions

- **`hirer_email` is compared case-sensitively and stored as typed.**
  `validate-invite-token` only trims it; GoTrue lowercases the JWT email claim,
  so `Bob@Corp.com` does not match `party_read_contract_events`' `=`. Latent
  today because guests read through their token rather than an account.
  `hirer_email` is **not** in the hashed agreement snapshot — the value at
  acceptance is hashed inside that event's payload as `_claimed_identity` — so
  normalising today's rows would break no hash. Any fix has to decide whether
  code compares case-insensitively while the RLS policy does not.
- **What to do with production's test data.** 1272 contracts / 2310 events
  belong to the QA Earner; the boundary against new writes holds; deletion
  undecided. See `Decisions.md`.
- **Whether creation should be an event.** `createContract` still logs nothing;
  acceptance is still the chain's first event.
- **Whether to drop the empty payment schema** — `trustpoints_ledger`,
  `trustpoints_balance`, `earner_payout_profiles`, the three `stripe_*` columns
  on `contracts`. Recommended in `.ada/claude-report-18.md` §5: **leave them.**
  A drop needs its own approval and a production emptiness check first.
- **`AgreementView` has three near-identical "expand a textarea, confirm or
  cancel" blocks.** Worth one shared component eventually; deferred as a
  refactor of working code.

### `trustpoints_ledger` — three separate statements, kept separate

An earlier version of this note ran them together and ended with "no points are
awarded anywhere and none ever have been", which source inspection cannot
support. Codex's Task 20 review caught it. The three are:

**1. What is established by reading this repository.** No writer remains. The
only inserts lived in `capture-payment` (two) and `cancel-payment` (one), both
deleted in Task 20, and no other insert exists anywhere in the tree. Nothing
reads the table either — no client code touches it or the `trustpoints_balance`
view, and `src/lib/trustpoints.js` is a rules module whose `TRUSTPOINTS_RULES`
export is unused. So **no application path can award a point today.**

**2. What was observed, and when.** On **2026-11-09** the table was empty on
**E2E**, measured together with `earner_payout_profiles`, contracts carrying any
`stripe_*` id, events of type `payment.intent_created`/`captured`/`refunded`,
events of type `trustpoints.*`, and contracts in `SETTLED` — all zero. That is a
dated observation of one project, not a property of the system.

**3. What is NOT established.** Production was never queried, so its row count
is unknown. Neither project's history is knowable from source: the deleted
functions did contain working insert paths, so rows may have existed at some
point. Deleting a writer says nothing about what it wrote before.

Also kept straight: client writes are revoked
(`20260924000003_small_security_fixes.sql`), which makes inserts
**service-role-only** — and that is *not* the same as Edge-function-only. A
service-role credential can be used from the dashboard, the CLI, a script or an
MCP connector. "Only Edge Functions could insert" was never the guarantee; "only
something holding the service role could" is.

The table and view are **retained deliberately**, and confirming production's
count is a precondition of any drop.

**Do not read `20260527000001_trustpoints_ledger.sql`'s "Inserts via Edge
Functions only" as evidence of a live writer.** It is approximately true as a
privilege statement and misleading as a description. A migration is immutable,
so this note is the correction.

---

## Rollback

- **Frontend:** promote the previous known-good Vercel production deployment.
  Do not rewrite commits. Vercel reports `isRollbackCandidate: false` on current
  deployments, so this is a promote rather than a one-click rollback. The
  deployment before the Task 17 rollout was `dpl_EbMxRwcWCgi9GTPtPoqfnyWDsocN`
  (`83ae844`).
- **Edge Functions:** no CLI rollback exists. The only route back is deploying a
  compatible known-good source. Note that **rebuilding pre-Task-17 source would
  not reproduce the old digests**, because it floats on
  `esm.sh/@supabase/supabase-js@2` and would resolve whatever 2.x esm.sh serves
  that day. That is the defect Task 17 fixed.
- **Database:** migration-specific. There is no general answer.

---

## How this project tests without a second human

- `npm test` — 558 unit tests, 25 files. Fast, no credentials.
- `npm run test:api` — one transaction over HTTP, both parties, no browser, no
  service role. 31 checks.
- `npm run sim:two-agents` — the same as **two OS processes**, two credentials,
  the invite handed over on a channel TrustFlow is not part of, and the digest
  computed from the published spec by an implementation that shares none of this
  project's crypto. 24 checks.
- `npm run sim:counterparty` — several agreements, the counterparty as a policy
  rather than a script.
- `npm run test:e2e` — 17 browser specs, including `mixed-surface.spec.js`,
  which crosses the surfaces: a capability minted in a browser then used by an
  agent, and a browser owner delivering against an agent's acceptance.
- `npm run verify:chain <id>` — recomputes a contract's chain independently.
- `npm run smoke:prod` — the release check. **Once per release, never polling.**

**What none of them establish:** that two independently motivated parties get
through a deal. Every judgement in them is a hard-coded assertion.

---

## Lessons this project has already paid for

Kept as constraints, not stories.

- **A comment asserting a behaviour is not that behaviour.** This has been the
  single most productive class of defect here: `log-event` described payment
  event writers that never existed, the onboarding screen promised escrow,
  nine comments named components that were never in the tree. Task 21 swept
  them; expect more.
- **Being unreachable from `src/` protects nothing.** A module with no importer
  still ships if something can deploy the directory it sits in.
- **A client that collapses the server's reason hides bugs for weeks.**
  supabase-js turns any non-2xx into a `FunctionsHttpError` with `data` null, so
  `data?.error ?? 'error'` reduced every distinct refusal to one word.
  `invokeErrorReason` exists for that.
- **A test suite that has never run is worth nothing**, and a skip that reports
  success is worse than a failure. The live suites error rather than skip when
  credentials are missing.
- **A suite can be green because of what it cannot see.** Mutate the code and
  check the test goes red; a test that has never failed has never been tested.
- **A dashboard toggle can silently require a frontend contract.** Enabling
  CAPTCHA locked out every account until the widget shipped.
- **Verify a deploy by measuring the artifact**, not by reading a version
  number or a timestamp.
- **A migration ledger can be wrong while the schema is right.** Prove schema
  parity before repairing a ledger.
- **A live check beats an assumption about a library.** `writeFile`'s `mode`
  only applies on creation — a "fixed" credential file stayed 0644 while the
  script logged otherwise.

---

## Key files

- `AGENTS.md` — agent behaviour rules; `CLAUDE.md` only imports it.
- `Decisions.md` — architectural decisions. **Source of truth**; do not reverse
  without instruction.
- `Protocol.md` — the implemented evidence protocol.
- `Roadmap.md` — product direction, explicitly intent rather than a build log.
- `README.md` — what the project is, and the commands.
- `public/agent-protocol.md` — the normative client specification, published.
- `docs/e2e-project.md` — the two-project arrangement and what enforces the
  boundary.
- `supabase/functions/_shared/eventCanonical.ts` — the one definition of what an
  event hash covers. Bundled into the web client too.
- `supabase/functions/_shared/eventRecord.ts` — assembles every event, so an
  assertion and an acceptance are the same kind of object.
- `src/lib/auditExport.js` / `src/lib/guestRecordExport.js` — the owner's and
  the guest's exports.
- `src/lib/earnerAuth.js` — sign-in, `isEarnerVerified()`, and the one place a
  raw Supabase Auth error becomes a message that says what to do.
- `scripts/lib/credentialFile.mjs` — how a file holding a credential is read and
  written: owner-only creation, atomic replacement, mode repair on read, and a
  parse error that never quotes its input. **Both** files holding a refresh
  token go through it (`tests/e2e/.earner-session.json` via
  `tests/e2e/earnerSession.js` and `scripts/lib/tfClient.mjs`;
  `tests/e2e/.owner-api-key.json` via `scripts/lib/ownerKey.mjs`). Use it for
  any new one — and note that `writeFile`'s `mode` option does not repair an
  existing file, which is why this module exists at all.
- `tests/e2e/liveEnv.js` — credentials, and the refusal to run without them.
- `.ada/claude-report-*.md` — the detailed record of each piece of work, and
  where measurements live.
