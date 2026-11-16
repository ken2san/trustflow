# HANDOFF

Last updated: **2026-11-14**, based on commit `b17914a` plus the Task 58 commit.

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

Both projects run the **same artifacts, byte for byte**, as of Task 79
(2026-11-16). Production versions and digests: `log-event` v16
(`a1f2f779fe04d3e4…`, from `45633e6`; E2E v14), `validate-invite-token` v16
(`6ae1e8dd42362aa4…`), `guest-contract-events` v13 (`b2bcab62be6a4266…`),
`reissue-guest-access` v6 (`4c063dd2d16609121…`), identical to E2E's. The
other three are still the Task 36 artifacts (from `4b571bf`). **`log-event`
rollback target:** the previous v15 `8e834b9214e30c1d…` (source `4b571bf`;
that digest reproduces only when deployed from this checkout's path, and
rolling back reopens the in-flight reissue race). Compare **measured `ezbr_sha256`**, never `updated_at` or
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

47 local migration files. `check-migrations.mjs` runs offline in CI. The CLI link is
deliberately on E2E, so **every migration command names its target explicitly**
(`supabase db push --db-url <...>`; `db push` has no `--project-ref`).

### Published protocol

`/llms.txt` and `/agent-protocol.md` are served from `public/`. The second is
**normative**: a client that computes the shown-terms digest differently cannot
accept an agreement in any currency but JPY.
`tests/unit/shownTerms.test.js` reads the published file, so it cannot drift
from the implementation unnoticed.

---

## Guest append under the credential lock — live on E2E and production

**Task 58 — guest append under the credential lock. Pushed, applied and
deployed on E2E (Task 73) and production (Task 79, 2026-11-16).** The
published reissue copy and `agent-protocol.md` now match production's backend.

- Codex Task 76 reviewed b467194: FAIL

- New migration `20261114120000_guest_append_under_credential_lock.sql`: a
  service-role-only `append_guest_event` RPC that locks the contract row,
  re-checks the presented guest token and its expiry (`clock_timestamp()`,
  after the lock) under it, answers an idempotent replay only after that, and
  inserts in the same transaction. Purely additive.
- `log-event` sends guest writes through it; the owner path is unchanged. New
  guest refusals: 403 `guest_credential_expired`, 503
  `guest_append_unavailable` (function missing from the DB).
- `public/agent-protocol.md` and the reissue copy in `AgreementView.jsx` state
  the boundary: after a reissue commits, the old token cannot create an event.
- `scripts/race-guest-reissue-vs-append.sh` (`npm run test:race:guest`): both
  race orders, replay, expiry, rollback, on a loopback DB only. **Never run** —
  no local disposable DB existed.

**Task 59 — fixes for Codex Task 76** (migration edited in place; still applied
nowhere):

- Codex Task 77 re-reviewed 20872c8: FAIL
- Claude Task 60 fixed its P1: the race script parses `LOCAL_DB_URL` in the
  parent shell, refuses inherited `DB_*` (like PG*/PSQL*), and builds a quoted
  conninfo from re-validated parts only; `--self-check` now also runs the real
  script against a stub `psql` (no DB). Files:
  `scripts/race-guest-reissue-vs-append.sh`, `scripts/lib/local-db-guard.sh`.
  Report: `.ada/claude-report-60.md`. Still never run against a database.
- Codex Task 78 re-reviewed dd0c96c: FAIL
- Claude Task 61 fixed its P1: `--self-check` is called plainly (not left of
  `&&`), every stub setup step is checked, the script runs with `PATH` holding
  only the verified stub `psql` plus four tool links (no fallback dirs), and
  setup failures (no temp dir, bad/unwritable dir, stub missing, non-executable,
  altered, symlinked, extra entry) are covered without a DB. Same two files.
  Report: `.ada/claude-report-61.md`. **Loopback is not proof of a disposable
  backend** (a tunnel looks local): before write mode, the operator must confirm
  by hand that the local listener is a throwaway DB that forwards nowhere.
- Codex Task 79 re-reviewed 0ef12b9: FAIL
- Claude Task 62 fixed its P1 in `scripts/lib/local-db-guard.sh` only: the
  broken-stub cases now mutate `$work/bin` (the dir the runner verifies), each
  after an intact-stub control shows the runner does start the script; with
  the runner's re-verification disabled locally all five cases FAIL (not
  committed). Integration refusals now assert the exact guard stderr line.
  Report: `.ada/claude-report-62.md`.
- Codex Task 80 re-reviewed 1ae56d9: PASS
- Claude Task 63 (local Supabase stack): nothing installed — Docker Desktop
  29.9.3 (`/Applications/Docker.app`, CLI symlink `/usr/local/bin/docker`,
  context `desktop-linux`) and Supabase CLI 2.105.0 (Homebrew,
  `/opt/homebrew/bin/supabase`) were already present. `supabase start` ran
  with CLI defaults (repo has no `supabase/config.toml`), which also applies
  `supabase/migrations/` to the local DB. **Not loopback-only:** Docker
  published 54321-54324 and 54327 on `0.0.0.0`/`[::]` (Studio has no auth, DB
  has default credentials), so the stack was stopped again (`supabase stop`,
  volumes kept). Needs a decision on how to bind to 127.0.0.1 before restart.
  Report: `.ada/claude-report-63.md`.
- Claude Task 64: `supabase stop --no-backup`, created Docker network
  `trustflow-local` (`host_binding_ipv4=127.0.0.1`, IPv6 off), then
  `supabase start --network-id trustflow-local`. **Still bound to `0.0.0.0` and
  `[::]`** on 54321-54324 and 54327 (the CLI prints "All services bind to
  0.0.0.0"; its explicit host IP overrides the network default). Stopped at once.
  The stack is stopped, the network is left in place, and the volumes hold all
  47 migrations (re-applied on start). Report: `.ada/claude-report-64.md`.
- Claude Task 65: removed the `trustflow-local` network and the three
  `supabase_*_project-trustflow` volumes. Now running a standalone container
  `trustflow-localdb` (`public.ecr.aws/supabase/postgres:17.6.1.166`, the tag
  the CLI used), published only as `127.0.0.1:54322->5432`. Binding verified:
  IPv4 `127.0.0.1:54322` only, no IPv6 listener. `pg_isready` passes. No volume
  (data lives in the container layer). Superuser `supabase_admin`, password in
  `~/.config/trustflow-localdb/postgres.env` (mode 600, never printed). Empty:
  no migrations applied. Kenji checks tunnels/VPN before any use. Report:
  `.ada/claude-report-65.md`.
- Claude Task 66 (opinion): use `postgres` (non-superuser + BYPASSRLS, like hosted), but the race guard will refuse trustflow-localdb because `inet_server_addr()` is the bridge IP `172.17.0.2`; guest E2E needs PostgREST+GoTrue+edge-runtime. Report: `.ada/claude-report-66.md`.
- Claude Task 67: applied migrations as `postgres` over 127.0.0.1 inside trustflow-localdb; 13/47 OK, `20260923000001` failed (`function auth.jwt() does not exist` — GoTrue's, not in the bare image). Self-test and race not run. Report: `.ada/claude-report-67.md`.
- Claude Task 68: recreated trustflow-localdb (127.0.0.1:54322 IPv4 only), ran GoTrue v2.197.0 `auth migrate` once (75 OK, no ports, removed); project migrations 18/47 OK, `20260924123733_reconcile_migration_history` failed (`supabase_migrations.schema_migrations` does not exist — the CLI's history table). Self-test/race not run. Report: `.ada/claude-report-68.md`.
- Claude Task 69: fresh trustflow-localdb (127.0.0.1:54322 IPv4 only) + GoTrue migrate; CLI-shaped `supabase_migrations.schema_migrations` (DDL from the CLI binary), **47/47 migrations applied as `postgres`, self-test passed**; marker needed `supabase_admin` (PG17 refuses `postgres`: permission denied to set parameter); **race script PASS** (all cases ok) run inside the container. Container left running. Report: `.ada/claude-report-69.md`.
- Claude Task 73 (owner OK 2026-11-16, E2E `yqjtawffpesplqyurlpj` only; Task 72 had stopped at an `op read` timeout):
  - **PGPASSWORD:** CLI 2.105.0 honours `PGPASSWORD` with a password-less `--db-url`. Without it the same call fails `28P01`.
    That keeps the password out of argv, so prefer it to the doc's URL-encoded recipe.
  - **A:** dry run listed only `20261114120000`.
  - **B:** `db push` OK. History 47. `append_guest_event`, `replay_guest_event` and both helpers grant EXECUTE to `postgres` and `service_role` only.
  - **C:** `log-event` v13 `8e834b9214e30c1d…5b58389` → v14 `a1f2f779fe04d3e4620414298b8f965e7875239941f3067280fdee9ed26f1b84`,
    entrypoint `file:///Users/…`. Rollback = redeploy from `4b571bf`; its digest must be re-measured, not assumed.
    The bogus-token probe returned `404 contract_not_found`, not `503 guest_append_unavailable`.
  - **D:** `00-backend-guard` 1/1 alone, then `guest-evidence`, `event-ingestion`, `agreement-binding` and `mixed-surface` 43/43.
  - This shows wiring and no regression (authorized guest writes go through the RPC). It does **not** show the race,
    which only the local race script covers.
  - No spec covers a keyed guest replay or reissue → old-token refusal.
  - Report: `.ada/claude-report-73.md`.
- Claude Task 74 (plan only):
  - Pushed `199bfc6`.
  - Planned one new spec, `tests/e2e/guest-credential.spec.js`, on E2E: keyed guest replay, reissue (old token refused for append and
    replay), and expiry via the 2020 fixture token.
  - Finding: `log-event`'s pre-check answers a stale or expired token with `403 not_a_party`. `guest_credential_revoked/expired` occur only in the
    race, so they stay with the local self-test and race evidence.
  - No spec written. Report: `.ada/claude-report-74.md`.
- Claude Task 75: new `tests/e2e/guest-credential.spec.js` (Codex 82 changes applied). Results on E2E: guard 1/1 alone, then the spec **3/3**.
  - Not pushed: Codex reviews first.
  - What it proves (sequential HTTP), with "nothing written" measured each time as the owner's event set (id|type|key) before and after:
    - (a) keyed guest replay: 201, then 200 `deduplicated` with the same id after the chain moved; a different type with the same key → 409, no event.
    - (b) after a reissue, the old token's append and replay → 403 `not_a_party`, no event, nothing written; the new token replays (same id) and appends (201).
    - (c) the 2020 fixture token (checked present, owned by the test earner, expired) → 403 `not_a_party`, nothing written.
  - What it does **not** prove: the in-flight race, or `guest_credential_revoked/expired` over HTTP. Those are reachable only between pre-check
    and lock, so they rest on the migration self-test and the local race script.
  - Rows per run: 2 contracts and 7 events (a: acceptance, asserted, accepted; b: acceptance, asserted, `access.reissued`, rating). (c) writes none.
  - Report: `.ada/claude-report-75.md`.
- Claude Task 76 (Codex 83 fixes, spec only):
  - (c) now requires a nonempty expiry string, a finite parse and a past instant. A NULL expiry had read as 1970 and passed.
  - Assertion messages show status/error code only, no response bodies.
  - Artifacts: `retries: 0` means `trace: 'on-first-retry'` never records, there's no HTML reporter, and this spec opens no page. Enabling
    retries would make traces keep bearer and guest tokens. Noted, config not changed.
  - E2E, with `TF_LIVE_E2E` unset: guard 1/1 alone, spec **3/3 passed, 0 skipped**, `test-results/` empty. Rows: 2 contracts and 7 events.
  - Still not proven: the HTTP race and the locked-RPC error mapping (`guest_credential_revoked/expired`).
  - Not pushed. Report: `.ada/claude-report-76.md`.
- Claude Task 77 (plan only, nothing run): production rollout of the credential lock.
  - Order: P0 target/tree → P1 functions → P2 drift + dry run (only `20261114120000`) → B push (OK) → B' grants →
    C deploy log-event alone (OK) → C' ezbr `a1f2f779…` + probe + `smoke:prod`.
  - Rollback target v15 `8e834b92…`. Its digest is reproducible only from this checkout path.
  - "B applied, C failed" is safe to leave; the forward repair is re-running C.
  - `docs/e2e-project.md` should switch to the PGPASSWORD form (not edited).
  - Report: `.ada/claude-report-77.md`.
- Claude Task 78: after Codex 84 PASS, pushed `199bfc6..0d18d25` normally, so the guest-credential spec (Tasks 75/76) is now on `origin/main`.
  Production is still untouched.
- Claude Task 79 (owner OK 2026-11-16 12:53 ET), production `fqgpzhwvvfsxswlnbbgg`, per Report 77. Every step passed and no stop rule tripped:
  - **P0:** link still on E2E, tree clean, Docker 29.9.3, CLI 2.105.0.
  - **P1:** log-event v15 `8e834b92…`.
  - **P2:** remote at 46 (`20261110150000`). Dry run listed only `20261114120000`.
  - **B:** `db push` with `PGPASSWORD` and a password-less `--db-url`, exit 0.
  - **B':** read-only, history 47. `append_guest_event`, `replay_guest_event` and both helpers grant EXECUTE to `postgres` and `service_role` only.
  - **C:** `log-event` alone → v16 `a1f2f779fe04d3e4620414298b8f965e7875239941f3067280fdee9ed26f1b84`, which equals the E2E-tested artifact.
    Entrypoint `file:///Users/…`, `verify_jwt` true, other three unchanged.
  - **C':** bogus-token probe → `404 contract_not_found`. `smoke:prod` 16/16.
  - Rollback target v15 `8e834b92…`. Report: `.ada/claude-report-79.md`.
- Claude Task 80: pushed `0d18d25..3b6d01d`. Plan only for `contract.cancelled`; nothing built.
  - Finding: any party (guest and agents included) can write it today on any contract. It is permanent, labelled "Cancelled", and projects nothing.
  - Recommended: Step 0, refuse new writes until the owner decides the semantics (open decisions 1–4 in the report). Then move to scoped delegation.
  - Report: `.ada/claude-report-80.md`.

- The migration now also adds `replay_guest_event` (keyed guest retry, answered
  under the lock after token/expiry and before `log-event`'s tip, version and
  clock pre-checks) and two closed helpers, `guest_append_refusal` and
  `guest_append_replay`, plus a rollback-only self-test DO block (grants,
  revoked/expired token, replay, replaced-token replay). It documents that
  `server_recorded_at = now()` is the transaction start.
- `log-event` calls `replay_guest_event` first for a keyed guest request.
  `public/agent-protocol.md` describes the guest replay order.
- The race script rebuilds its connection from a strictly parsed loopback URL,
  refuses any PG*/PSQL* env, and before writing requires the server to report a
  loopback address and the marker
  `alter database postgres set trustflow.disposable_race_db = 'yes'`. Synthetic
  events carry explicit ids. Lock order is proven by a `pg_blocking_pids`
  handshake, not clocks. **New file:** `scripts/lib/local-db-guard.sh` (the
  guard; `npm run test:race:guest -- --self-check` exercises its rejection
  paths without a DB). Race script and migration self-test both passed
  locally in Task 69, and the self-test ran again inside the E2E push (Task 73).

**Release order:** apply the migration, then deploy `log-event`. Old function +
new DB is unchanged behaviour; new function + old DB fails guest writes closed.
Details: `.ada/claude-report-58.md`, `.ada/claude-report-59.md`.

---

## Active constraints

- **Re-issuing guest access does not recall reads.** Overwriting
  `guest_access_token` is the only credential withdrawal this system has.
  Since Task 79 (`20261114120000` + `log-event` v16, both projects) the write
  boundary is the reissue's commit: after it, the old token cannot create an
  event. Nothing un-delivers a response, and nothing user-facing may imply
  otherwise.
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

- `npm test` — latest recorded `make check`: 650 unit tests, 28 files. Fast, no credentials.
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

- Task 73 plan: `.ada/codex-report-73.md`.
- Task 74 refreshed this handoff and corrected the retired invite-format comment; deployment status was checked from documents only.
- Task 75 corrected the writer migration's production status in `Decisions.md` from the Task 45 record; no live check was made.
