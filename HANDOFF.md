# HANDOFF

Last updated: **2026-11-27**, based on pinned local Row 8 candidate `80e0988` (38 local commits ahead of `origin/main`; not pushed; Row 8 live E2E and production NOT done).

**This file says where the project is**, not what each session did — that is
what `git log` and `.ada/claude-report-*.md` are for. It was a session log of
~2,300 lines until Task 21; if it starts growing dated narrative again, that is
the thing to cut.

`.github/instructions/global.custom.instructions.md` tells the next agent to
check this file's freshness against `git log -1 -- HANDOFF.md` before trusting
it. Keep the line above accurate or that check becomes theatre.

`Decisions.md` is the source of truth for decisions. If this file disagrees with
it, this file is wrong.

**Rule (Kenji, 2026-11-18, `Decisions.md`):** the first deal runs through bot
simulations, with bots acting as the parties. "We can't design without real deals
or real users" is wrong. Never use it as a reason to wait, or to defer design,
the entry path or the roadmap. Older lines here that say otherwise are marked
superseded.

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

Both projects run the **same artifacts, byte for byte**, as of Task 91
(2026-11-16). Production versions and digests: `log-event` v17
(`0018df819efa95df…`, from `9819a15`, refuses new `contract.cancelled`; E2E
v16), `validate-invite-token` v16 (`6ae1e8dd42362aa4…`),
`guest-contract-events` v13 (`b2bcab62be6a4266…`), `reissue-guest-access` v6
(`4c063dd2d16609121…`), identical to E2E's. The other three are still the
Task 36 artifacts (from `4b571bf`). **`log-event` rollback target:** the
previous `a1f2f779fe04d3e4…` (source `45633e6`; accepts new
`contract.cancelled` again). Any of these digests reproduces only when
deployed from this checkout's path. Compare **measured `ezbr_sha256`**, never `updated_at` or
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

- Claude Task 175 (2026-11-22, E2E): fresh cancellation fixture **not recorded**.
  - `node scripts/record-cancel-fixture.mjs --check` stops: `E2E log-event is not the v14 artifact that accepts contract.cancelled`. Recording would need the old v14 `log-event` redeployed on E2E (an edge-function rollback) plus the existing `tests/e2e/.cancel-fixture.json` moved aside; both are outside the approved scope.
  - Ran `cancellation-refusal.spec` on current E2E (refusing `log-event`, existing fixture): **4/4 passed**. Tests 1-2 refuse new owner and guest cancellations on **fresh contracts created through `rpc/create_entry_contract`** and accepted via the real invite, so the post-B entry path is covered. Tests 3-4 replay the existing fixture's recorded events; replay doesn't depend on how the fixture's contract was created (row shape and hash parity T155/T164).
  - **Recommendation:** treat row 2's fixture item as covered without a fresh fixture. Kenji/棟梁 to decide whether to close Roadmap row 2 on that basis (not closed here). Report: `.ada/claude-report-175.md`.
- Claude Task 174 (2026-11-22, Kenji 02:19 ET):
  - **`npm run smoke:prod` 16/16 ok, exit 0, no writes.** Bundle points at prod; OTP endpoint answers 400 and **server-side CAPTCHA is enforced** with a real site key; the 4 live functions are serving and the 5 retired ones absent; `/llms.txt` and `/agent-protocol.md` served.
  - **Gap:** `smoke:prod` has **no probe** of `POST /rest/v1/contracts` or `rpc/create_entry_contract`, so the production refusal of the old insert and of an anonymous create is still proved only by catalog checks (T171) and E2E (T165), not by an HTTP probe.
  - Proposed for a later OK: add two refusal probes whose bodies would fail a CHECK constraint even if privileges were open (e.g. an invalid currency), so a probe can never write. Then 42501 proves the refusal and 23514 would reveal open privileges.
  - Runbook §4 push command braced (`"${RELEASE_SHA}:refs/heads/main"`) with a zsh note.
  - Committed and pushed with a plain `git push origin main`. Report: `.ada/claude-report-174.md`.
- Claude Task 173 (2026-11-22, Kenji OK 01:58 ET): **pushed to production.** `git push origin "${RELEASE_SHA}:refs/heads/main"` → `122bac2..11d2075`, exit 0; `origin/main` = `11d2075`.
  - Vercel `dpl_GmRv2BwoHuWLsvnCyBhUFLNcxAyD` is READY for `11d2075`, target production, aliased to `project-trustflow.vercel.app` with no alias error. **The cutover gap is closed.**
  - Read-only smoke all PASS:
    - page and bundle HTTP 200;
    - bundle has `fqgpzhwvvfsxswlnbbgg` (and no E2E ref) and `create_entry_contract` with the `p_*` params, and no `from("contracts").insert(` (contracts is only selected and deleted);
    - `/llms.txt` and `/agent-protocol.md` HTTP 200, byte-identical to `public/`, with RPC instructions and no direct POST; the digest vectors are pinned by `tests/unit/shownTerms.test.js` (34/34);
    - functions: `log-event`, `reissue-guest-access`, `validate-invite-token`, `guest-contract-events` (no credential function, so issuance is off);
    - auth: `mailer_autoconfirm=false`, email on, Turnstile site key in the bundle. Server-side CAPTCHA enforcement is not readable here.
  - `smoke:prod` not run (recommended as a separate OK). The HANDOFF commits `27489ca` and the T173 commit stay local. Report: `.ada/claude-report-173.md`.
- Claude Task 172 (2026-11-22, Kenji OK 01:48 ET): **push STOPPED, nothing pushed.**
  - Preflight passed: tree clean (only `.ada/` untracked); `RELEASE_SHA` `11d2075` is HEAD and a fast-forward of `origin/main` `122bac2` (16 reviewed commits); Vercel `project-trustflow` deploys `ken2san/trustflow` main to production, live at `122bac2`.
  - The one push failed locally: `src refspec 11d2075…efs/heads/main does not match any`. zsh treated `:r` in `"$RELEASE_SHA:refs/heads/main"` as a history modifier. Remote unchanged (`origin/main` = `122bac2`, `ls-remote` confirms).
  - Per the gate, no second push. **Production creation is still down** (B is live, the old frontend is live).
  - Needs Kenji's OK to retry once with `git push origin "${RELEASE_SHA}:refs/heads/main"`. No smoke was run. Report: `.ada/claude-report-172.md`.
- Claude Task 171 (2026-11-22, Kenji OK 01:44 ET): **migration B `20261120180000` applied to PRODUCTION** (`fqgpzhwvvfsxswlnbbgg`) per the runbook: pin `cbd02d3`, CLI 2.105.0, one `op read` → `PGPASSWORD` only. Exit codes: baseline 0, dry run 0, apply 0, snapshot 0, assertions 0.
  - The dry run listed exactly B. The catalog diff is **identical to E2E T165**: history gains B; authenticated column INSERT 10 → none; `creator_insert_contract` dropped.
  - All 18 assertions PASS: no table or column INSERT for anon/authenticated/PUBLIC (effective, inherited included); service_role and postgres keep INSERT; 3 policies remain with RLS on; RPC definer, owner postgres, empty search_path, authenticated-only; every returned column selectable; pg_graphql absent; no client-writable views; the RPC is the only client-reachable definer inserting contracts; row 1 inventory PASS.
  - 1322 contracts, 2397 events, row and hash digests unchanged. No write smoke.
  - **Cutover gap now open (accepted):** the current production frontend's direct insert can no longer create contracts until the new frontend is pushed. **The push is NOT done** and needs its own OK. Report: `.ada/claude-report-171.md`.
- Claude Task 170 (2026-11-22, Kenji OK 01:37 ET): **migration A `20261120090000` applied to PRODUCTION** (`fqgpzhwvvfsxswlnbbgg`) per the runbook: pin `5a7f2be`, CLI 2.105.0, one `op read` → `PGPASSWORD` only. Exit codes: baseline 0, dry run 0, apply 0, verify 0.
  - The dry run listed exactly A. Before and after are identical: 1322 contracts, 2397 events, row and hash digests, client INSERT grants (authenticated still has the 10 legacy columns, so direct create still works until B), and the 4 policies.
  - Verify all PASS: history ends at A and B is absent; the RPC has exactly the 8 arguments and no other overload, is SECURITY DEFINER with empty search_path, owned by postgres, returns jsonb, with EXECUTE for authenticated only; postgres holds `auth.users` UPDATE; 0 contracts columns authenticated cannot SELECT; party read policy and RLS as rehearsed; inventory PASS; pg_graphql absent. No production write smoke.
  - **B and the push are NOT done.** The production frontend stays on its current route until both are approved. Report: `.ada/claude-report-170.md`.
- Claude Task 169 (2026-11-22, test-only): Codex T155 items in `tests/e2e/owner-create-live.spec.js`.
  - **Artifacts:** `test.use({ trace, screenshot, video: 'off' })`, so no artifact can hold the invite token.
  - **Request counting:** create and legacy-insert counting now runs in both the owner and guest contexts from before the click to the end of the test, and is asserted again after the guest check (1 and 0).
  - **Target before boot:** a context route installed before the first page load aborts and records any request to a non-E2E Supabase host, and records any non-read request to E2E before the served-app target check; both must be empty.
  - Live 1/1 with no token in the output; backend guard 1/1; lint 0 errors; `make check` 779. Report: `.ada/claude-report-169.md`.
- Claude Task 168 (2026-11-22, test-only): fixed `tests/e2e/owner-create-live.spec.js` per Codex T154 (BLOCK).
  - **Target:** the configured target is checked as E2E before any session; the served app's backend (`window.__TF_SUPABASE_URL__`) is checked before seeding or submit. The matcher requires the E2E origin and the exact `/rest/v1/rpc/create_entry_contract` path.
  - **Requests:** every matching POST is counted from before the click until the shown invite appears and the network is idle: exactly 1 create, 0 legacy `POST /rest/v1/contracts`. Every sent parameter value equals the form input (including null deadline and `creator`).
  - **Drafts:** an independent owner read-back finds exactly 1 draft for a unique per-run marker.
  - **Invite:** the guest opens the **displayed** invite URL (origin, route and token validated as booleans).
  - **Redaction:** the token appears in no message, locator or navigation diagnostic (redacting `goto` wrapper); no token in the run output.
  - Elapsed expiry remains a gap (wording corrected above).
  - Live on E2E 1/1; lint 0 errors; `make check` 779. Report: `.ada/claude-report-168.md`.
- Claude Task 167 (2026-11-22, Kenji OK ~01:15 ET): **row 1 `20261118214020` applied to PRODUCTION** (`fqgpzhwvvfsxswlnbbgg`) per `docs/production-apply-runbook.md`: worktree pin `6942691`, CLI 2.105.0, one `op read` → `PGPASSWORD` only. Read-only checks via psycopg (no host `psql`).
  - Baseline history ended at `20261118010000`; the dry run listed exactly row 1; apply printed `Finished supabase db push.`
  - Before and after are identical: 1322 contracts (original-column digest), 2397 events, and the event/agreement hash digest.
  - Verify all PASS: history ends at row 1 and A/B are absent; `counterpart_account_id` is nullable uuid FK, null on all rows, not client-writable; `counterpart_not_owner`; the credential table is empty, RLS on, no client privilege, service_role SELECT only, with immutability triggers and a non-cascading FK; the 3 RPCs are definer, empty search_path, service_role only, and their owner can lock `auth.users`; the delete guard checks TF007 before TF004; inventory PASS; pg_graphql absent.
  - The exit codes were not captured (zsh `PIPESTATUS` is empty); evidence is the CLI output plus history and catalog.
  - **A, B and the push are NOT done**; each needs its own OK. The client direct insert is still open on production (as before). Report: `.ada/claude-report-167.md`.
- Claude Task 166 (2026-11-22, E2E browser check, test-only):
  - `00-backend-guard` 1/1 (app and tests point at the same E2E project); `invite-persistence --grep-invert @pre-b` 9/9; `currency.spec` 15/15.
  - New `tests/e2e/owner-create-live.spec.js` **1/1**: a verified owner fills the real New contract form with no network stubs. Send Invite reached `rpc/create_entry_contract` with exactly the 8 parameter names, answered 200 `created` with owner = the signed-in account _(T168: the T166 spec observed only the first response, so it did not prove one request or one draft; T168's spec does)_. The stored row matches the typed terms with server-derived fields null or untouched, the form shows the invite for that token, and a signed-out browser opens the guest invite with those terms. It covers the bearer flow only; C3 verified-account matching is a separate path, not exercised. It writes one ordinary E2E draft per run.
  - **Gap, not built:** `invite-persistence` "an expired invite fails closed" actually tests a *consumed* token. A true-expiry spec needs `invite_token_expires_at` in the past, which only the server or service role can set (the RPC derives +72 h). It needs an app change, a privileged write or a permanent fixture, or an untouched draft left to age past its 72 h TTL, which needs no change but is unsuitable for a single-run spec _(wording corrected T168, Codex T154)_. Elapsed expiry stays unverified on E2E.
  - No app bugs found. Lint 0 errors, `make check` 779. Report: `.ada/claude-report-166.md`.
- Claude Task 165 (2026-11-21, Kenji OK 09:30 ET, E2E only): **migration B `20261120180000` (HEAD `cbd02d3`) applied to E2E** (`yqjtawffpesplqyurlpj`) with `supabase db push --db-url`, CLI 2.105.0, one `op read` → `PGPASSWORD` only; the dry-run gate listed exactly that one file.
  - Read-only before/after catalog diff is exactly 3 lines: history gains B; `authenticated` column INSERT goes from 10 columns to none; `creator_insert_contract` dropped.
  - Unchanged: anon/authenticated/PUBLIC no table INSERT; service_role and postgres keep INSERT; 3737 contracts and 5964 events with identical row and hash digests; RLS on; the other 3 policies identical (party-only read); RPC definer, owner postgres, empty search_path, authenticated-only; 0 unselectable return columns; pg_graphql absent; no client-writable views; the only client-reachable definer inserting contracts is the RPC; row 1 inventory PASS.
  - Tests: `currency.spec` 15 passed (6 `@post-b`); `invite-persistence --grep-invert @pre-b` 9 passed; `api-e2e` 32/0; `race-delete-vs-append` PASS; `sim-counterparty` 19/0; owner-agent via `sim:two-agents` PASS; `offer-for-tester` PASS.
  - No production, no push, no fixture recorder. **Production still has neither row 1, A nor B**; a push would break production create until A is applied there. Report: `.ada/claude-report-165.md`.
- Claude Task 164 (2026-11-21): T149 verification items 3 and 1 only.
  - **Item 3, local Docker rehearsal of B through the real `supabase db push` (CLI 2.105.0):** faithful restore of the local DB (owners, ACLs and data; only the 7 reviewed event triggers excluded), row 1 + A pushed from a pre-B worktree, then B from HEAD. A disposable login role whose sessions `SET ROLE postgres` was used, since the local postgres password is unknown; it was dropped afterwards.
    - Pre/post diff is exactly two lines: the history gains `20261120180000`, and `authenticated` loses its 10 INSERT columns.
    - Unchanged: anon/PUBLIC no INSERT; service_role and postgres keep INSERT; 1 contract and 7 events with identical row md5 and event/agreement hashes; RLS on; the other 3 policies byte-identical; RPC definer/owner postgres/empty search_path/authenticated-only; 0 unselectable return columns; pg_graphql absent; no client-writable views; only rules are events no-update/no-delete; the only client-reachable definer inserting into contracts is `create_entry_contract`; row 1 inventory PASS.
    - After B: trusted postgres insert still enforces currency and the JPY mirror (4 refusals, USD/JPY accepted); authenticated direct insert gets 42501; RPC create owner = `auth.uid()`; party RLS holds; anon refused for RPC and insert.
    - **Fault:** an INSERT grant inherited through a role makes the push fail with `SELF-TEST FAILED: authenticated retains effective INSERT on contracts` (exit 1), and the snapshot is identical to before: no history row, policy and grants intact.
    - Note: B's file has its own `begin; … commit;`, unlike T107's no-BEGIN rule. Rollback-on-failure works through the runner; on success the history row is written after B's own COMMIT (minor; not a blocker).
  - **Item 1, E2E** (row 1 + A, B absent): `invite-persistence.spec.js --grep-invert @post-b` **9 passed**.
  - B not applied anywhere hosted; no fixture recorder; no push. Report: `.ada/claude-report-164.md`.
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
- Claude Task 81 (Step 0, owner option A, Codex 85 applied). **Committed locally only: not pushed, not deployed.**
  - `contract.cancelled` is removed from `log-event`'s `ALLOWED_TYPES`. New writes → 400 `type_not_allowed`.
  - A keyed retry still gets back a `contract.cancelled` the same actor already recorded. `REPLAY_ONLY_TYPES` and `typeAdmission` in
    `_shared/eventWriteRules.ts`, plus one guard after both replay lookups, keep it from ever reaching an insert.
  - Unit `eventWriteRules` 40/40. E2E `event-ingestion` concurrency fixture now uses `rating.submitted` (not run).
    Protocol §4, `public/agent-protocol.md`, the OpenAPI draft and the `eventLog.js` comment are updated.
  - **Release order:** deploy `log-event` (E2E, then production) before pushing, because the push publishes `agent-protocol.md`.
  - Out of scope: service-role writers (`append_guest_event` has no type allowlist), and the "Cancelled" labels on historical rows in
    AgreementView/GuestEvidenceView. Report: `.ada/claude-report-81.md`.
- Claude Task 82 (Codex 86 fixes on `0462ffe`). **Local only: not pushed, not deployed, nothing run on E2E.**
  - The owner keyed lookup no longer drops its error: `ownerKeyedOutcome` in `_shared/eventWriteRules.ts`; a failure answers 500 `lookup_failed`
    for every keyed owner write.
  - OpenAPI models `contract.cancelled` as a `ReplayOnlyEventType`: the 3.1 `if`/`then` requires a nonempty key. The 400 note says a keyed
    request can see `contract_not_found`/`not_a_party` first.
  - New **unrun** `tests/e2e/cancellation-refusal.spec.js`. It needs `tests/e2e/.cancel-fixture.json` (gitignored), recorded on E2E
    **before** the new log-event is deployed, and fails without it.
  - Unit `eventWriteRules` 45/45. Fixture plan in `.ada/claude-report-82.md`; it needs Kenji's approval.
- Claude Task 83 (Codex 87 fixes). **Local only: not pushed, not deployed, nothing written to any DB, fixture script NOT run.**
  - `writeCredentialFile(…, { noClobber: true })` publishes with link(2), so an existing file is never replaced.
  - `cancellation-refusal.spec.js` runs serially and holds a cross-run lock (`tests/e2e/.cancel-fixture.json.lock`). It requires fixture `status: complete`.
  - OpenAPI replay-only wording now promises only what the code does. It passes `openapi-spec-validator` (3.1) plus 7 body cases;
    `idempotency_key` is now `[string, null]`.
  - New handler-level `tests/unit/logEventHandler.test.js`: the real `log-event` handler with a stubbed `Deno.serve` and supabase-js.
    The owner lookup error → 500; the test fails if the fix is removed.
  - **New one-off script `scripts/record-cancel-fixture.mjs`:**
    - `--check` (no writes), record, `--resume`.
    - It refuses unless E2E log-event's ezbr is v14 `a1f2f779…` and the session is the test account.
    - It writes `tests/e2e/.cancel-fixture.json` (no-clobber, 0600) before any DB write.
    - Needs Kenji's approval to run.
  - Unit `eventWriteRules` + `logEventHandler` 51/51. Report: `.ada/claude-report-83.md`.
- Claude Task 84 (Codex 88 FAIL → fixes). **Local only; fixture script still NOT run, not even `--check`.**
  - **One lock:** `scripts/lib/fixtureLock.mjs`, taken by the spec and by the script's record/`--resume`.
    It fails closed on ANY existing lock, stale included; a human verifies and deletes one. Release removes only the caller's own (token match).
    Fixed fixture and lock paths; the `TF_CANCEL_FIXTURE` override is removed.
  - **`--check` is read-only:**
    - it uses the cached session as it is (`readCredentialFile(…, { readOnly: true })` refuses loose perms instead of chmodding);
    - no sign-in, refresh, lock or file write; only `GET /auth/v1/user` and `supabase functions list`.
  - **Cancellations:**
    - each is marked `unknown` before sending, and `recorded` only on a success response with an id;
    - `--resume` only reconciles (expected type, actor and key);
    - re-sending needs `--retry-unsettled` plus 15 minutes of quiescence, with the v14 digest and the unique `events_idempotency_idx` as the stated proof.
  - **Record updates** check `run_id` + `revision` under the lock. A `link` that succeeds before the staging cleanup fails now reports
    `EPUBLISHED_CLEANUP_FAILED` with the orphan path, instead of looking unpublished.
  - OpenAPI 400 now says "no event under that contract and key". Printed server reasons are allowlisted.
  - Unit `eventWriteRules` + `logEventHandler` + `fixtureLock` 58/58. OpenAPI 3.1 validator OK. Report: `.ada/claude-report-84.md`.
- Claude Task 85 (Codex 89 FAIL → fixes; local only, script NOT run):
  - **`--retry-unsettled` and the 15-minute "proof" are removed.** An unknown cancellation outcome with no visible event always stops.
    Any re-send is manual and needs Kenji's explicit approval. No unique-index claim is made.
  - Printed reasons come from a fixed set of known error codes; anything else prints `unrecognised_reason`.
  - Lock: the assumption is now stated plainly — delete a lock by hand only after its holder has fully exited. The token check is best-effort, not a guarantee.
  - 58/58 + validator OK. Report: `.ada/claude-report-85.md`.
- Claude Task 86 (Codex 90 FAIL → fixes; local only, script NOT run):
  - **Arguments:** new `scripts/lib/fixtureArgs.mjs` accepts exactly none, `--check` or `--resume`. Anything else exits 2 with a fixed message
    before the script even imports tfClient/liveEnv (now dynamic imports).
  - **Output:** the lock error prints only fixed text and a validated pid. Printed ids must be UUIDs. Unexpected failures print a fixed line.
  - **Note:** `--resume` can send a cancellation that was never attempted, after reconciling. That's a permanent write and needs approval.
  - Unit args + lock + log-event 61/61; the arg tests fail under a fall-through mutation. Report: `.ada/claude-report-86.md`.
- Claude Task 87 (Codex 91, text only): the script header (new RESUME WRITES section) and the printed usage now say `--resume` can make
  permanent E2E writes and needs its own action-time approval; approving `--check` or a record run doesn't cover it. No logic change.
  Arg + lock tests 10/10. Report: `.ada/claude-report-87.md`.
- Claude Task 88: stopped at preflight (the cached earner session had expired); nothing run. Report: `.ada/claude-report-88.md`.
- Claude Task 89 (Kenji OK 13:58 ET), **E2E fixture recorded**, E2E `yqjtawffpesplqyurlpj` only:
  - One `ownerSession()` sign-in refreshed `tests/e2e/.earner-session.json` (auth session only, no rows).
  - Preflight 3/3 and `--check` were clean (log-event still v14).
  - One record run, exit 0. Permanent on E2E: 1 contract + 3 events (acceptance + 2 cancellations).
    - Run `a7d86529-20c1-4fd0-ae41-e01d62d4146d`.
    - Contract `5d0ce316-3041-46b2-b816-4b2b88614989`.
    - Owner cancellation `b4b72882-6efa-4d97-bca0-74968285c6be`; guest cancellation `ece19c71-27b0-4056-b3d4-c582c8eaad10`.
  - **Credential file: `tests/e2e/.cancel-fixture.json`** (gitignored, 0600, `status: complete`, holds the guest token). Keep it: it cannot be made again
    after the refusing log-event is deployed.
  - Not done: log-event deploy, E2E specs, push.
- Claude Task 90, **refusing log-event deployed to E2E only**, from `9819a15`:
  - The T87 checks held: the cancellation spec is serial with the shared fail-closed lock, and the OpenAPI replay-only text is qualified.
  - E2E log-event v14 `a1f2f779…` (the rollback target) → **v16 `0018df819efa95df4a26beb71204b44587b7e403279fb0dddb95e461bba0d6b3`**,
    entrypoint `file:///Users/…`, `verify_jwt` true, the other three unchanged.
  - Behaviour probe, no writes:
    - unkeyed `contract.cancelled` on a random contract → `400 type_not_allowed` (v14 answered 404);
    - control `dispute.opened` → `404 contract_not_found`.
  - All with `--workers=1`, `TF_LIVE_E2E` unset, run one at a time: guard 1/1, `cancellation-refusal` 4/4, `event-ingestion` 11/11, `guest-credential` 3/3. No skips.
  - **Production is still v16 `a1f2f779…`, which accepts `contract.cancelled`.** Production deploy and the push each need their own OK.
    Report: `.ada/claude-report-90.md`.
- Claude Task 91 (Kenji OK 14:05 ET), **refusing log-event in production**, log-event only, no DB change:
  - Production log-event v16 `a1f2f779…` (**rollback target**) → **v17 `0018df819efa95df4a26beb71204b44587b7e403279fb0dddb95e461bba0d6b3`**,
    equal to the E2E-tested artifact. Entrypoint `file:///Users/…`, `verify_jwt` true, the other three unchanged.
  - Probe (no writes): unkeyed `contract.cancelled` → `400 type_not_allowed`; control → `404 contract_not_found`. `smoke:prod` 16/16.
  - Then a normal push `3b6d01d..076be3b`, which published the updated `agent-protocol.md`.
  - This HANDOFF entry is a later local commit, not pushed. Report: `.ada/claude-report-91.md`.
- Claude Task 92: `scripts/lib/tfClient.mjs`'s session-cache exposure warning is now fixed text, with no file path (home directory).
  No other path-printing warning in that file. No unit test covers tfClient. Local only. Report: `.ada/claude-report-92.md`.
- Claude Task 94 (Kenji OK 14:16 ET; plan `.ada/claude-report-93.md`), **local only, ships with the next log-event rollout**:
  - The three `log-event` reads that dropped their DB error now fail closed with `500 lookup_failed`, as the owner pre-check does:
    - the chain-tip read (it used to fall back to GENESIS and end as contention);
    - the TF001 twin check (it used to answer 409 `wrong_state_for_event_type`);
    - the lookup after an idempotency-key 23505 (it used to loop to `chain_contention`).
  - None of them could write a duplicate or a wrong event; only the replies were wrong.
  - Files: `supabase/functions/log-event/index.ts`, `tests/unit/logEventHandler.test.js` (+5 tests; the fake's reads became an ordered queue, plus `.not` and an insert result).
  - `logEventHandler` + `eventWriteRules` 56/56. Each new 500 line, removed, fails exactly its test. Not deployed to E2E or production; not pushed.
- Claude Task 95 (Kenji's wording, 14:17 ET), **local only**:
  - A `contract.cancelled` event now reads "Cancellation claimed by <party> · not confirmed" in AgreementView (party from its `actorLabel`)
    and GuestEvidenceView (party from `event.actor.label`). It used to read "Cancelled" / "Agreement cancelled".
  - New `cancellationClaimLabel` in `src/lib/contractStatus.js`. Unit `contractStatus` 58/58 (+3).
  - The unreachable `CANCELLED` *state* label is unchanged, since no event projects into it. Display only: no change to writing, API or DB.
  - Not checked in a browser.
- Claude Task 96 (Codex 93 fixes on `e7f791f`), **local only**:
  - The claim names the **actual actor**: new `claimantOfActorId` (owner rows) and `claimantOfShapedActor` (guest-contract-events actors) in `contractStatus.js`.
    Unknown, legacy or missing actors → "a party", never a guess.
  - `App.jsx` gives both event shapes a `claimant` field. AgreementView uses it and drops the duplicate name beside a cancellation row.
    GuestEvidenceView guards a missing `event.actor`.
  - New render tests `tests/unit/cancellationClaimViews.test.js` (`react-dom/server`). `vitest.config.js` now uses the automatic JSX runtime, like the app build.
  - `contractStatus` + render tests 64/64, and a guessed-label mutation fails the tests.
  - **Browser check NOT done:** the cached owner session had expired (a sign-in is a write) and the guest view needs a reissue (an event write). It needs a decision.
    Report: `.ada/claude-report-96.md`.
- Claude Task 97 (Codex 94 fixes + legacy "by you" + browser check A; Kenji OK 18:03 ET), **local only**:
  - **Provenance:** a row names anyone only if the server derived its actor (`hash_version >= 2` / `trust_model: server_attested`). Older rows' actor ids were
    browser-chosen, so they read "a party".
  - **"you":** only for the **signed-in** user's id. The owner list never selected `earner_user_id`, which the browser check exposed.
  - Event shaping moved from `App.jsx` to `src/lib/agreementEvents.js`; it is safe on a missing actor. GuestEvidenceView renders only a nonempty, server-attested label.
  - Tests: render + mapping 68/68.
  - **Browser check:** one E2E `ownerSession()` sign-in, then read-only Playwright on fixture `5d0ce316-…` at 1280px and 375px. Correct claims, no overflow.
    Every non-GET was aborted and logged (only `POST /rest/v1/runtime_snapshots`).
  - GuestEvidenceView is render-tested only: reaching it needs an acceptance (a write).
- Claude Task 98 (Codex 95 fixes; Kenji OK 18:16 ET), **local only**:
  - **Provenance:** `hash_version` alone proves nothing. `20260924000001` defaulted it to 2 while inserts were still open, until `000002`
    (API-applied between 12:23:03 and 12:37:13 on 2026-09-24, per `20260924123733`).
  - So an actor is named only on a **contract created at or after 2026-09-25T00:00Z** (`SERVER_ONLY_EVENTS_FROM`): contract id and created_at are
    server-owned since `20260923000000`, and nothing re-grants event inserts.
  - GuestEvidenceView's byline now uses the same role rule as the claim; an unknown role is "a party" whatever its label.
  - `guest-contract-events` now returns `contract.created_at` (**needs deploy**; until then the guest path names nobody, which is fail-safe).
  - Tests 71/71; a mutation removing the contract-time condition fails 3 tests. Report: `.ada/claude-report-98.md`.
- Claude Task 99: plan only (option A). Report: `.ada/claude-report-99.md`.
- Claude Task 100 (option A, Kenji GO 18:28 ET), **local only**:
  - **No screen names an event's actor any more:** every row reads "by a party" / "Cancellation claimed by a party · not confirmed",
    the owner's own acts included.
  - Why: no event carries server-recorded per-event provenance. Every server-set field (`payload._actor_role`/`_authentication`, `server_recorded_at`,
    `hash_version`) was client-writable while events were world-writable, and date or migration-order heuristics are rejected.
  - The 2026-09-25 cutoff and all date/version checks are removed. `claimantOfActorId`/`claimantOfShapedActor` name someone only for the
    `SERVER_RECORDED_PROVENANCE` marker, which no caller supplies.
  - The `contract.created_at` addition to `guest-contract-events` is reverted (byte-identical to `402c277` again), so **no Edge Function deploy is needed**.
  - Tests `cancellationClaimViews` + `contractStatus` 65/65; re-allowing `hash_version` naming fails 3 tests.
  - **Restoring names is a separate task:** it needs a per-event provenance column (trigger-stamped, writer-overriding) or a server signature per event,
    then `guest-contract-events` returning it. That means a migration, a deploy and review (`.ada/claude-report-99.md`).
  - Strict-date hardening of display/sort parsing is also a separate, later task.
- Claude Task 101 (Codex T97 PASS on `231dbc2`): normal push `076be3b..231dbc2` (8 commits, origin/main = `231dbc2`), plus this HANDOFF line. The push deployed the frontend through Vercel; no backend deploy. `log-event`'s `50b2ae4` fail-closed lookups are pushed but **not deployed** (they ship with the next log-event rollout).
- Claude Tasks 102-105 (design only, nothing built): smoke:prod 16/16; provenance/delegation design iterated with Codex 98-100.
  - Current design: `.ada/claude-report-105.md`. Marker `server_asserted_v1`, stamped only for PostgREST + service-role-JWT inserts; TF006 fully specified.
  - The read-only E2E catalog audit found **`contracts` grants TRUNCATE to anon/authenticated** (not fixed; Kenji to decide).
- Claude Task 106 (Kenji 22:10 ET):
  - The T105 decisions are recorded in Decisions.md (2026-11-16).
  - New migration `20261117030000_revoke_client_truncate.sql` revokes TRUNCATE from anon/authenticated on `contracts` and `earner_payout_profiles`, with a read-only
    apply-time self-test over all five tables. `check-migrations` OK.
  - **Committed locally; not pushed, not applied** (E2E first, after Codex review).
- Task 101: Codex diff-only review of 1b477be -> .ada/codex-report-101.md (GO)
- Claude Task 107: `20261117030000_revoke_client_truncate.sql` **applied to E2E only** (`yqjtawffpesplqyurlpj`).
  - CLI 2.105.0 `ExecBatch` sends a file and its history insert as one implicitly transactional batch, so the self-test failing would roll back the revokes.
  - Dry run listed only that file; the push exited 0.
  - A read-only check confirms anon/authenticated have no TRUNCATE on all five public tables (service_role keeps it). E2E history ends at `20261117030000`.
  - **Production NOT applied. `1b477be` not pushed.** Report: `.ada/claude-report-107.md`.
- Claude Task 108: **blocked before any production command.** The CLI has no production DB password (no `PG*`/`SUPABASE_DB_PASSWORD`, no `~/.pgpass`, link on E2E), and the task forbids reading 1Password. Kenji needs to provide it. Nothing applied to production; no push.
- Claude Task 109 (Kenji chose A, 22:24 ET): `20261117030000_revoke_client_truncate.sql` **applied to production** (`fqgpzhwvvfsxswlnbbgg`), with the password via `op read` → `PGPASSWORD` only.
  - Dry run listed only that file; the apply re-gated the same, exit 0 (self-test passed).
  - Read-only check: anon/authenticated have no TRUNCATE on all five public tables (service_role unchanged). Production history ends at `20261117030000`.
  - **Both projects now match. `1b477be` is still not pushed** (a push needs its own OK). Report: `.ada/claude-report-109.md`.
- Claude Task 115 (A0): read-only catalog audit of production and E2E, identical apart from E2E-only `supabase_realtime_admin` memberships. Default ACLs found wide open; pg_graphql not installed. Report: `.ada/claude-report-A0.md`.
- Claude Task 116: migration `20261118010000_close_client_default_privileges.sql` (close `postgres`'s public defaults + PUBLIC function EXECUTE; `earner_payout_profiles` client writes revoked; client REFERENCES/TRIGGER/MAINTAIN revoked). Self-test TF901-TF904. **Committed locally; not applied, not pushed.** Report: `.ada/claude-report-116.md`.
- Task 105: Codex reviewed `73ef5cd` — `.ada/codex-report-105.md` (GO with changes).
- Claude Task 117 (Codex 105 fixes; amends the unpushed `73ef5cd`):
- Claude Task 118 (Codex 106 fixes; amends the unpushed migration commit again):
- Claude Task 119 (Codex 107 column point; amends the unpushed migration commit again):
  - Measured on local PG 17.6: a table-level REVOKE **does** remove the same privilege granted on columns (documented behaviour), so TF902's expected set was right.
  - TF901 gained `has_any_column_privilege` checks (REFERENCES on every table; INSERT/UPDATE on payout profiles).
  - Local edge cases pass: column grants planted before a fresh apply were removed and the final catalog equals Task 117's; a column grant planted after the revokes was caught with full rollback.
  - New throwaway script `/tmp/tf117/colprobe.sql`. **Not applied to E2E/production; not pushed.** Report: `.ada/claude-report-119.md`.
- Claude Task 120 (E2E apply of `20261118010000`): **blocked before any DB command.**
  - Task 107 got the E2E DB password only via `op read`. This task forbids that, and there are no `PG*`/`SUPABASE_*` env vars and no `~/.pgpass`.
  - CLI confirmed as `/opt/homebrew/bin/supabase` 2.105.0.
  - Nothing applied, no push, no production command, no tools created. Options A/B/C are in `.ada/claude-report-120.md`.
- Claude Task 121 (Kenji approved one `op read`): `20261118010000_close_client_default_privileges.sql` **applied to E2E only** (`yqjtawffpesplqyurlpj`), CLI 2.105.0.
  - The dry run listed only that file; the push exited 0 (self-test TF901-905 passed).
  - Read-only post-check: all PASS. The A0 before/after diff shows only the targeted grant and default-ACL changes. E2E history ends at `20261118010000`.
  - Throwaway files, not in the repo: `/tmp/tf121/` (`post.py`, `a0-before.txt`, `a0-after.txt`).
  - **Production NOT applied. `7fb5925` not pushed** (each needs Kenji's OK). Report: `.ada/claude-report-121.md`.
- Claude Task 122: ran only the live guest/event/agreement E2E specs against E2E after `20261118010000`: `guest-evidence`, `guest-credential`, `event-ingestion` and `agreement-binding` (chromium, `--workers=1`). **41 passed, 1 failed.**
  - The failure is `guest-evidence.spec.js:296` (line 370 expects "UI Flow Earner" in the trail). This is a **stale assertion** from `231dbc2`, after which every trail row reads "by a party". It's unrelated to the revokes, and every earlier read/accept step in that test passed.
  - The test fix is open, as a separate task. No code was changed, no production, no push.
  - HANDOFF is uncommitted (a commit runs the test gate). Log: `/tmp/tf122-run.txt`. Report: `.ada/claude-report-122.md`.
- Claude Task 123 (Kenji approved 2026-11-18 09:21 ET): `20261118010000_close_client_default_privileges.sql` **applied to production** (`fqgpzhwvvfsxswlnbbgg`), CLI 2.105.0, one `op read` → `PGPASSWORD` only.
  - The dry run listed only that file; the push exited 0 (self-test passed).
  - Read-only post-check: 7/7 PASS. The A0 before→after diff is identical to E2E's. The after-states match apart from E2E-only realtime memberships.
  - `smoke:prod` 16/16 ok. **Both projects now have the migration.**
  - Rollback SQL (not run) is in the report; the pre-state is in `/tmp/tf123/a0-before.txt`.
  - **`7fb5925` still not pushed** (needs Kenji's OK). HANDOFF is uncommitted (test gate). Report: `.ada/claude-report-123.md`.
- Claude Task 124 (plan only, no code): planned the rank-1 provenance fix (Codex T109). Report: `.ada/claude-report-124.md`.
  - Split `trust_model` into hash format (`canonical_version`) and authorship (`provenance: unknown` until the `server_asserted_v1` marker exists), keeping every `verified` verdict unchanged.
  - Also covers the UI badge, the owner and guest exports, `describeActor` and the protocol. No DB change.
- Claude Task 125: `guest-evidence.spec.js` now expects the trail to read "by a party" and to carry no other byline, instead of the earner's name (stale since `231dbc2`). The spec ran alone against E2E, 13/13. Report: `.ada/claude-report-125.md`.
- Claude Task 126 (plan only, no code): revised the rank-1 provenance plan per Codex 110 and Kenji's four decisions. Report: `.ada/claude-report-126.md`.
  - `response_version: 2`; frontend first, function ≥24 h later; rollback is function first.
  - Old frontend × new function is the unsafe cell.
- Claude Task 127 (plan only, no code): third revision of the rank-1 plan per Codex 111. Report: `.ada/claude-report-127.md`; decisions D1-D4 are Kenji's.
  - v2 is opt-in via `?response_version=2`, and requests without a version are refused after a flip, so old clients never parse v2.
  - The guest document is built from an allowlist; summaries are computed from all row outcomes.
- Claude Task 128 (plan only, no code): fourth revision of the rank-1 plan per Codex 112. Report: `.ada/claude-report-128.md`; decisions D1-D5 are Kenji's.
  - Each rollback's real effect is stated (R1-R4), and malformed rows fail closed.
  - All 13 in-repo callers that don't send a version are migrated before the flip; stub route globs fixed.
- Claude Task 129 (Kenji OK 10:19 ET, D1-D5 decided as recommended):
  - **Pushed:** `7fb5925`, `117a5e9` and the docs commit `7a237f7` (normal push; this deploys the Vercel frontend). **Remote tip `7a237f7`.**
  - **Built rank-1 commit 1, local only, NOT pushed** (frontend, both exports, public docs; plan rev 4 plus Codex 113).
    - New `src/lib/eventFormat.js`: fail-closed shape validation; per-check results; status with only its first state renamed.
    - The guest document 2.0 is built from fixed key lists. Owner export 2.0 has a tri-state `payload_hash_in_format`.
    - The page asks for `?response_version=2`.
    - New test helper `tests/e2e/guestEvidenceStub.js`. Stub globs fixed, and an unstubbed function call fails the test.
  - **Tests:**
    - unit: eventFormat, guestRecordExport, auditExport, cancellationClaimViews, shownTerms, eventCanonical, claimPresentation all pass
    - stubbed E2E: agreement-record-ui, agreement-export, guest-path-capture pass
    - visual-accessibility: 2 tests fail in both projects (`contracts home`, owner `record of agreement`), on contrast in files commit 1 does not touch (`ContractsHomeView.jsx:403`, `AgreementView.jsx:232`). Not fixed; the guest-record contrast test passes.
  - **Live `guest-evidence.spec.js`:** its UI wording assertion was edited to match, but it was **not run** (needs a separate OK).
  - **Not built:** commit 2 (function opt-in) and commit 3 (flip). Report: `.ada/claude-report-129.md`.
- Claude Task 130 (Codex 114 fixes on commit 1; new local commit on top of `b4cbd52`, **not pushed**):
  - The public docs now say response version 2, its errors and the flip are **planned, not deployed**; the deployed function returns v1 even with `?response_version=2`.
  - The guest screen's hash wording is per format present, and payload coverage is per row.
  - The guest document gains an all-row `verification.check_summary` and a `status_note` (status order unchanged).
  - Null reasons are named only when established; payloads are validated; owner instructions 3-4 assign no cause; the snapshot absent-vs-null notes are distinct.
  - New tests: `tests/unit/publishedResponseVersion.test.js`, `tests/unit/guestEvidenceCoverage.test.js`.
  - **Results:** unit all pass. Stubbed E2E 35 passed / 5 failed: the 4 known contrast failures, plus `guest-path-capture` chromium hitting its 30 s budget at the final full-page screenshot in a ~5x slower run.
  - Report: `.ada/claude-report-130.md`.
- Claude Task 131 (Codex 115 findings 1-2; new local commit on top of `ae05838`, **not pushed**):
  - Each hash-format coverage sentence is self-contained (names every field it binds and what it does not). v1 "does not bind" a previous link.
  - One format-aware `payloadProjectionNote` replaces "the hash covers the whole payload" on the screen and in the download explanation. The guest document no longer promises a digest mismatch.
  - Unit tests (eventFormat, guestEvidenceCoverage, guestRecordExport, cancellationClaimViews) pass, 85/85. **No E2E run.**
  - **Still blocking a verified push (Codex 115 finding 3):** the chromium `guest-path-capture` screenshot timeout and the 4 owner/home contrast failures. They need a targeted rerun and a `7a237f7` baseline, each with OK.
  - Report: `.ada/claude-report-131.md`.
- Claude Task 132 (Kenji OK, run only): the chromium `guest-path-capture` "what the counterparty is shown" test on `b5eebd3` **passed in 6.5 s** of its 30 s budget.
  - The final full-page screenshot took ≤0.72 s (page 1280×1521).
  - Task 130's timeout was that run's load (~5× slower), not the longer page. No fix needed. Report: `.ada/claude-report-132.md`.
- Claude Task 133 (Codex 116; new local commit on top of `b5eebd3`, **not pushed**):
  - The guest document says v3/v4 bind the recorded payload-digest **field** (may be empty); its match is the separate `substance_valid`.
  - The coverage lines say v2-v4 bind the recorded predecessor-hash input (GENESIS when none), and the digest fields are recorded and may be empty. One line says link validity and digest matches are separate checks.
  - The stale live `guest-evidence.spec.js` coverage assertion was rewritten to the format-aware meaning. **Not run.**
  - Unit tests: guestRecordExport, eventFormat, guestEvidenceCoverage, 81/81.
  - **Still open before push:** the 4 contrast failures (Kenji: baseline vs two-class fix), a live `guest-evidence` run (needs OK), and Codex re-review. Report: `.ada/claude-report-133.md`.
- Claude Task 134 (Kenji chose the fix): contrast `text-slate-600`→`text-slate-400` (`ContractsHomeView.jsx:403`) and `text-slate-500`→`text-slate-400` (`AgreementView.jsx:232` back button). Stubbed `visual-accessibility` 6/6; local commit, not pushed. Report: `.ada/claude-report-134.md`.
- Codex Task 118: clarify which checks the guest screen counts and which digest comparisons need separate verification; commit: this line's commit (`git log -1 -- HANDOFF.md`).
- Claude Task 136 (Kenji OK, run only): live `guest-evidence.spec.js` against E2E (`yqjtawffpesplqyurlpj`) on `eee0889`, chromium, `--workers=1`, run once: **13 passed, 0 failed** (1.3 min). No DB password, no code change, no push. Log: `/tmp/tf136-run.txt`. Report: `.ada/claude-report-136.md`.
- Claude Task 137 (Kenji OK 16:20 ET): normal push `7a237f7..eee0889` (6 commits `b4cbd52`..`eee0889`) to origin/main, exit 0. Vercel status right after: pending ("deploying"). Report: `.ada/claude-report-137.md`.
- Claude Task 138 (review only): light review of Codex's production-flow spine plan `.ada/codex-report-120.md`. Agree with the order and with step 1 first; ship AI2Human first, keep the guest bearer as a supervised pilot, and recommend a guest-derived delegation as the AI2AI issuer. Report: `.ada/claude-report-138.md`.
- Claude Task 139 (light review of `75a1c3f` `docs/entry-contract.md`): **fix-first**, 2 blockers. (1) Persist the counterpart account on the deal at acceptance, so post-acceptance grants have a binding. (2) The issuer account must not be the deal owner (otherwise the owner can be their own counterpart). Report: `.ada/claude-report-139.md`.
- Codex Task 122: defined the first-deal entry contract, including Kenji's counterpart-account issuer choice, in `docs/entry-contract.md`; design only, pending cross-review. Report: `.ada/codex-report-122.md`.
- Claude Task 140: `Roadmap.md` rebuilt from this file as the canonical roadmap (spine: entry path first; payment parked). Uncommitted. Report: `.ada/claude-report-140.md`.
- Claude Task 141: design reset. Draft `docs/minimum-usable-design.md` (minimum, trunk state, contradictions, work breakdown); "Next Priority" replaced; scoped-key note superseded. Step-2 code on hold. Uncommitted. Report: `.ada/claude-report-141.md`.
- Claude Task 142: recorded the rule that the first deal runs through bot simulations and that design never waits for real deals (`Decisions.md` 2026-11-18). Older wait-for-real-users lines are marked superseded, and `Roadmap.md` and `docs/minimum-usable-design.md` are reworded. Docs only, uncommitted. Report: `.ada/claude-report-142.md`.
- Claude Task 143: recorded Kenji's C1-C3 and the issuance-UI decision (`Decisions.md` 2026-11-19); `docs/minimum-usable-design.md` marks them resolved and piece 4 required; the agent-first-access proposal and `codex-report-121` hash line are marked superseded. Docs only, uncommitted. Report: `.ada/claude-report-143.md`.
- Codex Task 124: reviewed the minimum design and set the dated baseline in `docs/schedule.md`; M1 2026-12-01, M2 2026-12-02, M3 2026-12-10, M4 2026-12-11. C5 create-path conflict remains explicit; Task 123 code stays on hold. Report: `.ada/codex-report-124.md`.
- Codex Task 125: C5 requires server-side create and closing direct inserts; C3 applies to RLS email matching, no `issuer_assurance`, credential ID inside v5 hash. Baseline rev 2 is in `docs/schedule.md`; a minimum-design follow-up patch failed and was not retried, leaving stale sections to correct. Task 123 code remains on hold. Report: `.ada/codex-report-125.md`.
- Claude Task 144: reconciled `docs/minimum-usable-design.md` with schedule rev 2 (Codex 125's failed patch). The breakdown follows the schedule IDs with the resolver kept as 4a, the C3 email paragraph is corrected (RLS included), and proposals (a)-(c) are added as PROPOSED, pending Kenji. Mismatch: the schedule gives resolver + append 1d total. Docs only, uncommitted. Report: `.ada/claude-report-144.md`.
- Claude Task 145: recorded Kenji's (a)-(c) (`Decisions.md` 2026-11-19): (b) grant evidence kept, and a draft with any grant cannot be deleted; (c) v5 fixed order + `hash_version` + domain separator; (a) creation snapshot deferred. `docs/schedule.md` is now baseline rev 3: row 4 is 2d, M1 2026-12-04, M2 12-07, M3 12-15, M4 12-16 (+1 working day vs rev 2). Design and Roadmap updated. Docs only, uncommitted. Report: `.ada/claude-report-145.md`.
- Claude Task 146: recorded Kenji's whole-design sign-off (`Decisions.md` 2026-11-19): design CONFIRMED, execution authorized in schedule rev 3 order. Row 0 started 11-19 (Codex Task 126), on schedule (0 days). The account-deletion FK and pre-acceptance snapshot risks stay open. Docs only, uncommitted. Report: `.ada/claude-report-146.md`.
- Codex Task 128: added repeatable local two-session race tests and SQL owner/privilege/refusal tests; SQL, 775 unit tests and build passed. REST/GraphQL endpoint bypass coverage and parts of the full race matrix remain; row 1 is not complete. Report: `.ada/codex-report-128.md`.
- Codex Task 127: row 1 implementation and local tests are uncommitted; issuance remains off. Grant retention and locked delete refusal are implemented; additional race coverage and Claude light review remain. No E2E or production changes. Report: `.ada/codex-report-127.md`.
- Claude Task 147: row 0 light review of Codex T126; row 0 closed 2026-11-19 (on schedule). The v5 preimage is marked open for row 3 (13-key candidate = proposal only; C2 payload-vs-top-level open), and the row 1 input is the T126 must-fix list. Corrected: no RLS policy compares `hirer_email` today (`20261011212432`). Docs only, uncommitted. Report: `.ada/claude-report-147.md`.
- Codex Task 130: row 2 plan review recommends authenticated RPC and staged cutover, but identifies response/client compatibility, omitted bot scripts, and unproven validation parity as blockers to the plan; B requires catalog, request, rollout and recovery proof. Report: `.ada/codex-report-130.md`.
- Codex Task 129: full row 1 review; core implementation consistent on static review, but independently counting done is blocked by local race suite Docker socket permission denial (no retry). `make check` passed 778 tests and build. Catalog scan has explicit blind spots; remaining invite/account races and later consumer checks are listed. No hosted access or code changes. Wake failed reading webhook secret (CalledProcessError), no retry. Report: `.ada/codex-report-129.md`.
- Claude Task 163 (2026-11-20, Kenji OK 18:02 ET, E2E only): **row 1 `20261118214020` + migration A `20261120090000` applied to E2E** (`yqjtawffpesplqyurlpj`) in normal history order, CLI 2.105.0, one `op read` → `PGPASSWORD` only.
  - Migration B (`20261120180000`, committed by Codex at `5609c46`) was already in HEAD. So the push ran from a scratch worktree at `5a7f2be`, where both files are byte-identical to HEAD, and a gate required the dry run to list exactly those two files. B is **not** applied and stays pending; no hand-written history, no `--include-all`.
  - Read-only verify all PASS: history head `20261120090000`; credential table RLS on with no client privilege; row 1 RPCs service_role only; `create_entry_contract` SECURITY DEFINER with empty search_path, owner postgres, EXECUTE for authenticated only; postgres holds `auth.users` UPDATE; authenticated SELECTs every contracts column; contracts RLS on with the 4 policies unchanged and the owner read policy party-only; direct insert still open (B pending); row 1 inventory PASS; pg_graphql absent.
  - Rehearsal: `currency.spec` (A-stage, `--grep-invert @post-b`) 9 passed; `api-e2e` 32/0; `race-delete-vs-append` 20 trials PASS; `sim-counterparty` 19/0; `owner-agent` via `sim:two-agents` PASS (CAD create HTTP 200, full trail 5 events); `offer-for-tester` created an offer (E2E).
  - No push, no production, issuance off (edge function not deployed). This HANDOFF line is uncommitted. Report: `.ada/claude-report-163.md`.
- Claude Task 162 (2026-11-20, E2E rehearsal of row 2 stage A): **STOPPED before any write.**
  - The E2E `db push --dry-run` (CLI 2.105.0, one `op read`, `PGPASSWORD` only) lists **two** pending files: `20261118214020_entry_agent_credentials.sql` (row 1, never authorized for E2E) and `20261120090000_create_entry_contract.sql`. A push of A alone is impossible in order.
  - Nothing applied; Playwright and the 5 scripts were not run (they need the RPC on E2E); no push, no production.
  - Needs Kenji: (A, recommended) approve row 1 + A together on E2E, or (B) an out-of-order A-only apply with a manual history row (not recommended).
  - This HANDOFF line is uncommitted. Report: `.ada/claude-report-162.md`.
- Claude Task 161 (2026-11-20, local only): removed the 12 unused `userId` destructurings in 8 E2E specs (lint-only), then `npm run lint` 0 errors (9 pre-existing warnings), `make check` 779/779. One local commit of T143 + T160 fixture + lint fixes + HANDOFF/Roadmap/schedule. **Not pushed, not applied.** **Open item (gate mismatch):** `make check`, the documented pre-commit gate, does not run `npm run lint`, but `.claude/hooks/pre-commit-verify.sh` does, so a green `make check` can still be refused at commit (T160). Align them later: add lint to `make check`, or document both. Report: `.ada/claude-report-161.md`.
- Claude Task 160 (2026-11-20, local Docker only): fixed the T159 blocker in `tests/sql/create_entry_contract_races.sh`. The `--no-privileges` fixture now gets `grant select on public.contracts to authenticated`, as both hosted projects have; T143's assertion is untouched. Create races 9/9 + snapshot parity, harness check ALL PASSED, `make check` 779/779.
  - **Commit BLOCKED by the pre-commit hook:** `npm run lint` fails with 12 `no-unused-vars` errors (`userId`) in E2E specs from the writer conversion: atomic-acceptance, cancellation-refusal, currency ×3, evidence-core, guest-credential, guest-evidence ×3, invite-persistence, mixed-surface.
  - Nothing committed; head is still `6371d87`.
  - Fix: drop or `_`-prefix each unused `userId`, then make the planned commit.
  - Report: `.ada/claude-report-160.md`.
- Claude Task 159 (2026-11-20, local Docker only): reviewed Codex T143. The migration change is an apply-time catalog assertion only; RPC output, stored row and hash are unchanged. **BLOCKED, no commit.**
  - `tests/sql/create_entry_contract_races.sh` fails at migration apply: `ERROR: create_entry_contract returns a column authenticated cannot select`. Its fixture restores with `--no-privileges`, so the new assertion fires as designed. This is a fixture conflict, not an RPC bug.
  - Fix (Codex or next task): give that fixture the client SELECT grant, or use the faithful restore.
  - Passed: SQL suite, harness check, row 1 races 6/6, fault injection (apply fails and rolls back; clean control applies), `make check` 779/779 (T158's 2 failures did not recur).
  - Report: `.ada/claude-report-159.md`.
- Claude Task 158 (2026-11-20, local Docker only, uncommitted): made the Codex T140 fault-injection proof non-vacuous. Each fault prints `FAULT-INJECTED: <name>`. `tests/sql/create_entry_contract_harness_check.sh` requires that marker, the expected reason and status, and no restore. It adds a healthy control (restore + ALL PASSED) and proves an early setup failure (missing container) is judged FAIL. Harness check ALL PASSED. **`make check` FAILED, 2 unit tests outside this work** (`eventFormat.test.js` guestChainStatus property test, `verifyReceipt.test.js` 'who performs is flipped'; 777/779). They were not retried; the cause is unknown and the working tree has no change in their code. Report: `.ada/claude-report-158.md`.
- Claude Task 157 (2026-11-20, local Docker only, uncommitted): closed the Codex T139 harness gap in `tests/sql/create_entry_contract.sh`. The TOC is written whole by one checked command and filtered in separate checked steps (no `sh -c` pipeline). The excluded event triggers must equal the reviewed 7 exactly. New `tests/sql/create_entry_contract_harness_check.sh` injects a partial-and-failing TOC and an unreviewed event trigger; both stop the runner before restore. SQL suite ALL PASSED, create races 10/10 (9 + parity), `make check` 779. Awaiting Codex's final OK before commit. Report: `.ada/claude-report-157.md`.
- Claude Task 156 (2026-11-20, local Docker only, uncommitted): fixed Codex T138 blockers 1-2 and the `api-e2e.mjs` should-fix, all in tests/scripts.
  - **Runner:** the `create_entry_contract.sh` fixture is now a fail-closed restore. It runs as `supabase_admin` with owners and ACLs kept, the DB is owned by `postgres`, and only the 7 event triggers are excluded, via a TOC list. It asserts policies, triggers, functions, ownership and effective grants.
  - **SQL:** assertions are NULL-safe through `check_created()`, with 18 negative controls. Row counts now bypass RLS: the old refused-caller "no row" check was vacuous.
  - **Results:** SQL suite ALL PASSED, create races 9/9 + parity, row 1 races 6/6, `make check` 779. No RPC bug found.
  - Report: `.ada/claude-report-156.md`.
- Claude Task 155 (2026-11-20, local Docker only, uncommitted): new `tests/sql/create_entry_contract_races.sh` + `tests/sql/snapshot_parity.mts`. **PASS:** 9 two-session cases (unconfirm/email change vs create both orders; create vs credential issue and vs draft delete both orders: no deadlock, no unexpected wait, owner correct) and snapshot v1 bytes + `agreement_hash` identical for RPC-created vs legacy-inserted deals. Reruns: `create_entry_contract.sh` ALL PASSED, row 1 races 6/6. **Blocked, not run:** the 5 converted scripts. `scripts/lib/e2eGuard.mjs` refuses any URL but the E2E project ref, and they need edge functions, so a local REST run needs a guard change (Codex) or an authorized E2E run after stage A is applied there. PostgREST coercion is untested for the same reason. Report: `.ada/claude-report-155.md`.
- Claude Task 154 (2026-11-20, local Docker only, uncommitted): new `tests/sql/create_entry_contract.sql` + runner `tests/sql/create_entry_contract.sh` (disposable DB, schema with grants, row 1 + Codex T134 draft `20261120090000` applied) for stage A of row 2. **All 9 groups PASS** (privileges/definer lock, anon, no-sub/unconfirmed/anonymous/unknown, owner create shape and terms, spoof, 37-case parity, atomicity, READ COMMITTED). No migration bug found. Row 1 race suite re-run: 6/6 PASS. Not yet covered: two-session create races, REST/browser flow, snapshot/hash parity (later stage-A gates). Report: `.ada/claude-report-154.md`.
- Claude Task 153 (2026-11-20, Kenji approved 07:24 ET): committed the row 1 close-out docs (`HANDOFF.md`, `docs/minimum-usable-design.md`, `docs/schedule.md`) and pushed main to origin with a normal push. That also pushed `75a1c3f`, `918d25c`, `6942691` and `1e128b6`, and triggers Vercel's production frontend deploy (frontend change: the TF007 delete-refusal mapping only). No migration applied and no edge function deployed: the row 1 migration and `manage-entry-agent-credential` are still not on E2E or production. `docs/plans/` (Codex revising) and `supabase/.branches/` stay uncommitted. Report: `.ada/claude-report-153.md`.
- Claude Task 152 (2026-11-20, verification only): independent re-run of `tests/sql/entry_agent_credentials_races.sh` at `1e128b6` on the disposable local DB: **6/6 PASS, exit 0**, first run, no leftover database. With Codex T129 (no code violation, `make check` 778), row 1 counts as **verified 2026-11-20**. Docs only, uncommitted: the schedule row 1 Actual and the stale row 1 labels in `docs/minimum-usable-design.md`/`docs/schedule.md`. **Deferred, before activation** (branch work, must land before `ENTRY_CREDENTIAL_ISSUANCE` is turned on):
  - T129 should-fix 2: the TF914/inventory bypass check is a bounded text scan. Inspect reachable definers, views, rules and dependencies, including opaque bodies, indirect calls, SQL-standard (parsed) function bodies and column-only view grants, and fail closed on unreviewed paths.
  - T129 should-fix 3: more durable race orderings. Invite expiry during each lock wait, plus the other account-change/verification orderings from T127/T128.
  Report: `.ada/claude-report-152.md`.
- Claude Task 151 (plan only, no code, uncommitted): row 2 (C5 create) trunk plan at `docs/plans/row2-c5-create.md`. Recommends a SECURITY DEFINER `create_entry_contract` RPC for `authenticated` only (owner = `auth.uid()`, verified account under a FOR SHARE user lock, same columns and terms, no rewriting, no event), then two migrations: A additive, B revoking client INSERT and dropping the permissive policy, with a TF92x self-test. About ten E2E specs insert directly and must switch first. No Kenji questions. Awaiting Codex review; row 2 is planned 11-23–24. Report: `.ada/claude-report-151.md`.
- Claude Task 150 (Kenji OK 2026-11-19 12:16 ET): row 1 **closed locally, pending Codex review of T149/T150**. Production `GET /auth/v1/settings` (once, anon key only): `mailer_autoconfirm=false`, so C3 holds in both projects. 30-day expiry cap and the email-confirmation precondition recorded in `docs/entry-contract.md` §2/Principals and `Decisions.md` 2026-11-19. Local commits on main, **not pushed**: `6942691` (row 1 code/tests) + the docs commit after it. `make check` 778 tests, SQL fixture + inventory, races 6/6 pass. Not applied to E2E or production (separate OK). **Deferred (branch, later):** TF007 red toast vs TF004 info toast; race-suite portability (tied to `trustflow-localdb`); `revoked_at` bounds (`>= created_at`, `<= now`) in the evidence trigger; contract-state check on issuance (rows 4/11). `supabase/.branches/` is a CLI artifact, not committed. Report: `.ada/claude-report-150.md`.
- Claude Task 149 (row 1 should-fixes, local only, uncommitted, not applied anywhere): **done:** (1) apply-time self-test TF911-TF914 in the credential migration (table/column/PUBLIC/service_role grants, RLS, `counterpart_account_id`, the three RPCs, issuance owner's UPDATE on `auth.users`, side-door scan of functions/views/rules, pg_graphql definer check), each fault injection caught; (4) `expires_at` ≤ 30 days in table CHECK, RPC and edge handler, strict ISO instant → 400 and canonical UTC to the RPC; (5) `tests/sql/entry_agent_credentials_inventory.sql`, read-only, PASS locally and on E2E; immutability errcode renamed TF006→TF008. **E2E read-only:** `postgres` holds UPDATE on `auth.users` (should-fix 2 closed), `mailer_autoconfirm=false` (should-fix 3 closed for E2E; **production unchecked**, Kenji to be asked), pg_graphql absent. `make check` 778 tests, SQL fixture, races 6/6 pass. **Left:** Codex review, production autoconfirm answer, local commit, E2E apply. Report: `.ada/claude-report-149.md`.
- Claude Task 148 (read-only review of row 1 so far, Codex T127+T128): no blocker. Grant evidence (no delete/rewrite, one-way revoke) and TF007 under the contract lock hold; C3 uses only the verified account email. Row 1 is **not done**. It still needs: privilege self-test inside the migration, read-only E2E catalog checks (`auth.users` lock privilege, email autoconfirm off, client-executable SECURITY DEFINER functions/views), and an expiry cap. REST/GraphQL bypass is provable in SQL via effective privileges. `make check` 775/775. Report: `.ada/claude-report-148.md`.
- Task 107: Codex reviewed `63acb67` — `.ada/codex-report-107.md` (GO with changes).
  - The self-test snapshot is now a temp view with grantor and grant option, compared as multisets (`EXCEPT ALL`), with public function ACLs included.
    TF903 checks the global function default exactly (built-in `acldefault` minus only PUBLIC EXECUTE). Limits stated: nothing outside `public` is compared.
  - **The real `supabase db push` 2.105.0 is proven transactional** against the local disposable DB: a probe whose `CREATE TABLE` succeeded and whose next statement raised left no table and no history row.
  - Local: catches proven for a planted grant (TF901), a grant-option-only change (TF902) and an extra default ACL (TF903); every failure rolled back to an identical catalog; the real apply matches Task 117's post-state; role paths unchanged.
  - Local DB left with the migration applied (history 49). The throwaway CLI role `tf_cli_probe` was dropped.
  - **Throwaway scripts, not in the repo:** `/tmp/tf117/` (`apply1.sh`, `dump.sh`, `dump.sql`, `reverse.sql`, `aclcmp.py`, `paths.sql`) and `/tmp/tf118/cli/` (the CLI probe workdir). Kept for re-runs: `.ada/a0-catalog-audit.py`.
  - **Not applied to E2E/production; not pushed.** Report: `.ada/claude-report-118.md`.
- Task 106: Codex reviewed `17345f3` — `.ada/codex-report-106.md` (GO with changes).
  - The role-wide PUBLIC-EXECUTE revoke is kept and documented; a per-schema revoke was measured as ineffective on PG 17.6.
  - The self-test now compares every relation, column and default ACL before and after, and probes use collision-safe random names.
  - **Local disposable DB only:** both forced failures (self-test catch; end of file) rolled back to an identical catalog. The real apply diff showed exactly the targeted ACL changes; browser and Edge role paths were checked.
  - **Not applied to E2E/production; not pushed.** Report: `.ada/claude-report-117.md`.

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

~~A first-party scoped API key is deferred until there are outside users.~~
**Superseded by the 2026-11-18 spine** (and by the rule that nothing waits for
outside users): per-deal scoped, revocable agent
credentials are the entry path (`docs/entry-contract.md`,
`docs/minimum-usable-design.md`). The refresh token above stays only until they ship.

---

## Next Priority (in order)

Referenced by name from `scripts/sim-counterparty.mjs` and two proposals, so the
heading keeps its old wording.

**Design reset (Kenji, 2026-11-18) — complete.** The design was confirmed and execution
authorized on 2026-11-19 09:59 ET (`Decisions.md`). Canonical roadmap: `Roadmap.md`.

1. **Execute `docs/schedule.md` baseline rev 3 in row order** (M1 2026-12-04, M2 12-07,
   M3 12-15, M4 12-16). Fill the Actual column as rows start and finish.
2. **Where we are (2026-11-20):** row 0 finished and row 1 was verified (T129/T152). Row 2 stage A is locally committed in `6371d87`, with before-B changes in `d2e4b9f`; neither is pushed and migration A is not applied. Row 2 remains in progress; see `docs/schedule.md`.
   The v5 preimage is still open (row 3): Codex's 13-key candidate is a proposal, not adopted.
3. Production releases (rows 9, 14) still need Kenji's separate OK.

**Step-2 code** was locally committed and row 1 verified; its migration and credential function are not applied or deployed to E2E or production.

**Still open** (not decided by the sign-off): account deletion blocked by the grant
issuer FK; pre-acceptance delegated events have no accepted snapshot.

The previous list (counterparty sim, first non-JPY production acceptance,
cancellation, `App.jsx`, MCP, blind-review findings) is now under "Later" in
`Roadmap.md`. One owner decision from it still stands: **a real second person is
never a required gate**; AI drives the counterparty.

---

## Open decisions

- **`hirer_email` is compared case-sensitively and stored as typed.**
  _(Correction, Task 147: per migration source, `20261011212432` replaced
  `party_read_contract_events` with an owner-only policy, so the RLS `=` below is
  historical. What remains is how `hirer_email` is stored and compared elsewhere.)_
  _(2026-11-19, C3: the entry path's invited-email match is `lower(btrim())`; see
  `Decisions.md`. Whether C3 also covers the `hirer_email` / RLS `=` comparison below is
  not decided; raised in `.ada/claude-report-143.md`.)_
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
That is a limit to state, not a gate: the first deal runs through bot simulations,
and design does not wait for real parties (`Decisions.md` 2026-11-18).

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

- Codex Task 131: revised row 2 trunk plan for RPC/client compatibility, writer inventory, validation parity and cutover gates; estimated 3–4 working days plus separately authorized rehearsal against the two-day baseline. Docs only. Report: `.ada/codex-report-131.md`.

- Codex Task 132: incomplete; added `supabase/.branches/` to `.gitignore`, but stage A RPC, client/writer conversion and tests remain unbuilt. Docker check denied access to its socket and was not retried; no commit or hosted access. See `.ada/codex-report-132.md` before resuming.

- Codex Task 133: incomplete; no stage A RPC, writer conversions or new tests written. `make check` passed on existing code (778 tests, build); Docker untouched. No commit or hosted access. Report: `.ada/codex-report-133.md`.

- Codex Task 134: incomplete, do not deploy; unverified stage A RPC draft and app RPC call exist, focused tests and `make check` pass (779 tests), but writer conversion, SQL/race tests and catalog/REST verification remain. No commit. Docker Desktop responded outside sandbox (29.9.3); sandbox socket access was denied. Report: `.ada/codex-report-134.md`.

- Codex Task 135: incomplete; converted create calls in five scripts to the RPC, but E2E specs and B-pending bypass cases remain. `make check` passed 779 tests/build; changed scripts not exercised against an API. No commit, Docker, hosted access or migration/SQL edits. Report: `.ada/codex-report-135.md`.

- Codex Task 136: incomplete; `event-ingestion` success fixture converted to RPC and API script comment corrected, other E2E specs and B-pending cases remain. `make check` passed 779 tests/build; E2E not run. No migration/SQL edits, Docker, hosted access or commit. Report: `.ada/codex-report-136.md`.

- Codex Task 137: converted remaining E2E success fixtures to RPC and added RPC invalid-term cases; direct INSERT negatives are B-pending and the legacy success case is explicitly A-to-B only. `make check` passed 779 tests/build and spec syntax checks; local E2E remains unrun. No migration/SQL edits, Docker, hosted access or commit. Report: `.ada/codex-report-137.md`.

- Codex Task 138: BLOCKED, no commit. Stage A SQL runner suppresses all schema-restore errors and SQL assertions can pass NULL; see `.ada/codex-report-138.md` for fixes and other findings. **Deploy order: apply and verify migration A on target before deploying frontend containing the RPC client**; pushing first breaks creation. No hosted access or Docker in this review.

- Codex Task 139: BLOCKED, no commit. T156 closes NULL and empty-control issues, but TOC generation runs `pg_restore -l | grep` in `sh` without pipefail; partial output with a failed producer can pass. See `.ada/codex-report-139.md`. Migration A must be applied and verified before frontend with the RPC client is deployed.

- Codex Task 140: BLOCKED, no commit. T157 fixes normal TOC pipeline, but fault harness accepts any pre-restore failure, including setup failures before injection; require fault-specific markers and a healthy control. Report: `.ada/codex-report-140.md`. Apply and verify migration A in target before pushing/deploying the RPC frontend.

- Codex Task 141: BLOCKED, no commit. T158 fault-harness source closes T140; focused record tests passed 59/59 three times, but full `make check` failed 778/779 on eventFormat 5000 ms timeout. T158 receipt assertion failure lacked output and remains unexplained. Report: `.ada/codex-report-141.md`. Apply and verify migration A before pushing/deploying the RPC frontend.

- Codex Task 142 (historical): scoped the matrix timeout to 30 seconds without removing cases; receipt tamper failures now include child exit/signal/code/stdout/stderr. Focused suite 59/59 and two consecutive `make check` runs 779/779 + build passed. Stage A was subsequently committed as `6371d87`; migration A must be applied and verified on the target before pushing/deploying the RPC frontend. Report: `.ada/codex-report-142.md`.

- Codex Task 143 (historical): before-B changes (migration A apply-time SELECT check and currency direct INSERT tests expecting B's 403/42501) were subsequently committed as `d2e4b9f`. SQL/fault checks were later reported by Claude; post-B HTTP tests remain unrun. Migration A before frontend deployment; report `.ada/codex-report-143.md`.

- Codex Task 146: currency stage selection uses explicit tags. A: `npx playwright test tests/e2e/currency.spec.js --project=chromium --grep-invert '@post-b'`; after B: `npx playwright test tests/e2e/currency.spec.js --project=chromium --grep '@post-b'`. The post-B set includes a valid direct INSERT denial. Independent SQL constraint coverage remains required. Neither command was run in T146; report `.ada/codex-report-146.md`.

- Codex Task 147: local migration B drafted to revoke client table/column INSERT and drop the creation policy, with fail-closed effective privilege and policy checks. Lint and `make check` passed; B was not applied and its SQL, catalog/bypass and `@post-b` HTTP tests remain unverified. Claude T162's uncommitted rehearsal notes are preserved. Report: `.ada/codex-report-147.md`.

- Codex Task 148: **B cutover blocked**. The cancellation fixture recorder still uses direct contract INSERT, and invite-persistence expects the pre-B policy error. Migration `5609c46` left as-is. Local SQL/catalog verification and the post-B E2E rehearsal remain pending. Report: `.ada/codex-report-148.md`.

- Codex Task 149: switched cancellation fixture creation to the Stage A RPC, split invite-persistence direct INSERT denials by migration stage, added anonymous RPC refusal coverage, and updated public create/recovery instructions. Row 2 started one working day early. E2E and Docker verification remain pending, including the fresh cancellation fixture's v14 artifact prerequisite. Report: `.ada/codex-report-149.md`.

- Codex Task 152: browser verification stopped before the E2E backend guard executed because Playwright's dev server failed with `listen EPERM` on `::1:5173`. No retry or subsequent suites. Owner form and true invitation expiry remain unverified. Report: `.ada/codex-report-152.md`.

- Codex Task 153: wrote `docs/production-apply-runbook.md` for separately approved row 1 → A → B → push, with exact pending-set gates, read-only verification and B-compatible frontend recovery. Production execution remains gated on T166 and Kenji's step-specific approvals. Report: `.ada/codex-report-153.md`.

- Codex Task 156: Row 3 design opener proposes the 13-key v5 preimage, top-level grant ID/issuer kind, strict presence/encoding, and delegated-only v5. Two independently computed vectors and a reader-first task split are in `docs/v5-preimage-review.md`. Kenji's representation and encoding confirmation and the reader rollout precede any v5 write. Report: `.ada/codex-report-156.md`.

- Claude Task 176 (2026-11-22, PRODUCTION read-only probes): `smoke:prod` gained two constraint-safe contract-create refusal probes (anonymous direct `POST /rest/v1/contracts` and anonymous `rpc/create_entry_contract`, both with `currency: 'XXX'`). Ran once: **18/18 ok**, both **refused HTTP 401 42501**, no writes. Runbook §4 now says `smoke:prod` covers the create refusal (closes the T174 contradiction). Report: `.ada/claude-report-176.md`.

- Codex Task 157: reviewed `d747cff`, must-fix before reusing the production probes. T176's recorded refusals stand. The script must stop immediately on 2xx, distinguish generic 400 from CHECK evidence, and document and verify its no-write assumptions. Report: `.ada/codex-report-157.md`.

- Claude Task 177 (2026-11-22, no production run): fixed Codex T157's three must-fix items in the `smoke:prod` refusal probes. A 2xx now exits 2 before any further request. Only a real 23514 counts as "CHECK reached"; any other 400 is inconclusive. 42501 (database refusal) is reported apart from a gateway-only 401/403. The probes run only on the pinned production host with `--backstops-verified`; otherwise none is sent. Runbook §4 scopes the no-write claim accordingly. New offline test `tests/unit/smokeRefusalClassifier.test.js` passes 8/8. The production re-run and the catalog readback of the backstops wait for Kenji. Report: `.ada/claude-report-177.md`.

- Claude Task 178 (2026-11-22, local only, row 3 step 1): froze the v5 canonical (Codex T156 `d53fc5e`, confirmed by Kenji) in a new pure module, `supabase/functions/_shared/eventCanonicalV5.ts`. It provides a strict validator, a UTC millisecond timestamp normaliser, a 13-key canonical builder, and a `match`/`mismatch`/`invalid_input` verifier. `eventCanonical.ts` is unchanged (v1–v4 only), so nothing reads or writes v5 yet. Both reference vectors reproduce byte for byte. `tests/unit/eventCanonicalV5.test.js` passes **24/24**: known answers plus tamper cases (key order, layout, missing/undefined/inherited, null vs empty/zero, GENESIS substitution, domain, hash_version, UUID/hex/type/issuer formats, timestamps, verdicts). Not pushed. Report: `.ada/claude-report-178.md`.

- Codex Task 158: reviewed `d9723c9`. V5 reference bytes match the design, but the freeze must settle the dotted type grammar: the builder and test currently accept an undotted name. Report: `.ada/codex-report-158.md`.

- Claude Task 179 (2026-11-22, PRODUCTION read-only, **blocked**): one SELECT-only catalog readback before the refusal probes. 8/9 items matched: currency CHECK, the INSERT trigger set, the `fill_amount_minor_from_legacy` body, the RPC privileges, ACL and body. **The `validate_contract_creation_only` body md5 on production (`c90bd8fd…`) does not match the migration file (`81b40cf0…`).** That function was applied via the management API in October (see the reconcile migration), so this is probably whitespace or formatting, but that's unproven. `smoke:prod -- --backstops-verified` was **not** run. A follow-up whitespace-normalised SELECT is proposed for Kenji. Report: `.ada/claude-report-179.md`. Not committed.

- Claude Task 180 (2026-11-22, PRODUCTION read-only plus one gated probe run): the whitespace-stripped md5 of `validate_contract_creation_only` on production equals the migration's (`f4c785b4…`). The T179 raw mismatch was formatting from the October management-API apply; tokens are identical and it never touches `currency`. Then ran `npm run smoke:prod -- --backstops-verified` once: **18/18**, both create probes `db_refused` (HTTP 401, 42501), no writes. Report: `.ada/claude-report-180.md`.

- Claude Task 181 (2026-11-22, local only): fixed Codex T158 on the v5 canonical. The event type now requires at least one dot (`a` is rejected). `V5_ISSUER_KINDS` is frozen and validation uses a private set. The builder snapshots each input once through its property descriptor and refuses accessors without calling them. `tests/unit/eventCanonicalV5.test.js` passes **27/27**; both known-answer vectors are byte-identical. Writer/reader gates (T158 finding 3, `prev_hash` mapping, renaming the old "v5" receipt comment) are follow-ups for the reader and writer slices. Not pushed. Report: `.ada/claude-report-181.md`.

- Codex Task 159: OK on `5c2fc1e`. Dotted types, frozen issuer kinds and the read-once snapshot close T158. Both known answers are unchanged and the focused suite passed 27/27 independently. Reader and writer integration gates remain. Report: `.ada/codex-report-159.md`.

- Claude Task 182 (2026-11-22, local, row 3 step 2): built strict v5 read support in new pure `supabase/functions/_shared/eventVerifyV5.ts`. It provides `classifyStoredEvent` (no legacy fallback for v5 or authority-bearing rows), `fromV5Transport` (explicit `prev_hash` mapping), and separate hash, link and agreement verdicts, plus `tests/unit/eventVerifyV5.test.js`. The two v5 test files pass **45/45**; legacy files have zero diff. The first commit attempt was blocked by the hook's full suite: a one-off timeout in the untouched `verifyReceipt.test.js` ("two acts are reordered", 5357 ms against 5000 ms). It was committed on the single approved retry (T183). Storage design is in the report. Report: `.ada/claude-report-182.md`.

- Codex Task 160: v5 storage design conditionally sound. Must have null-safe authority and predecessor CHECKs, unchanged legacy ACL/retention, and an atomic writer gate for old schema and cross-grant replay. Reader must preserve absence and avoid inferring pre-acceptance from null alone. Report: `.ada/codex-report-160.md`.

- Claude Task 184 (2026-11-22, test only): de-flaked `tests/unit/verifyReceipt.test.js`. All 22 tests spawn `verify-receipt.mjs` (about 0.2 s alone), and under the hook's parallel suite one went past vitest's 5 s default (T158, T182). Changes: a 15 s `timeout` on every `execFileSync` (a hung verifier is killed instead of blocking the worker) and a 20 s timeout on this file's four describes only; the global timeout is unchanged and no assertion changed. Three solo runs: 22/22 each. Report: `.ada/claude-report-184.md`.

- Codex Task 161: mapped Row 3 step 3 into shared verification, guest API/UI/export, and owner/export/CLI slices. Synthetic reader work can start now. Explicit authority-column reads wait for verified additive storage, and all readers precede v5 writers. Report: `.ada/codex-report-161.md`.

- Claude Task 185 (2026-11-22, local + disposable Docker, **blocked**, not committed): built `supabase/migrations/20261122130000_events_v5_authority_columns.sql`. It adds two nullable columns, a named FK to `entry_agent_credentials` with ON DELETE RESTRICT, the issuer, authority-pair and v5-predecessor CHECKs (null-safe, validated), and a proposed `events_v5_writes_disabled` gate, plus the evidence harness `tests/sql/events_v5_authority.sh`. The migration applies and its self-test passes. **But the existing `tests/sql/entry_agent_credentials.sql:144–147` now fails:** the new FK makes PostgreSQL refuse `truncate entry_agent_credentials` with 0A000 before the TF008 trigger fires. Grants are still not truncated, but the assertion's errcode changed. A test-change decision is needed (recommended: accept TF008 or 0A000, and add a CASCADE → TF008 case). Report: `.ada/claude-report-185.md`.

- Codex Task 162: recommend keeping T185's restrictive FK and v5 write gate. Split truncate expectations by schema and require CASCADE to fail with TF008. Fix the harness's gate and null-verdict assertions before rerun. Report: `.ada/codex-report-162.md`.

- Claude Task 185/186 (2026-11-22, local + disposable Docker): row 3 additive v5 authority storage. The migration `20261122130000_events_v5_authority_columns.sql` adds:
  - two nullable columns
  - `events_credential_id_fkey` ON DELETE RESTRICT
  - the null-safe issuer, authority-pair and v5-predecessor CHECKs
  - the `events_v5_writes_disabled` gate (kept per Codex T162)

  Following T162: `entry_agent_credentials.sql` truncate expectations are now stage-specific (TF008 before the FK; 0A000 plain and TF008 CASCADE after). The `tests/sql/events_v5_authority.sh` harness now uses a real-grant legacy-RPC gate test, null verdicts fail, and migrations apply in a single transaction. One run: **132 passed, 0 failed**. Not applied to any hosted DB; not pushed. Report: `.ada/claude-report-186.md`.

- Codex Task 163: hold push and E2E apply of `5d2869a` pending a transactional harness fix, `psql -1 -f -`, and rollback evidence. Migration SQL and other T162 evidence checked out. Report: `.ada/codex-report-163.md`.

- Claude Task 187 (2026-11-22, local only): row 3 step 3A per Codex T161, in `supabase/functions/_shared/eventVerifyV5.ts`:
  - a projection contract and a version-indicator consistency check in `classifyStoredEvent`
  - an allowlisted, prototype-free `fromV5Transport`
  - link expectations (`chain_start` / `after` / `unknown_boundary` → indeterminate)
  - a position-aware agreement check (an isolated null is `no_cited_digest`; null at or after acceptance is invalid)
  - new `verifyEvidenceSlice`: separate hash/link/payload/agreement per row, per-dimension results, and an overall `verified` only on a complete slice

  Legacy constants and modules are unchanged. `eventVerifyV5` + `eventCanonicalV5`: **66/66**. Not pushed. Report: `.ada/claude-report-187.md`.

- Codex Task 164: hold `b566c54` before 3B/push. Strict projection is sound, but slice aggregation can report verified with missing legacy checks or unknown v5 acceptance position. T188 storage evidence remains a separate gate. Report: `.ada/codex-report-164.md`.

- Claude Task 188 (2026-11-22, local + disposable Docker): closed Codex T163 item 1. `tests/sql/events_v5_authority.sh` now applies every migration with `psql -1 -f -` (true single transaction; plain `-1 < file` did not use it). New `TF_V5_ROLLBACK_PROOF=1` mode: the migration plus a forced late error rolls back fully through `-1 -f -` (residue 0 columns / 0 constraints), while the old bare-stdin form leaves 2/5 as the control. One clean run: **132/132**. Migration SQL unchanged. Not pushed. Report: `.ada/claude-report-188.md`.

- Codex Task 165: T188 `85b8db1` closes the local storage transaction/rollback evidence hold. Current push must still wait for the held 3A ancestor and its T189 review. Hosted E2E apply needs separate approval and the target checklist. Report: `.ada/codex-report-165.md`.

- Claude Task 189 (2026-11-22, local only): closed Codex T164 items 1–2 on `verifyEvidenceSlice`.
  - Legacy missing hash/link/payload digest is now `pre_chain` / `missing` / `not_recorded`: indeterminate, never a pass, and it blocks `verified`. A v1 link is `not_in_format`.
  - A v5 digest equal at an unknown position is `match_position_unknown`.
  - Acceptance is derived from the ordered rows (`dod.consent_recorded`). Inconsistent or out-of-range markers are rejected.
  - Regression tests added. `eventVerifyV5` + `eventCanonicalV5`: **70/70**. Not pushed. Report: `.ada/claude-report-189.md`.

- Codex Task 166: `3b22f2c` closes missing legacy proof, but 3A/push remain held. Reject `before_slice` on a known-start slice and make any rejected acceptance marker block overall verified, including legacy-only slices. Report: `.ada/codex-report-166.md`.

- Claude Task 190 (2026-11-22, local only): row 3 step 3B-core in `supabase/functions/_shared/guestEventView.ts`, additive (the legacy wire is unchanged):
  - `CANONICAL_INPUTS_V5`
  - `guestCanonicalBlock`, which classifies the raw row first; legacy rows get the existing block, and v5, invalid or unsupported rows get an exact projection with no null synthesis
  - `acceptedAgreementHashOf`, taken only from a self-consistent acceptance snapshot
  - `guestTrailVerdicts`, with separate `server` (full payloads) and `local` (no payload, so never verified) verdicts

  Wiring into the endpoint, UI and export (3B-wire) waits for storage on E2E and the response-version decision. Tests: guestEventView + eventVerifyV5 + eventCanonicalV5 + eventRecord, **158/158**. Not pushed. Report: `.ada/claude-report-190.md`.

- Codex Task 167: 3B-core split is sound, but hold `05900e3` pending preservation of raw invalid verdicts through projection, snapshot/start checks, and a legacy-only no-payload local-verdict regression. Report: `.ada/codex-report-167.md`.

- Claude Task 191 (2026-11-22, local only): closed Codex T166 item 2 on 3A. `before_slice` is rejected on a known-start slice (still valid for a suffix). A rejected acceptance marker now gates the aggregate (agreement can't pass, overall can't be verified; real mismatches still `failed`). Regressions added in `eventVerifyV5.test.js` and, through `guestTrailVerdicts`, in `guestEventView.test.js` (including old envelopes without v5 fields). Three files **115/115**. Not pushed. Report: `.ada/claude-report-191.md`.

- Codex Task 168: `2ae3248` closes the two T166 3A blockers. Storage and 3A pass review, but the current normal push still includes T167-held `05900e3` and waits for T192 review. Report: `.ada/codex-report-168.md`.

- Claude Task 192 (2026-11-22, local only): closed Codex T167 on 3B-core.
  - A raw row's invalidity (classification, projection, transport) is carried into both the server and local verdicts through a new `knownInvalid` option of `verifyEvidenceSlice`. There is no reclassification after shaping and no unchecked fallback, an absent `event_hash` stays absent, and raw rows are never spread.
  - `acceptedAgreementOf` accepts only a well-formed snapshot of a supported version, with explicit statuses. The local digest comes only from the snapshot sent to the guest. `start` is now explicit.
  - The local whole-trail claim is capped at `incomplete` (`no_full_payload`).
  - Three files **123/123**. Not pushed. Report: `.ada/claude-report-192.md`.

- Codex Task 169: `b3f4e22` closes projection invalidity, explicit start and the guest-local cap, but the stack remains held. Snapshot validation checks keys and digest without checking field values. Report: `.ada/codex-report-169.md`.

- Claude Task 193 (2026-11-22, local only): row 3 step 3C-core in `src/lib/auditExport.js`. Owner exports with v5 (or v5-shaped invalid) rows are verified strictly over the whole trail (`verifyEvidenceSlice` with full payloads, an accepted digest only from a well-formed supported snapshot, and completeness only from a new explicit `evidence` parameter). They report per-row `strict_v5`, a `v5_verification` section and instruction 10, and `integrity_status` adds `INVALID_EVIDENCE_DETECTED`, `AGREEMENT_MISMATCH_DETECTED` and `INDETERMINATE_INCOMPLETE_EVIDENCE` (mismatches first; VERIFIED only on a verified slice). Legacy-only exports are unchanged. The existing future-version fixture moved from 5 to 6 (no assertion changed); Codex to confirm. `auditExport.test.js` **30/30**. The CLIs and App wiring are split out. Not pushed. Report: `.ada/claude-report-193.md`.

- Codex Task 170: push held on `e527c9a` even if T194 closes T169. Owner export hashes invalid v4 through the legacy path, can report a broken link at an unknown boundary, and labels an unusable v5 payload digest a mismatch. Fixture change and 3C split accepted. Report: `.ada/codex-report-170.md`.

- Claude Task 194 (2026-11-22, local only): closed Codex T169 on 3B-core. Acceptance snapshots get version-specific value validation before their digest is accepted (v1: string-or-null text fields, string-array `dod`, safe-integer-or-null `amount`, `YYYY-MM-DD`-or-null `deadline`, `creator`/`counterparty`; no normalisation) → new status `invalid_snapshot_values`. Full-trail self-consistently hashed regressions added (guest and owner export), the snapshot result is kept separate from the acceptance row hash, and the unreachable "transport" test is redescribed as a raw-accessor test. guestEventView + auditExport **83/83**. Not pushed. Report: `.ada/claude-report-194.md`.

- Codex Task 171: T169 closed for 3B-core in `6ae064f`. Snapshot value validation and regressions pass static review. Normal push remains held because `6ae064f` includes T170-held ancestor `e527c9a`. Report: `.ada/codex-report-171.md`.

- Claude Task 195 (2026-11-22, local only): closed Codex T170 on the 3C-core owner export. Rows are classified before dispatch, and strict rows skip the legacy canonical and payload checks (proven on the execution path with a pass-through mock). On strict trails every row takes its link from the slice, so an unknown boundary is indeterminate and not `CHAIN_LINK_BROKEN`. An unusable v5 `payload_hash` is `invalid_input`, not a mismatch (`eventVerifyV5.ts`). `integrity_status` comes from proven findings, with all of them listed in `v5_verification.findings`. auditExport + eventVerifyV5 **84/84**. Not pushed. Report: `.ada/claude-report-195.md`.

- Claude Task 196 (2026-11-22, check only): `tests/unit/guestEventView.test.js` **52/52** after the T195 v5 `payloadCheck` change. The server verdict now reports an unusable v5 payload digest as `invalid_input` (still failing); the local verdict is unaffected. No code changed. Proposed next step without E2E storage: the public v5 protocol text plus vectors, held locally for the reader release (about half a day). Report: `.ada/claude-report-196.md`. (Uncommitted.)

- Codex Task 172: T170 closed in `050e45b`. Push review YES for all ten commits `origin/main..050e45b`; no push or hosted apply performed. Report: `.ada/codex-report-172.md`.

- Claude Task 197 (2026-11-22, local commit `aaafd91`): a guest test for an unusable v5 `payload_hash` (server `invalid_input`/`failed`, local `unavailable`; guestEventView **53/53**); the `make-receipt.mjs` comment no longer calls salted commitments "v5"; new `docs/v5-receipt-format.md` (receipt v2 design shared by make-receipt and verify-receipt; not implemented). Not pushed. Report: `.ada/claude-report-197.md`. (Uncommitted.)

- Claude Task 198 (2026-11-22, Kenji OK 15:00 ET): one normal push of `origin/main..aaafd91` (row 3: storage migration file, unapplied; 3A shared v5 rules; 3B-core guest reader; 3C-core owner export; T197 test/comment/docs). Codex T172 reviewed through `050e45b`; `aaafd91` (test/comment/docs) was unreviewed. The only frontend change is `src/lib/auditExport.js` (strict v5 path; legacy-only exports unchanged). No DB, no migration applied, no edge function deployed. Report: `.ada/claude-report-198.md`.

- Claude Task 199 (2026-11-22, Kenji OK 15:11 ET, E2E only): **`20261122130000_events_v5_authority_columns` applied to E2E** (`yqjtawffpesplqyurlpj`) with `supabase db push --db-url`, CLI 2.105.0, one `op read` into `PGPASSWORD` only. The dry run listed exactly that file. Read-only checks: **22/23 PASS**. The one FAIL was the check script's literal-text match: Postgres stores `IS NOT DISTINCT FROM 5` as `NOT (hash_version IS DISTINCT FROM 5)`. 棟梁 accepted the quoted stored definition in `.ada/claude-report-199.md`. Columns nullable, all five constraints validated, FK ON DELETE RESTRICT, write gate closed, no authority values or v5 rows, records/ACL/RLS unchanged (6012 events, 3782 contracts). Production untouched.

- Claude Task 200 (2026-11-22, local, Kenji OK 15:11 ET): 3C CLI.
  - **Shared libraries:** a paged ordered events read (`scripts/lib/pagedEvents.mjs`; a capped read is never complete) and receipt v2 (`scripts/lib/receiptV2.mjs`, per `docs/v5-receipt-format.md`).
  - **`make-receipt`:** selects `credential_id, issuer_kind` explicitly and emits v2.
  - **`verify-chain`:** the authority columns, a capped read fails, and strict trails use `verifyEvidenceSlice`.
  - **`verify-receipt`:** v1 is unchanged except that v5 acts fail; v2 classifies first, checks per-version inputs and that accepted follows from snapshot plus acceptance act, and uses the slice. VERIFIED needs every dimension but payload to pass; incomplete exits 3.
  - **Tests:** verifyReceipt + pagedEvents **37/37**.
  - **E2E round trip (read-only) on the harness deal `7773166e`:** receipt v2 → RECEIPT VERIFIED, and CHAIN VERIFIED. The authority-column SELECT works on E2E.
  - Not pushed. Report: `.ada/claude-report-200.md`.

- Claude Task 201 (2026-11-22, local only): row 3 step 3B-wire (guest), groundwork.
  - **Endpoint:** `guest-contract-events` now SELECTs `credential_id, issuer_kind` and runs the strict reader server-side (`guestStrictVerdicts`: projected, from the first event, the cap as truncation, the sent snapshot). The result is **not** in the response; it is logged only on v5-shaped rows or a disagreement with v1's headline.
  - **v1 body:** unchanged. The shaping loop and `describeActor` moved verbatim into `guestEventView.ts` (`shapeGuestEventsV1`) and are now under test. guestEventView **59/59**.
  - **Not done:** not deployed; `deno check` hasn't been run (no deno locally).
  - **Deploy-order hazard:** do NOT deploy this function to production before production storage `20261122130000`; every guest read would fail.
  - **Response-version options** are in the report; option 1 (v2 behind `?response_version=2`) is recommended.
  - Report: `.ada/claude-report-201.md`.

- Codex Task 174: push NO through `3260609` pending receipt v2 agreement/deal binding and completeness fixes. Edge deploy is separate and production storage must precede it. Pick opt-in response v2. Report: `.ada/codex-report-174.md`.
- Claude Tasks 202-204 (Kenji: option 1 then option D, 2026-11-22): guest response v2 behind `?response_version=2`, **local commit only; not pushed, not deployed**.
  - v1 is byte-identical: the literal moved verbatim into `_shared/guestResponse.ts` and never runs the strict reader. v2 adds the exact 12-input v5 canonical, `integrity.strict` and `strict_verification`; `chain.verified` is true only when the strict check passes over an established read (exact count = rows; a short page is not the end). The shadow strict log never throws (Codex T174).
  - The frontend parser requires the strict fields on v2 and refuses them on v1; the export carries the verdict basis, the three-way strict result and invalid rows' authority fields. Public doc: v2 still "planned, not deployed".
  - Unit tests: six files, 172/172. `deno check` not run (no deno locally). E2E stub edited, not run.
  - **Deploy gates:** `deno check`; an E2E-only deploy and guest specs, each under its own OK; production storage `20261122130000` before any production function deploy. Reports: `.ada/claude-report-202.md`/`203.md`/`204.md`.

- Codex Task 176: option D and scoped count OK in `0dc28ce`; Deno check may proceed, E2E deploy held for v2 guest presentation and parser consistency. Report: `.ada/codex-report-176.md`.
- Claude Task 205 (Codex T174 must-fix on `c51de66`; local commit only, **not pushed**):
  - The receipt v2, issuer and strict verify-chain agreement checks now use the validated accepted digest; current terms are only a drift report. An acceptance act without a proven accepted block fails.
  - Receipt v2 is bound to its deal: the envelope `contract_id` must match every act, and `snapshot_version` must match the snapshot. Compare runs only on verified, same-deal receipts.
  - Paging ends only on an empty page. Offline success states the issuer's asserted read boundary; a draft says "pre-acceptance chain only".
  - verifyReceipt and pagedEvents tests: 49/49. make-receipt and verify-chain are untested here (network). Report: `.ada/claude-report-205.md`.
- Claude Task 206 (Codex T176 item 4 on `0dc28ce`; local commit only, **not pushed**):
  - The v2 screen and export prose come from the strict verdict: a failed strict check (for example agreement) is never "No check that ran found a mismatch", and incomplete says it is not verified. The truncation notice states the v2 read boundary, and a missing count never claims the cap was reached. v1 text is unchanged.
  - The v2 parser checks the body against itself: overall vs dimensions, tail vs count vs the events returned, completeness vs tail, `chain.truncated` and `event_count`.
  - The E2E stub `toV2` derives a consistent trail. That file was edited but not run: `agreement-record-ui.spec.js:276` (verified + truncated) now shows not verified under v2 and needs a stubbed run before the E2E deploy.
  - Unit tests: four files, 134/134. T205 committed separately as `6d957ba`. Report: `.ada/claude-report-206.md`.

- Codex Task 177: E2E deploy NO pending v2 row/aggregate consistency and faithful stub coverage. T174 core receipt fixes pass; incomplete receipt comparison still needs a separate fix. Report: `.ada/codex-report-177.md`.
- Claude Task 207 (checks only; no edits, not committed): `deno check` was not run (deno isn't installed; install needs a decision). The stubbed E2E run of 4 specs gave 26 passed, 14 failed, none a product bug: 2 are the expected v2-prose change under D (test expectation), 4 are a stale `/CANNOT be reproduced/` assertion from `b5eebd3`, and 8 are first-wave timeouts (re-run with `--workers=1`). Report: `.ada/claude-report-207.md`.

- Codex Task 178: receipt compare now requires two individually verified receipts. Incomplete pairs skip comparison and retain exit 3. Receipt and pager unit suites 50/50. Report: `.ada/codex-report-178.md`.
- Claude Tasks 210–211: guest function `deno check` passes (contracts select as one literal; `shapeGuestEventsV1` return type, type-only). Codex T179: v2 parser refuses an unsupported row with non-slice labels and any agreement pass under a rejected acceptance marker; acceptance status required; E2E stub emits the slice's unsupported labels. Unit 150/150, stub E2E `--workers=1` 42/42. Not pushed, not deployed. Report: `.ada/claude-report-210.md`.
- Claude Tasks 212–213 (Codex T180): v2 parser binds each row's strict kind to its reported format (legacy = supported 1–4, v5 = supported 5, unsupported = unsupported and not 1–5, invalid = unsupported with its recorded version) and allows `not_in_format`/`not_bound` only on legacy formats that lack the field. Unit 150→158/158. Not pushed, not deployed. Report: `.ada/claude-report-212.md`.
- Claude Tasks 214–215 (2026-11-23, Kenji pre-OK 11-22 19:10 ET, Codex T181 YES): **hosted E2E (`yqjtawffpesplqyurlpj`) now runs `guest-contract-events` v13 from `1011b99`** (was v12, 2026-11-10; `supabase functions deploy guest-contract-events --project-ref yqjtawffpesplqyurlpj`, Docker local bundling). Response v2 (option D strict verdicts) is served behind `?response_version=2`, which the app already requests (`src/lib/contracts.js:243`); v1 unchanged. Verification: backend guard + `guest-evidence.spec.js` 13/14, the one failure the spec's stale v1 sentence; assertion updated to `/strict check passed every dimension/` (T215), re-run 13/13. **Production function NOT deployed** (still needs its own OK, and production storage `20261122130000` first). Report: `.ada/claude-report-214.md`.
- Claude Task 216 (2026-11-23, Kenji OK 12:51 ET): **pushed `main` `fe32fc9..5f433fe`** (11 commits: T202–T215 guest response v2 / parser / receipt work, Codex T178). **Vercel production `dpl_HbLMNuXacTqPpB8PQhUoxEh9vytg` (SHA `5f433fe`) READY** in ~8 s, aliased to `project-trustflow.vercel.app`, `aliasError: null`. Served change: `src/lib/eventFormat.js` + `src/lib/guestRecordExport.js` (v2 parser/prose/export); the app already requested `?response_version=2` before this push (`b4cbd52`), and the production function still answers v1, which the page parses unchanged. **No production DB or function change**: production `guest-contract-events` not deployed, storage `20261122130000` not applied there. Report: `.ada/claude-report-216.md`.
- Claude Tasks 217–224 (2026-11-23, Kenji OK 15:47 ET, Codex T186 YES): **production storage `20261122130000_events_v5_authority_columns` APPLIED and verified** (`fqgpzhwvvfsxswlnbbgg`, 21:02–21:03 UTC, one run, CLI 2.105.0 from worktree `67b4cdd`, TLS `verify-full` against the pinned Supabase Root 2021 CA `700723…f3b7`). E2E read-only validation passed first (TLS negative/positive probes, exact contract). Prod gates: baseline tip `20261120180000`/52 → dry run exactly that file → applied by this run → history 53, security metadata unchanged, constraints validated and byte-identical to E2E, 0 authority values, 0 v5 rows (write gate closed), no row drift (2397 events / 1322 contracts). T217/T218 had stopped at gate 1 on my own check-SQL bugs (nothing applied). Production `guest-contract-events` still NOT deployed (needs its own OK). Check set and outputs: scratchpad `t217/`. Report: `.ada/claude-report-224.md`.
- Claude Task 225 (2026-11-23, Kenji OK 16:05 ET): **production `guest-contract-events` deployed: v13 → v14** (`fqgpzhwvvfsxswlnbbgg`, 21:05:54 UTC) from `67b4cdd`, whose `supabase/functions` is identical to `1011b99` (Codex T181 YES; same source as E2E v13), script 121.5 kB, Docker local bundling. `deno check --no-lock` 0 errors before. Read-only after: ACTIVE v14; OPTIONS preflight 200 with the site origin. Response v2 (option D) now served behind `?response_version=2`, which the live app requests; v1 unchanged. No other function, push or SQL. Report: `.ada/claude-report-225.md`.
- Claude Task 226 (2026-11-23, Kenji OK 16:08 ET): committed HANDOFF (T224–T226), `docs/schedule.md` row 3 Actual and 棟梁's `Roadmap.md` row 3 completion; one normal `git push origin main` (incl. `67b4cdd`); Vercel production checked read-only. Docs only, no served-code change. Root `deno.lock` deliberately left untracked (Codex T180). Report: `.ada/claude-report-226.md`.
- Claude Task 227 (2026-11-23, Kenji OK 16:14 ET, planning only): row 4 plan written at `docs/plans/row4-owner-append.md` — 4a resolver (locked SQL check, contract→grant lock order, uniform 403), 4b delegated v5 append in `log-event` behind `ENTRY_DELEGATED_APPEND` with grant-keyed replay, 4c open the v5 write gate on E2E only (two locks: DB constraint + flag; production waits for row 9). Estimate 2.5–3d vs 2d scheduled; start 11-24 keeps 11-27. Six decisions for Kenji (Q1–Q6) in `.ada/claude-report-227.md`. Uncommitted.
- Claude Task 228 (2026-11-23, planning only): row 4 plan revised after Codex T187 (NO, 4 must-fixes) — anon-key transport vs `x-trustflow-grant` admission before the contract lookup, resolver in unexposed `private` schema; delegated replay keyed to the grant plus a `credentialId` guard at all three owner `ownerKeyedOutcome` sites; full v5 binding table with SQL outer-hash re-derivation and `RETURNING` comparison; DB enforcement via one-use v5 write tickets + gate row + trigger before the CHECK drop. Pushback: inner digests not re-implemented in SQL; Q5 now (c) shared migrations + gate row opened as data. Estimate 3–4d. Report: `.ada/claude-report-228.md`. Uncommitted.
- Claude Task 229 (2026-11-23, planning only): row 4 plan revised after Codex T188 (items 1–3 closed, gate race open) — writer locks contract→grant→gate FOR SHARE through commit, operator close locks only the gate row, missing gate fails closed; BEFORE+AFTER ticket triggers cover the stored row; one clock sample after all locks with a pure 60 s window function; trusted-caller inner digests on the normalized parsed payload tree with parity/round-trip tests; isolated pre-CHECK-drop proofs; canary-first header-log check; replay skips the gate. Estimate 3.5–4d. Report: `.ada/claude-report-229.md`. Uncommitted.
- Claude Task 230 (2026-11-24, planning only): row 4 plan revised after Codex T189 (gate race closed, 1 must-fix + 2 should-fixes) — one final recorded payload tree (parse once, strip caller `_` fields, add server assurance, hash/send/store the same tree; SQL checks the reserved set) with an extended duplicate/reserved-field fixture; late-rewrite trigger proof disposable-only with the CHECK absent, a constraint-valid candidate, and the AFTER SQLSTATE plus row absence asserted; both trigger functions `security definer` with empty search_path and EXECUTE revoked. Estimate unchanged 3.5–4d. Report: `.ada/claude-report-230.md`. Uncommitted.
- Claude Task 231 (2026-11-24, planning only): row 4 plan revised after Codex T190 (1 must-fix: Edge cannot see the private resolver result) — single append call kept; Edge builds the expected reserved fields from route rules plus a pre-read `performed_by`; the RPC, after the resolver and under lock, checks the exact `_` key set and values (`_actor_role`, `_role_in_agreement` both directions, `_auth_method`, `_authentication`), stale role gives `context_changed`, other mismatch a non-retryable refusal, both before ticket and insert; fixture extended. Estimate unchanged 3.5–4d. Report: `.ada/claude-report-231.md`. Uncommitted.
- Claude Task 232 step 1 (2026-11-24): Kenji signed off the row 4 plan (Q1–Q6, agreed points, `entry_agent_grant`; owner now Claude builds / Codex reviews; `Decisions.md` 2026-11-24). Plan folds Codex T191 (YES) should-fixes: typed `p_performed_by` proposal with ordered `reserved_fields_mismatch` → `context_changed` → locked-role authorization, isolated classification fixtures, `clock_window` kept apart from exhausted `context_changed`; receipt and guest-view `recorded_credential` label assertions. Gate row moved to migration A. Plan, Decisions, schedule row 4 Owner cell and HANDOFF committed locally; not pushed.
- Claude Task 232 step 2 (2026-11-24): row 4a database half built locally — migration `20261124120000_entry_agent_resolver.sql` (unexposed `private` schema, closed singleton `private.v5_write_gate` with TF009 delete/truncate guard, `private.resolve_entry_agent_grant(p_contract_id, …)` SECURITY DEFINER, contract→grant→gate locks then one clock sample, owner/service_role EXECUTE revoked, self-test TF921–TF923). `tests/sql/entry_agent_resolver.sh` ALL PASS on local Docker; inventory allowlist gains the resolver. Not applied to E2E or production; gate closed; not pushed. Left in 4a: `log-event` admission/header parser/CORS (lands with the 4b RPC), hosted E2E admission/CORS/redaction-canary checks.
- Claude Task 233 (2026-11-24, Kenji pre-approved 11:11 ET): (1) Codex T192 4a should-fixes `7ac4217` (null-safe TF922, deal-matched grant lock, condition-based lock proofs; migration 20261124120000 final). (2) **20261124120000 applied to hosted E2E once** (`supabase db push --db-url`, CLI 2.105.0, one `op read`; dry run listed exactly that file); read-only verify via Supabase connector (local psql had no IPv6 route): resolver definer + empty path, no client/service_role access to `private`, gate 1 row closed, v5 CHECK present, 0 v5 rows, inventory clean. Production untouched. (3) Row 4b built locally: migration `20261124130000_delegated_owner_append.sql` (`3026cc1`: append/replay RPCs, write tickets, BEFORE/AFTER ticket triggers; v5 still closed) + log-event delegated dispatch behind `ENTRY_DELEGATED_APPEND` (off), `delegatedAuth.ts`, `delegatedEvent.ts`, `grantAssurance`/`entry_agent_grant`, `credentialId` replay guard, CORS header. Tests: `delegated_append.sh` ALL PASS, vitest 6 files 153/153, deno check no new errors (5 pre-existing). Not applied to E2E, not deployed, not pushed. Report `.ada/claude-report-233.md`.
- Claude Task 234 (2026-11-24, Kenji OK 12:14 ET, local only): remaining row 4b tests, no reviewed code changed. `tests/sql/delegated_append.sh` extended (real TS `buildDelegatedEventV5` via `tests/sql/delegated_proposal.ts` on an accepted deal with non-ASCII/escaped DoD, date and minor amount: SQL accepts it, stored row verifies `match`, receipt v2 shows `entry_agent_grant` + null age; unsupported accepted version → `agreement_unavailable`; snapshot drift → `context_changed`; all three legacy writers with v5 JSON → exactly TF011 with or without the CHECK; migration B without A fails and leaves nothing) ALL PASS; new `tests/sql/delegated_append_races.sh` (revoke↔append both orders, expiry during the writer wait, owner and guest writers vs delegated, same-key twins) ALL PASS; `logEventDelegated.test.js` +PGRST202 → 503, 15/15. Note: once B is applied, legacy v5 attempts answer TF011 instead of row 3's 23514. Guest-view `recorded_credential` deferred (published v2 response change). Report `.ada/claude-report-234.md`.
- Claude Task 235 (2026-11-24, Kenji OK 13:07 ET, local only): Antigravity review 1 must-fixes M1–M4 fixed in place in the unapplied migration 20261124130000 and log-event (authorize via replay_delegated_event before any deal read; array payload and empty key 400 before admission; replay gains the locked-role check; twin before window; replay predicates add issuer_kind + hash_version 5; snapshot_version compared as jsonb; hashed-input shape/consistency → binding_mismatch, only freshness → context_changed, exhaustion logged; v5_gate_missing log; TF011/TF014/TF010 loud 500; window uses max(created_at), TF003 retried). Guest v2 response gains additive `recorded_credential` (v5 rows only, else null); v1 unchanged. Tests: delegated_append.sh + races ALL PASS, vitest 4 files 132/132, deno check unchanged 5 pre-existing. Not applied, not deployed, not pushed. Report `.ada/claude-report-235.md`.
- Claude Task 236 (2026-11-24, Kenji OK 13:35 ET, local only): Codex T193 must-fixes — (1) lock-free `private.v5_grant_precheck` (grant exists, belongs to the deal, secret matches) runs before the contract lock in both delegated RPCs, in the unapplied 20261124130000 (20261124120000 on E2E untouched); resolver lock order unchanged; races suite proves invalid credentials are refused under a held contract lock with lock_timeout 500ms through both RPCs while a valid grant still waits; (2) log-event delegated logs carry only a validated UUID contract id (`loggedContractId`, else null), canary redaction test. Nits: ordered non-object guards + collate "C" key sets, gate_missing mock on append, delegated catch-all 500 without detail. Tests: delegated_append.sh, races, entry_agent_resolver.sh ALL PASS; logEventDelegated 26/26; deno check unchanged. Not applied/deployed/pushed. Report `.ada/claude-report-236.md`.
- Claude Task 237 (2026-11-24, Kenji OK 14:28 ET, push only): row 4 (4a + 4b, Codex T194 YES) pushed to origin/main with a plain `git push`: 18ce3d2..HEAD (plan, both migrations as files only, log-event/_shared, tests, docs). Served frontend unchanged: `vite build` at 0ce3b64 and at 63b00ca in clean worktrees gave byte-identical dist (6 files). No migration applied, no Edge Function deployed, gate closed, no DB access, no tests run. `deno.lock` still untracked and untouched. Vercel result in `.ada/claude-report-237.md`.
- Claude Task 238 (2026-11-24, Kenji OK 14:32 ET, E2E only): **`20261124130000_delegated_owner_append` applied to hosted E2E once** (`yqjtawffpesplqyurlpj`, `supabase db push --db-url`, CLI 2.105.0, one `op read`; dry run listed exactly that file; self-test TF931–TF934 passed). No hosted check expected 23514 (only local `events_v5_authority.sh`, whose fixture never applies B, so unchanged). Read-only after (Supabase connector): history 55, latest 20261124130000; both RPCs definer/empty path/service_role only; private helpers + trigger functions + tickets no client/service_role access; both ticket triggers enabled, zz_ last BEFORE INSERT; gate 1 row closed; v5 CHECK present; 0 v5 rows, 0 tickets; events 6060 / contracts 3808 with md5 fingerprints identical to baseline; inventory clean. TF011 on E2E not probed (needs a write attempt; offered). Gate closed, no Edge deploy, production untouched. Report `.ada/claude-report-238.md`.
- Claude Task 239 (2026-11-24, Kenji OK 14:50 ET, E2E only): **hosted E2E now runs `log-event` v16 (ezbr `b65914a1…`) and `guest-contract-events` v14 (ezbr `c5ddf88a…`)** from `250fe98` (functions tree = Codex-reviewed `63b00ca`), `supabase functions deploy <name> --project-ref yqjtawffpesplqyurlpj`, Docker local bundling (entrypoint file:///Users/…). `ENTRY_DELEGATED_APPEND` absent (secret names only) → delegated route 503. After: live `event-ingestion.spec.js` + `guest-evidence.spec.js` 24/24; probe: OPTIONS 200 allowing x-trustflow-grant, fake-grant delegated POST 503 `delegated_append_unavailable`, v2 events carry `recorded_credential` (null, no v5 rows), v1 has none. validate-invite-token/reissue-guest-access unchanged. Gate closed, no migration, production untouched. Report `.ada/claude-report-239.md`.
- Antigravity Task 3 (2026-11-24, local commit only, **not pushed**): fixed Report 2 optional nit 1 in `recordedCredential` (`supabase/functions/_shared/guestEventView.ts:561` rejects empty/whitespace-only credential strings → `null`; `tests/unit/guestEventView.test.js` +2 assertions); nits 2 (`logEventDelegated.test.js` `gate_missing` mock) and 3 (`20261124130000` ordered non-object guards) were already closed in `63b00ca` (Codex T193) and applied to E2E (`250fe98`). Unit tests: `guestEventView.test.js` + `guestResponse.test.js` 94/94. Not deployed, not pushed. Report `.ada/antigravity-report-3.md`.
- Claude Tasks 208-209 (Codex T177 must-fix; local commit only, **not pushed**):
  - The v2 parser now requires the trail verdict to follow from its own rows: completeness passes only for a complete tail with at least one event, hash/link/payload/agreement match the rows' strict labels (allowing the server's agreement downgrade), and any invalid row means failed.
  - The E2E stub `toV2` builds conservative row labels and derives the trail from them. A v4 agreement is unproven unless the fixture states `agreementChecked`.
  - Stale expectations fixed: the v2 happy path expects the strict success prose, a new v2 truncated-record test was added, and the `b5eebd3` wording was updated.
  - Unit tests: 4 files, 141/141. Stub E2E: 4 specs with `--workers=1`, 42/42. Reports: `.ada/claude-report-208.md`, `.ada/claude-report-209.md`.
- 2026-11-24 T240 (Claude): rolled-back direct v5 INSERT probe on hosted E2E via Supabase connector returned TF011 (`v5_write_ticket_check`, no write ticket); after-check: events 6098 unchanged, 0 v5 rows, 0 tickets, gate closed, no open tx. Report `.ada/claude-report-240.md`.
- 2026-11-24 T241 (Claude): hosted E2E, flag off: real grant 592ba774… (owner, payment.acknowledged, fixture deal 0853c261…) passed gateway/CORS → log-event 503 delegated_append_unavailable; canary-first log search (function_edge_logs/function_logs/postgres) found no canary, grant id or secret prefix; grant revoked after. 648653c pushed after Codex T197 YES. Report `.ada/claude-report-241.md`.
- 2026-11-24 T242 (Claude): row 5 plan committed (3e20256); 5a built locally: `read_delegated_owner_deal` + `private.resolve_owner_read_grant` in 20261124231214 (local DB only) (4f63b0f), SQL suites delegated_owner_read (81) / _races (13) all pass, row 4 suites re-run green (749ea71). Not pushed. Codex review range 3e20256..749ea71. Redone: `supabase migration new` hung on stdin (file already created, used as-is); one fixture type swapped; denial checks pinned to SQLSTATE. Report `.ada/claude-report-242.md`.
- 2026-11-24 T243 (Claude): Codex T198 NO fixed locally in 20261124231214 (edited in place; only ever on disposable DBs) (5135105): acceptance anchor/_agreement on dod.consent_recorded + acceptance_count; guest:<address> actor_id withheld with canonical_inputs_complete=false; _agreement/_authentication/meta pass verbatim only in-schema else withheld (never rewritten); only first 500 rows projected, 1 MiB = exact jsonb array text (returned_bytes); statement keys in private.owner_read_statement_keys() with TS parity test. Tests (938edc2): delegated_owner_read 106, _races 13 PASS (genuine invite acceptance via real buildEventRecord, UTF-8 1 MiB edge, append refusal). Not pushed. Codex re-check range 4b412fc..938edc2. Redone: self-test variable clash; two assertion-format fixes. Offline verifier round trip stays 5b. Report `.ada/claude-report-243.md`.
- 2026-11-24 T244 (Claude): Codex T199 NO fixed locally in 20261124231214 (in place; disposable DBs only) (90c12b7): every value crossing the owner projection has a key-specific domain (text strings, safe integers for step/rating, digits for budgetPoints, string arrays for dod_items; recorded enums for _actor_role/_role_in_agreement/_auth_method; per-key _authentication domains, else withheld whole); invalid values omitted as payload.<approved key>; canonical_inputs_complete documented as projection completeness only; unused window total dropped. Tests (556c155): delegated_owner_read 125, _races 13 PASS. Not pushed. Codex re-check range 52b39f1..556c155. Redone: races suite run twice (tail + count). Report `.ada/claude-report-244.md`.
- 2026-11-24 T245 (Claude): Codex T200 NO fixed locally in 20261124231214 (in place; disposable DBs only) (a017c80): count/value/authentication checks rewritten as ordered plpgsql IF chains (type test before any ::numeric cast or jsonb_array_elements); _authentication.method = null or the 12 Supabase-documented amr labels (incl. sso/saml, email/signup), else assurance withheld whole; aal = aal1/aal2 only; recorded null counterparty_name preserved. Tests (9741562): delegated_owner_read 136, _races 13 PASS. Not pushed. Codex re-check range 533c5dc..9741562. Nothing redone. Report `.ada/claude-report-245.md`.
- 2026-11-24 T246 (Claude): (1) committed 棟梁's Roadmap.md + docs/schedule.md (`584021a`), served frontend unchanged in range, normal push `2ed64cd..584021a` (row 5a + docs; migration as file only), Vercel production `dpl_Gs6ZXTUzfNS6tuuxGGFiYp215HtS` on `584021a` READY; no migration apply, fn deploy or gate change. deno.lock left untracked. (2) Row 5b started locally: `d83d55d` buildReceiptV2 moved to `_shared/receiptV2.ts` (CLI re-export; additive timestamp_token_present / canonical_withheld / accepted override), `51796a4` `delegated-owner-read` route (ENTRY_DELEGATED_READ default off, body-before-admission, one RPC with digest only, uniform 403, PGRST202→503, generic 500, private no-store) + `_shared/ownerReadResponse.ts` (stored_format per event; receipt null on empty; anchor outside prefix / multiple acceptances withhold accepted terms), `0d44196` tests: unit delegatedOwnerRead 25 + verifyReceipt 43 PASS; new SQL `delegated_owner_read_receipt.sh` 29 PASS (real RPC → real shaping → verify-receipt.mjs: v5-only draft VERIFIED, legacy draft incomplete with every hash/link passing, capped incomplete, created_at identical outcome under UTC and America/New_York). Decision open: guest-accepted deals' receipts FAIL (acceptance act's actor_id withheld → verifier reports hash mismatch); recommended verifier treats declared canonical_withheld as unavailable (exit 3). Envelope measured 1.18 MB for 500 small events (receipt ~1.2 KB/act over the 1 MiB event cap). Not pushed. Codex range `584021a..0d44196`. Redone: 3 expectation fixes in the new suite (draft-with-legacy is incomplete by verifier rule; verifier headline line; actual FAIL text) and one argv-limit fix; a type-only fix after the green run, suite re-run green. Report `.ada/claude-report-246.md`.
- 2026-11-25 T247 (Claude): Codex T202 NO fixed locally with Kenji's decision (a) (00:25 ET). `dbc21a1`: verify-receipt honours `canonical_withheld` only on source.api delegated-owner-read, only `actor_id`, only legacy acts, declared set = absent set (else exit 1); `verifyEvidenceSlice` option `withheldInputs` gives hash=unavailable (digest shape, links, agreement still judged) → exit 3, never 0 or compare; receipt states the limit; delegated acts omit idempotency_key; CLI receipts unchanged; docs/v5-receipt-format.md. `e8f2a25`: route 2 MiB UTF-8 whole-response ceiling (serialize once, `500 response_too_large`, size-only log), logged error codes from a closed set else `rpc_error`. `1885cc3` tests: verifyReceipt 60, eventVerifyV5 53, delegatedOwnerRead 28 PASS; delegated_owner_read_receipt.sh 39 PASS (genuine guest acceptance now exit 3, no FAIL; schema-limit worst case 1,769,275 B with 500 events/1,020,594 event bytes/500 acts fits; DoD past its CHECK 2,404,765 B refused). Decisions.md entry. Not pushed. Codex range `731d186..1885cc3`. Redone: local DB container had exited (restarted it); worst-case fixture reworked 4× (DoD CHECK limit, argv limit → container files, no-fork index → trail chained from the acceptance, note size for near-cap+near-500); one expectation message and one in-memory undefined key fixed in tests/builder. log-event `deno check` has 5 pre-existing supabase-js type errors, same at HEAD. Report `.ada/claude-report-247.md`.
- 2026-11-25 T248 (Claude): redo of T247's verifier branch because Codex T203 returned NO (malformed evidence could still get the exit 3 reserved for a legitimate omission). eventVerifyV5.ts: the withheld branch runs before missingProof() and requires isDigest(event_hash) (null/absent/malformed → invalid_input, exit 1); new `legacyWithheldShapeProblem` checks every remaining supplied input by version (UUID id/contract_id, printable type, zoned timestamp, digest-or-null dod/payload/agreement, prev digest/GENESIS/null; legacy nulls kept); rows without a declaration unchanged. Tests: verifyReceipt 73 PASS (single-act receipts so no later link masks the check: null/absent hash, 8 malformed-input cases with a complete key set and valid declaration, permitted nulls, non-UTC zone); delegated_owner_read_receipt.sh 39 PASS (unchanged). Commits `47469da`/`ff40f3c`; not pushed. Report `.ada/claude-report-248.md`.
- 2026-11-25 T249 (Claude): redo because Codex T204 returned NO (calendar day on withheld timestamps): the T248 created_at check relied on a finite Date, and V8 rolls 2026-02-29 / 04-31 / 24:00 forward, so those reached exit 3. eventVerifyV5.ts `zonedTimestampOk` now checks the captured fields against the calendar (month length with Gregorian leap rule, hour 0-23 so no 24:00, min/sec 0-59, offset 0-23:0-59) before any Date; withheld branch only. Tests: verifyReceipt 81 PASS (non-leap Feb 29, 1900-02-29, Apr 31, 24:00, +24:00 fail; 2028-02-29, 2000-02-29, zoned microseconds pass); delegated_owner_read_receipt.sh 39 PASS (unchanged). Commits `0dce5bc`/`16527ea`; not pushed. Report `.ada/claude-report-249.md`.
- 2026-11-25 T250 (Claude): committed 棟梁's Roadmap.md + docs/schedule.md row 5 / 5b lines with this line. **Push NOT done (stopped at step 2):** `origin/main..HEAD` (584021a..HEAD) changes served frontend code. `src/lib/auditExport.js` and `src/lib/guestRecordExport.js` (via guestEventView.ts) import `supabase/functions/_shared/eventVerifyV5.ts`, which T247–T249 changed. `vite build` at 584021a and at 27072ad in clean worktrees differ: one JS bundle 317,970 → 319,531 B, index.html differs only in the bundle hash; HEAD with only eventVerifyV5.ts reverted builds byte-identical to 584021a, so that file is the whole served change (the withheld-branch code: new strings 'withheld by the reader', 'not a zoned timestamp', 'event_hash: not a recorded digest'). The browser never passes `withheldInputs`, so the new branch is unreachable there, but the bytes change. Needs Kenji/ADA: push anyway (prod frontend redeploys with that inert code), or split. No E2E, prod, migration, deploy or route enable; deno.lock untracked. Report `.ada/claude-report-250.md`.
- 2026-11-25 T251 (Claude, Kenji option (1) 01:44 ET): eventVerifyV5 53, guestEventView 62, auditExport 36 unit tests PASS (151). Range unchanged since T250 (584021a..ad5694e; only docs after the measured 27072ad build, so the served change is still eventVerifyV5.ts alone). Normal push `584021a..ad5694e` (row 5b + docs). Vercel production `dpl_C9xXDi4ZzMzZ9wNjNBurXUuC7fSA` on `ad5694e` READY (~9 s), aliased to project-trustflow.vercel.app. No E2E, prod DB, migration, function deploy or route enable; ENTRY_DELEGATED_READ untouched (off). deno.lock untracked. Report `.ada/claude-report-251.md`.
- 2026-11-25 T252 (Claude, plan only): ranked the 4 open steps easiest→hardest: (1) root deno.lock → `/deno.lock` in .gitignore (Codex T180 view; no runtime effect); (2) 5b route on hosted E2E (read-only, flag-off rollback; needs 20261124231214 applied to E2E + verify_jwt choice; v5-fixture parts wait for gate open); (3) row 4 migration C (file `2026112x000002_drop_v5_check.sql` not yet written; needs local proofs + Codex); (4) gate open (depends on C; E2E v5 rows permanent). Nothing executed. PM docs committed `24f83c5`. No tests, SQL, push or flag change; deno.lock untracked. Nothing redone. Report `.ada/claude-report-252.md`.
- 2026-11-25 T253 (Claude, Kenji OK 10:33 ET): `/deno.lock` added to root .gitignore (# Misc block, comment cites Codex T180/T226; root-anchored so supabase/functions/deno.lock stays trackable) in `2c9227d`. `git check-ignore -v deno.lock` → `.gitignore:38:/deno.lock`; status clean; deno.lock untouched (shasum unchanged). No tests, push, deploy, SQL or flag change. Nothing redone. Report `.ada/claude-report-253.md`.
- 2026-11-25 T254 (Claude, plan only): runbook `docs/plans/row5-5b-e2e-enable.md` (`dd731fb`) for 5b on hosted E2E: read-only pre-checks (history, function list, secret names, baseline fingerprints, migration sha256 581c2884…), 🔑 apply 20261124231214 (T238 procedure: dry-run must list only it), 🔑 deploy delegated-owner-read with flag absent (503/OPTIONS/no-bearer 401 probes), 🔑 flag on + read-scope test grant (200, verify-receipt exit 3 on guest-accepted deal, 403 wrong secret/deal/mixed, 400/405, revoke→403, T241-style log redaction), 2 MiB refusal not reachable on hosted (schema worst case 1,769,275 B; local cX is the proof; optional 501-event test needs own OK, recommend skip), v5 parts pending gate open; rollback flag unset → 503, revoke, 🔑 function delete; migration stays. verify_jwt recommendation: true (matches log-event; T241 proved anon+grant passes). Nothing executed. Nothing redone. Report `.ada/claude-report-254.md`.
- 2026-11-25 T255 (Claude, Kenji OK 12:24 ET, runbook step 1 only): migration `20261124231214_delegated_owner_read.sql` applied to **hosted E2E `yqjtawffpesplqyurlpj` only** (linked ● project; file clean at HEAD, sha256 581c2884…f717; CLI 2.105.0; one `op read` → PGPASSWORD only). Pre: history latest 20261124130000 (55), read RPC/resolver absent, prerequisites read back (v5_grant_precheck(uuid,uuid,text), require_read_committed(text), events credential_id uuid / issuer_kind text, credentials table, private owned by postgres with no USAGE for anon/authenticated/service_role), gate 1 row closed, CHECK present, 0 v5 rows, grants 1, events 6098 / contracts 3831, PostgREST: RPC PGRST202, private PGRST106. Dry run listed exactly the one file; push exit 0. Post: history 56 latest 20261124231214; RPC definer + empty search_path, EXECUTE service_role only; 7 private helpers no EXECUTE for any API role; counts and md5 fingerprints identical; gate closed, CHECK present, 0 tickets; anon RPC call → 401 42501 (visible, denied), private still PGRST106. Secret names: ENTRY_DELEGATED_READ absent (checked after apply). No function deploy, flag, grant, production or push. Nothing redone. Report `.ada/claude-report-255.md`.
- 2026-11-25 T256 (Claude, Kenji OK 12:49 ET, runbook steps 2–4, hosted E2E only) — **BLOCKED at step 3, stop rule applied.** Step 2 PASS: `delegated-owner-read` v1 deployed once from `807cda9` (ezbr 8249e80f…, ACTIVE, verify_jwt true, other 4 functions unchanged); probes: approved-origin preflight 200 + ACAO + grant header + no-store, disallowed origin no ACAO (preflight and POST served, 503), no bearer 401 at gateway, fake-grant 503, GET 405 no-store; canary with known control: function_edge_logs 5/5 control rows, 0 canary hits; gateway logs only allowlisted headers (no x-trustflow-grant, no raw authorization); edge_logs never carries /functions/v1 rows on this project. Step 3: grant db6ea8ec… (owner_account, read, 2 h) issued via issue_entry_agent_credential on fixture 0853c261…; flag on (fake grant 403). **Positive read 403**: every delegated request was refused at admission as `mixed_credentials` (function_logs) because the function env `SUPABASE_ANON_KEY` differs from the legacy HS256 anon JWT clients send and the gateway accepts (secrets-list digest ad6b6dba… vs client key digest 505d4407…; neither key printed). So wrong-secret/wrong-deal/revoke checks never reached the RPC (403s identical but for the wrong reason). Valid PASSes: 400 ×3, 405, direct RPC anon 401/42501 and owner session 403/42501. Stop rule: flag unset → 503 confirmed, grant revoked (0 live grants), secret file deleted; no grant id / secret-hash / header in any log source; events 6098 / contracts 3831 and md5s unchanged; gate closed. **Same admission code serves log-event delegated append, so row 4 is affected too** (T241 was flag-off and never reached admission). Left: function v1 deployed, flag absent (503). No fix attempted, no push. Report `.ada/claude-report-256.md`.
- 2026-11-25 T257 (Claude, Kenji OK 13:06 ET, read-only): anon-key mismatch isolated by digest only (CLI api-keys JSON piped into a digest script; secrets list digests). E2E function env `SUPABASE_ANON_KEY` = the **`default` sb_publishable key** (ad6b6dba…), not the legacy anon JWT; clients/.env.e2e hold the legacy HS256 anon JWT (505d4407…), which the gateway accepts (verify_jwt true). Admission requires `Bearer ${SUPABASE_ANON_KEY}` exactly → mixed_credentials for every delegated request; a publishable bearer would fail the gateway (docs, not measured) → admission unreachable on hosted E2E by construction. Row 4 log-event delegated append uses the same check: equally affected (hold migration C / gate open). Recommendation ③: admission accepts `apikey` ∈ {SUPABASE_ANON_KEY} ∪ SUPABASE_PUBLISHABLE_KEYS (Authorization absent or equal), verify_jwt=false pinned for delegated-owner-read + log-event (config.toml), Codex + Opus review, agent docs updated; ②′ (trust gateway-verified legacy JWT) only as a dated stopgap. SUPABASE_SERVICE_ROLE_KEY digest matches none of the 4 listed keys (platform-internal; works). No writes. Nothing redone. Report `.ada/claude-report-257.md`.
- 2026-11-25 T258 (Claude, Kenji OK 13:12 ET, option ③, local only): delegated transport moved to the publishable key. `f5b330e`: `_shared/delegatedAuth.ts` admits only `apikey` ∈ SUPABASE_PUBLISHABLE_KEYS string values starting `sb_publishable_` (new `publishableKeys()`; unset/malformed/empty → none, fails closed; SUPABASE_ANON_KEY no longer read; no secret/service vars), **no Authorization header at all** (any bearer, incl. the legacy anon JWT or the key as bearer, = mixed_credentials), new log reason `public_key`; both callers (delegated-owner-read, log-event) pass the list. `42501fe`: unit delegatedAuth 36, delegatedOwnerRead 29, logEventDelegated 27, new publishableKey 9 — all PASS; `tests/e2e/publishableKey.js` reads the key via `supabase projects api-keys` in-process (never printed, .env.e2e untouched). `6d4e264`: runbook "Transport after T258" + superseded notes in row 4/5 plans. deno check: delegated-owner-read clean; log-event the same 5 pre-existing errors. Pushback recorded: Supabase docs say verify_jwt=true requires a JWT in Authorization, so the bearer-less profile is expected to get a gateway 401 on the re-run; per Kenji, keep true and switch to false (config.toml) only if that is observed. Redone: one test expectation (Headers strip surrounding whitespace per fetch spec; case changed to an embedded space); my edit script aborted once on its own over-strict guard before writing (no change). A `git stash` to compare lint briefly included 棟梁s uncommitted Roadmap/schedule; popped intact. No deploy, secret, flag, SQL or push. Codex range `eaad64f..6d4e264`. Report `.ada/claude-report-258.md`.
- 2026-11-25 T259 (Claude, local only): Codex T208 FAIL fixed. `03e48d5`: `PUBLISHABLE_TOKEN = /^sb_publishable_[A-Za-z0-9_-]+$/` gates every configured value (publishableKeys) and the request apikey before exact matching (list entries re-checked inside delegatedAdmission too), so a value with whitespace/comma/quotes/dot or a merged repeated apikey is refused fail-closed even if configured verbatim; `tests/e2e/publishableKey.js` uses the same token, a fixed alias set (`default`) and fixed-text errors only; installed CLI 2.105.0 checked via --help only: `--project-ref` is the target flag, no `--remote`/`--reveal` there; JSON rows {name,type,api_key} as measured digest-only in T257. `0994c79`: unit delegatedAuth 44, delegatedOwnerRead 30, logEventDelegated 27, publishableKey 12 — all PASS. `c663412`: runbook fallback rewritten: first probe flag-off without bearer (503 = reachable, 401 = stop); on 401 both flags off, v5 gate closed, rule out key config by digest/log first, then verify_jwt=false only for delegated-owner-read (single config.toml block or one --no-verify-jwt deploy, readback, 🔑, Decisions); log-event change needs its own staging check of delegated + owner/guest paths and its own 🔑. deno check: delegated-owner-read clean, log-event same 5 pre-existing errors; eslint clean; git diff --check clean. No stash used. Nothing redone. Codex re-review range `0f62e44..c663412`. Report `.ada/claude-report-259.md`.
- 2026-11-25 T260 (Claude, Kenji scope 12:49 ET): (A) `6fb947d` runbook per Codex T209: one current probe sequence (stale legacy-anon/no-auth-401 probes removed; --no-verify-jwt ban scoped to the initial deploy), per-value non-disclosing allowlist membership (a: rebuilt one-entry object digest; b: fixed refusal reason ≠ public_key; else stop; remediation/re-probe need separate OK), every-function baseline readback. (B) hosted E2E steps 2–4 with the T258/T259 transport: baseline 5 functions recorded (versions were +2 since T256 with identical ezbr/updated_at: each secrets set/unset bumps all versions, confirmed again by this run); `delegated-owner-read` v4 deployed once from `6fb947d` (ezbr 788f2139…, verify_jwt true). **Transport probe: apikey (publishable), no Authorization, flag off → 503, so verify_jwt=true admits the documented apikey profile (Codex T207/T208 reading correct; my T258 401 prediction wrong).** Membership (a) match + (b) grant_unknown. Preflight 200/ACAO, disallowed origin no ACAO, GET 405. Grant 514325fe… (owner_account, read, 2 h) on 0853c261…; flag on (fake → 403). **Positive read 200** (no-store, 9,322 B, 2 events stored_format legacy, receipt api delegated-owner-read, no idempotency_key, acceptance act canonical_withheld [actor_id], no guest address) → verify-receipt **exit 3**, hash=unavailable, 0 FAIL. Identical 403: wrong secret, wrong deal, unknown grant, user-JWT bearer, legacy-anon bearer, guest token, malformed grant; 400 ×3; 405; direct RPC anon 401/42501, owner session 403/42501; revoke → fresh read 403; flag unset → 503; no ENTRY_ secret. Two probe-script expectation errors (not route faults): the 200 envelope has no top-level `status` (shapeOwnerRead returns contract/events/read_boundary/receipt by design); no-apikey and legacy-JWT-as-apikey are refused earlier by the gateway (401 UNAUTHORIZED_NO_AUTH_HEADER), not the handler 403. Logs: canary/secret-hash/header 0 hits in all sources; grant id only as validated credential_id in the route fixed 4-key refusal lines (secret_mismatch/grant_unknown/revoked); the gateway logs `request.sb.apikey.apikey.prefix` (≤20 chars = sb_publishable_ + 5) itself. After: grants 3 / 0 live, events 6098 / contracts 3831 md5 unchanged, gate closed, 0 v5 rows; other 4 functions ezbr/verify_jwt/updated_at = baseline. Secret files deleted. No log-event deploy, row 4, production, push. Nothing redone. Report `.ada/claude-report-260.md`.
- 2026-11-25 T261 (Claude, Kenji OK 15:15 ET): (0) 棟梁 Roadmap/schedule committed `19b0363`. (1) normal push `9ea05eb..19b0363` (20 commits; no served frontend change: only delegatedAuth/delegated-owner-read/log-event + docs/tests/.gitignore). (2) `log-event` deployed once to hosted E2E only: v20 → **v21**, ezbr b65914a1… → 32733aae…, verify_jwt true kept (no config.toml in repo; hosted value kept, no --no-verify-jwt); other 4 functions ezbr/verify_jwt = baseline. (3) Row 4 probes with publishable apikey (in-process, never printed): preflight 200; flag off → 503; grant f4a311d3… (owner_account, ['performance.asserted'], 2 h, fixture 0853c261…); flag on (fake → 403); **allowed call → 503 delegated_append_unavailable with no refusal log line = authorized and stopped only at the closed v5 gate (no 201 possible until migration C + gate open)**; identical 403 for wrong secret/unknown/malformed grant, wrong scope, legacy-anon and user-JWT bearer, guest token; gateway 401 for missing auth, legacy JWT as apikey, malformed apikey, duplicate apikey; 400 authority_is_server_derived / invalid_payload; revoke → 403. Logs: expected reasons only, 0 hits on secret-hash prefix/grant header/JWT prefix. (4) flag unset → 503, no ENTRY_ secret. After: events 6098 / contracts 3831 md5 unchanged, 0 credential_id rows, 0 v5, gate closed, grants 4 / 0 live. Unit logEventDelegated 27 + delegatedAuth 44 PASS. Nothing redone. Report `.ada/claude-report-261.md`.
- 2026-11-25 T262 (Claude, Kenji OK 16:33 ET): 棟梁 Roadmap/schedule committed `896326f`. Local SQL (trustflow-localdb, disposable DBs): `tests/sql/delegated_append.sh` ALL PASS (74), `tests/sql/entry_agent_resolver.sh` ALL PASS (41). Hosted E2E live `event-ingestion.spec.js` + `guest-evidence.spec.js` (chromium) **24/24** against log-event v23 (= T261 v21 code, ezbr 32733aae…, verify_jwt true), no ENTRY_ secret before/after; events 6098→6132 (spec fixture writes only), 0 credential_id / 0 v5 rows, gate closed, 0 live grants. Not run (before migration C): delegated_append_races.sh. No deploy/migration/flag/push. Nothing redone. Report `.ada/claude-report-262.md`.
- 2026-11-25 T263 (Claude, local only): 棟梁 Roadmap/schedule committed `d6c66d2`. `tests/sql/delegated_append_races.sh` on trustflow-localdb (disposable DB, dropped after): exit 0, ALL PASS (30): revoke-first refuses the waiting append with nothing written, append-first then revoke completes after it, post-revoke replay/fresh append refused, owner/guest writers holding the deal give chain_conflict then the rebuilt append lands, no write ticket left. Gate-close vs admitted append is covered by entry_agent_resolver.sh (T262 PASS). Row 4 local suites all green: append 74, resolver 41, races 30. No hosted/deploy/migration/flag/push. Nothing redone. Report `.ada/claude-report-263.md`.
- 2026-11-25 T264 (Claude, Kenji OK 16:43 ET, local only): 棟梁 docs `4da2f70`. **Migration C written** `d337e61`: `supabase/migrations/20261125214511_drop_v5_check.sql` (sha256 7ad4e346…0f8aad) drops `events_v5_writes_disabled`; preconditions fail the migration: gate row present and closed, held FOR SHARE to commit (TF951), CHECK present (TF952), both ticket triggers enabled and BEFORE sorts last (TF953), trigger fns definer + empty search_path (TF954), no API-role privilege on trigger fns/ticket/gate (TF955); self-test CHECK gone (TF956), other 4 v5 constraints validated (TF957), gate closed (TF958); no row change. New `tests/sql/drop_v5_check.sh` ALL PASS (27): C refuses without B / gate open / AFTER trigger disabled / EXECUTE granted / invoker fn / second apply, CHECK kept each time; after C with gate closed: writer gate_closed, direct v5 as postgres and service_role TF011, ticket + closed gate TF013, missing gate TF012; gate open (rolled back): direct TF011, late BEFORE rewrite TF014, legacy writers TF011 ×3 both gate states, v4 insert stored, writer appends v5 with ticket consumed. Re-run: delegated_append 74, entry_agent_resolver 41, delegated_append_races 30 ALL PASS (fixed lists stop at B). Not applied anywhere hosted; no gate/flag/deploy/push. Redone: error codes TF941-948 → TF951-958 (collision with 5b read migration) and two script syntax fixes, all before the first run. Next: Codex review of `4da2f70..d337e61`, then E2E apply (own OK). Report `.ada/claude-report-264.md`.
- 2026-11-25 T265 (Claude, local only): pre-C state suites on the local disposable DB: events_v5_authority 132, delegated_owner_read 136, delegated_owner_read_receipt 39, ALL PASS. Their migration lists stop at `20261124231214`, so this shows the pre-C state is still green at `4449043`, not the post-C state (only drop_v5_check applies C). Migration C and its suite untouched during the Codex review; nothing hosted, no gate/flag/deploy/push. Redone: nothing. Report `.ada/claude-report-265.md`.
- 2026-11-25 T210 (Codex, static `d337e61`): **NO — hold hosted row 4 step 4.** Verify exact ticket-trigger bindings and firing conditions under the events DDL lock, and check effective column ACLs on gate/ticket tables. Exact SQLSTATE proofs are sound for the covered local cases; confirm single-transaction runner before applying. Report `.ada/codex-report-210.md`.
- 2026-11-25 T266 (Claude, local only): Codex T210 must-fixes on migration C, `89031f3` (棟梁 docs `57a6e12`). C now takes `lock table public.events in access exclusive mode` first, then gate FOR SHARE, then checks; TF953 pins each ticket trigger to B (tgfoid, tgtype 7/5, enabled O, not deferrable/constraint, no args, pg_get_triggerdef incl. WHEN); TF954 adds B's md5(prosrc); TF955 adds has_any_column_privilege on gate and tickets. sha256 77647b1b…27b254. drop_v5_check.sh ALL PASS (41 PASS lines, 14 new): 6 trigger drifts TF953, body replace TF954, 3 column grants TF955, concurrent uncommitted trigger disable (C waits 3 s, then TF953), post-drop TF957/TF958/TF956 rolled back; each drift in C's own tx with catalog fingerprint unchanged. Noted, not built: hosted runner one-tx/READ COMMITTED, triggerdef rendering on E2E (fails closed), owner/update-immutability preflight, replica-mode bypass of 'O' triggers. Redone: fingerprint `text || "char"` error on first run (added ::text), regprocedure cast → to_regprocedure before first run. Nothing hosted, no push. Report `.ada/claude-report-266.md`.
- 2026-11-25 T211 (Codex, static `89031f3`): **PASS for hosted row 4 step 4 after preflight and separate Kenji OK.** T210 trigger/lock, column ACL and post-drop rollback findings closed. Verify one READ COMMITTED transaction, deployed trigger and function definitions/owners, effective ACLs and append-only rules before apply. Report `.ada/codex-report-211.md`.
- 2026-11-25 T267 (Claude, Kenji OK 16:43 + 20:01 ET, E2E only): **BLOCKED, migration C NOT applied.** Preflight on `yqjtawffpesplqyurlpj` all matched (PG 17.6, read committed, rendered trigger defs byte-identical to C's pins, B fn md5/owner postgres/definer/empty path, no API-role table/column/EXECUTE privilege, append-only rules no_update/no_delete_events, srr origin and not settable by exposed roles); step-2 write proofs in an always-raised DO block: writer gate_closed, direct service_role v5 TF011, append_guest_event v5 TF011, accept_invitation v4 accepted, direct v4 stored; step-3 flag-off 503, no ENTRY_ secrets; dry run listed exactly C. **`supabase db push` (CLI 2.105.0) failed at statement 0: `LOCK TABLE can only be used in transaction blocks` (25P01)**: the runner batch is atomic (T107) but not a transaction block; the local proof used psql -1. After: history 56, CHECK present+validated, triggers 2, gate closed, events 6132/contracts 3852 md5 identical, 0 tickets, 0 live grants, no AE lock. Decision needed: recommended move the lock into C's first DO block and prove with the real CLI locally, then Codex re-review and a new OK. Redone: two proof-SQL bugs of mine (uuid cast, text contract_id) before the apply, no data effect. No 棟梁 docs were uncommitted. Report `.ada/claude-report-267.md`.
- 2026-11-25 T268 (Claude, local only): fix for T267. `c00996d` moves C's `lock table public.events in access exclusive mode` into the first DO block (nothing else changed; sha256 2ed6a8ea…a69d8d) and adds `tests/sql/drop_v5_check_cli.sh`, which drives the real `supabase db push --db-url` (CLI 2.105.0) against a disposable local DB with a throwaway login role: TF951 and post-drop TF957 each leave the CHECK and no history row; concurrent disable → waits, TF953; while blocked on the gate C's backend holds AE on events, and the DROP starts with that lock still held (event-trigger probe at ddl_command_start), so one transaction; success → CHECK gone, 1 history row. ALL PASS (8). Negative control with the T266 C reproduces 25P01. drop_v5_check.sh ALL PASS (41). Redone: added TF_C_FILE override for the control, re-run green. Codex re-review `35f90f1..c00996d`. Nothing hosted, no push. Report `.ada/claude-report-268.md`.
- 2026-11-25 T212 (Codex, static `c00996d`): **PASS for hosted row 4 step 4 retry after refreshed T211 preflight and separate Kenji OK.** First DO takes the events lock before checks; T268 local CLI proof supports retention through DROP and rollback. CLI fixture SQLSTATE parsing, cleanup ownership and timing notes in `.ada/codex-report-212.md`.
- 2026-11-26 T269 (Claude, Kenji OK 13:53 ET, E2E only): **migration C applied to E2E** `yqjtawffpesplqyurlpj` via `supabase db push --db-url` (CLI 2.105.0, same as T268), file sha256 2ed6a8ea…a69d8d. Preflight all matched (read committed, role postgres + search_path, triggerdefs 2/2, function md5/owner/definer, ACLs incl. column 0, srr origin and not settable by API roles, append-only rules, gate closed, no concurrent sessions/locks); step-2 proofs `writer=gate_closed; direct_v5=TF011; accept_v4=accepted; direct_v4=stored; guest_v5=TF011`; flag off (503, 0 ENTRY_ names); dry run listed only C. After: history 57 with C, CHECK gone, triggers/functions/ACLs unchanged, gate closed, 0 tickets, events/contracts md5 unchanged, step-2 proofs and flag-off identical. Redo: the first preflight catalog query failed 42725 (`text || "char"`), read-only, recast. Gate opening stays a separate step. Codex T212's CLI-suite should-fixes remain open.
- 2026-11-26 T270 (Claude, Kenji OK 14:08 ET): committed 棟梁's Roadmap.md/docs/schedule.md (`90bc14d`), then normal push `afcb8ab..90bc14d` (20 commits incl. migration C file). Pre-push: verify.yml is offline-only (no secrets/DB URL), no config.toml/branching in repo, prod `list_branches` = [] so nothing auto-applies migrations; prod DB untouched, C unapplied on prod. After: Actions verify success, Vercel prod dpl_7c6S1TEfyZ62HgzgkDxoXseVNEYx READY. No redo.
- 2026-11-26 T271 (Claude, Kenji OK 14:08 ET): **BLOCKED before acting, nothing touched** (no hosted query/update/secret/grant/deploy; E2E gate stays closed, flag off). Reason: `tests/e2e/delegated-append.spec.js` named in plan §4b/§4c step 5 was never written (no git history). Its first live run writes permanent v5 rows (append-only) on an auth boundary, so it should be written locally, Codex-reviewed, then T271 re-issued. Proposal in `.ada/claude-report-271.md`.
- 2026-11-26 T272 (Claude, local only): `bc015c9` adds `tests/e2e/delegated-append.spec.js` (opt-in TF_DELEGATED_TRIAL=closed|open; items 1–4: refusals, one v5 append with grant authority, same-key replay, owner key collision 409, all four readers match + overall verdicts equal pre-append baseline + make/verify-receipt CLI, revoke then refused; E2E-only guard before any request, 0600 grant file, owner/deal/grant/flag preflight, write budget 0/1, afterAll armed after target guard: revoke + secrets unset ENTRY_DELEGATED_APPEND + 503 confirm) and `tests/e2e/delegatedReaders.js` + `tests/unit/delegatedReaders.test.js` (3/3). Dry runs local only: unit 3/3, mode unset 6 skipped, invalid mode / prod URL / local URL refused before any network; no local function stack, so the real dry run is closed mode on E2E in T271. Redo: audit doc unwrap, guest credential from canonical (not the label), afterAll armed flag added before any run. No hosted call, no push. Codex review next.
- 2026-11-26 T213 (Codex, static `bc015c9`): **NO with must-fixes; hold both hosted trial modes.** Confirm the actual gate and enforce a one-attempt write bound, pin every outbound path, make cleanup independently verifiable, and require targeted refusal readbacks and positive receipt evidence. Report `.ada/codex-report-213.md`.
- 2026-11-26 T273 (Claude, local only): Codex T213 must-fixes in the delegated-append trial. One exclusive attempt record per run (`TF_DELEGATED_ATTEMPT`, key `trial-<attempt>`, retries/repeat/workers>1 refused), read-only gate readback (`supabase db query --db-url`) before writes and at the append, verified baseline recorded first. Cases that would write if broken run only behind the confirmed closed gate; owner-path 409 dropped (Codex default). New `scripts/lib/pinnedFetch.mjs` + preload (E2E origin only, no redirects, bounded; also the make-receipt child). Owned, bounded, verifiable cleanup shared with operator `scripts/delegated-trial-cleanup.mjs`. Per-case by-key readbacks, real comparison deal (`TF_DELEGATED_OTHER_DEAL`, needs an approved deal), positive RECEIPT VERIFIED, allowlisted output. Unit 3/3, lint clean, all guard refusals local. Redo: first dry-check loop didn't word-split under zsh (no case ran), re-run; `project.repeatEach` doesn't see `--repeat-each`, so added `repeatEachIndex`; hook timeouts raised above the 30 s default. No hosted call, no push. Report `.ada/claude-report-273.md`.
- 2026-11-26 T274 (Claude, read-only E2E SELECTs only): picked the closed-run comparison deal `TF_DELEGATED_OTHER_DEAL=eaf3af86-acb1-4616-8cac-dae5cd1e812d` (Event Ingestion Probe: same owner, TERMS_ACCEPTED, creator, one numeric-snapshot v4 acceptance, 0 grants, not reused by its spec; fallback `2bc71eb0…`). Excluded `fffffff0-…` (shared expired-token fixture, 0 events). Grant issuance default: Claude inside the approved run, SQL `issue_entry_agent_credential` with only the sha256 (as T261), secret made locally in a 0600 scratchpad file outside the repo, list readback, revoke + file deletion after; endpoint rejected (needs a second flag on, secret in an HTTP body). Decisions.md entry added. No write/grant/flag/gate/spec change, no push. Redo: the first candidate query failed 42883 (`events.contract_id` is text), re-run with `::text`. Report `.ada/claude-report-274.md`.
- 2026-11-26 T4 (Antigravity, static `18d21d3..105bd47`): **NO — hold both hosted trial modes (2 must-fixes, 4 should-fixes, 4 nits).** MF2 (E2E pinning) closed; MF1/MF3/MF4 partially open: `delegated-append.spec.js:208` tests `dod.consent_recorded` (`400` in pre-dispatch `ALLOWED_TYPES` check) and never enters `delegatedAppend()`/`DELEGATED_TYPES` (needs an `ALLOWED_TYPES` \ `DELEGATED_TYPES` type expecting `403 delegation_refused`), and `:185-188` flag-on preflight checks only `status !== 403` without `error === 'delegation_refused'` before claiming `flag_owned: true`. Unit `delegatedReaders.test.js` 3/3 PASS; no hosted calls. Report `.ada/antigravity-report-4.md`.
- 2026-11-26 T275 (Claude, local only): agy T4 fixes in the delegated-append trial. MF1: `dod.consent_recorded` relabelled as the pre-dispatch server-recorded case (400 `type_is_server_recorded`); new `dispute.opened` case reaches `delegatedAppend()` outside `DELEGATED_TYPES` (403 `delegation_refused`, 0 rows). A grant can never hold that scope, so HTTP can't tell allowlist from scope; T271 should read back the function log's `delegated_refusal: allowlist` line. MF2: flag probe needs 403 + `delegation_refused`, blank grant (in-memory refusal). SF1 settle loop waits for exactly 503 `delegated_append_unavailable`; SF2 every refusal asserts its error word; SF3 `--unset-flag` alone; SF4 `armed` reset per repetition. Nits: grant file O_NOFOLLOW + fstat + 0o7777; random temp name for the attempt record. Not done (noted): guest `count` on an incomplete tail. Gap reported: no unit test of the TS delegated allowlist in log-event. Lint clean, unit 3/3, all guard refusals local. agy's HANDOFF line was already committed (`67b6138`), so no separate commit; `.ada/` reports stay uncommitted. Redo: none. No hosted call, no push. Report `.ada/claude-report-275.md`.
- 2026-11-26 T5 (Antigravity, static `67b6138..3b45ff0`): **PASS with should-fix — cleared for closed-mode hosted run.** MF1 (incl. acceptable log-readback limit for `delegated_refusal: "allowlist"`), MF2 strict `403 delegation_refused`, SF1/SF2/SF4, Nits 1–2 closed; Nit 3 and missing TS `DELEGATED_TYPES` unit test do not block closed run. 3 non-safety should-fixes: (1) use non-empty malformed `grantHeader` (e.g. `'malformed'`) instead of `''` on preflight (`delegated-append.spec.js:190`) and cleanup (`delegatedTrial.mjs:264`) in case gateway strips empty headers; (2) guard `ownerSession()` in `cleanupTrial` (`delegatedTrial.mjs:227-230`) with `if (grantToRevoke || state?.baseline)` so `--unset-flag` works truly standalone; (3) pre-existing `Authorization: Bearer ${pub}` (`delegated-append.spec.js:227`) risks gateway `401` under `verify_jwt: true` (legacy anon JWT passes to `403 delegation_refused`). Unit `delegatedReaders.test.js` 3/3 PASS; no hosted calls. Report `.ada/antigravity-report-5.md`.
- 2026-11-26 T276 (Claude, local only): agy T5 should-fixes. Preflight and cleanup flag probes send the malformed token `malformed` (refused in memory, no empty header for a gateway to strip; the `blank grant` refusal case kept on its own). `cleanupTrial()` opens the owner session only when there is a grant to revoke or a baseline to check, so `--unset-flag` alone verifies without earner credentials. The bearer refusal uses the legacy anon JWT (passes verify_jwt, T261 measured), not the publishable key (gateway 401). Lint clean, unit 3/3, guard refusals local. Redo: four grant-file dry checks first ran with an unsplit `$O` under zsh (refused on mode instead), re-run with explicit vars. Hosted closed-run procedure (grant via `issue_entry_agent_credential`, comparison deal `eaf3af86…`, expected 2 passed / 3 skipped / 0 rows, log readback incl. `allowlist`) in `.ada/claude-report-276.md`. No hosted call, no push.
- 2026-11-26 T277 (Claude, 棟梁 OK for the E2E closed run): **BLOCKED at step 0, nothing hosted changed** (no grant, no flag, gate untouched, attempt `closed-1` unused). Read-only baseline: gate closed, events 6132 / contracts 3852, 0 v5 / 0 credential rows, 4 grants / 0 live, 0 ENTRY_ secrets, log-event v23 ezbr 32733aae…. `manage-entry-agent-credential` is **not deployed on E2E** (never was, cf. T153), but the spec's grant readback, revoke test and cleanup revoke call it: a run would 404 in beforeAll and burn the attempt. It is the plan's §4c step 1 prerequisite, and I missed it in T274/T276. Recommended: deploy that one function to E2E (issuance flag stays off), then re-issue T277 unchanged. No redo. Report `.ada/claude-report-277.md`.
- 2026-11-26 T278 (Claude, Kenji scope E2E up to gate open): **deployed `manage-entry-agent-credential` to E2E only**: v1, ezbr 58c01242…, verify_jwt true, local bundling from `5786ce1`; other functions unchanged; issue → 503 issuance_disabled, owner list 200, no-JWT list 403. **T277 closed run BLOCKED, failed closed, 0 rows.** Grant 0ee6f386… (hash prefix eebfc6615d7c) issued via SQL RPC; flag on 23:29:41Z; spec beforeAll threw at its first gate readback (`not exactly one boolean gate row`) before any write-capable call. Cause, my T273 bug: `supabase db query -o json` prints the `{boundary,rows}` wrapper only when it detects an agent env, but `run()`'s allowlisted env gets a bare array, so `readGate` fails. Stop rule: `delegated-trial-cleanup.mjs --grant-id … --unset-flag` printed grant_revoked/flag_off true, then CLEANUP INCOMPLETE only on that same readback; SQL confirms gate closed, grant revoked, 0 live. Data md5s unchanged, no ENTRY_ secret, no delegated log lines, grant file deleted. Attempt `closed-1` is used up. Next: local readGate fix (`--agent no`, bare-array parse, unit + dry check under run()'s env) + review, then closed run as `closed-2`. No redo, no push. Report `.ada/claude-report-278.md`.
- 2026-11-26 T6 (Antigravity, read-only `5786ce1`): **GO (deploy as is)** for `manage-entry-agent-credential` on E2E only (`verify_jwt: true`, `ENTRY_CREDENTIAL_ISSUANCE` unset). `issue` fails closed `503 issuance_disabled` before auth/DB (`index.ts:32-34`); `list`/`revoke` require verified non-anonymous user JWT (`:38-42`) and stay issuer-scoped via `service_role`-only `SECURITY DEFINER` RPCs (`20261118214020:131-159`); immune to fix ③/publishable-key mismatch (uses account JWT, not `delegatedAuth`); not stale across subsequent migrations and matches T277 spec/cleanup contract. `entryCredentialHandler.test.js` 10/10 PASS, `deno check` exit 0; no hosted calls. Report `.ada/antigravity-report-6.md`.
- 2026-11-26 T279 (Claude, local only): fixed the T278 gate-readback bug (`7fa2319`; first commit attempt failed on untracked pathspecs, and this line originally named the wrong hash). `readGate()` now runs `supabase db query --agent no …` (the CLI wraps `-o json` rows only when it detects an agent, so a real run's stripped env got a bare array), through the new pure `parseGateRows` (exactly a bare array of one `{open: boolean}`; the wrapper and anything else fail closed) and `queryGate`. New `tests/unit/delegatedTrialGate.test.js` (with delegatedReaders 6/6 PASS) and local-only `tests/sql/gate_readback_cli.sh` (ALL PASS: real queryGate under run() env reads closed/open, no row refused, read-only write refused; without the pin this shell gets the wrapper, which confirms the root cause). Lint clean, spec loads/skips/refuses production. Redo: the CLI check's first run failed on my own assertion (psql `f` vs `false`), re-run. No hosted call, no push. Next: closed run as `closed-2`. Report `.ada/claude-report-279.md`.
- 2026-11-26 T7 (Antigravity, read-only `bdf3d66..dd3cec6`): **GO** for hosted E2E closed run `closed-2`. Confirmed `--agent no` placement (`delegatedTrial.mjs:96`) is supported as a global flag on CLI 2.105.0 (Bun shim + `supabase-go`), stderr notices/warnings are discarded by `run()`, and `parseGateRows` (`:103-111`) fails closed with fixed `TrialError` on every non-matching shape (wrapper, empty, 2 rows, non-boolean, extra/`__proto__` keys, non-JSON). `readGate()` remains pinned to read-only `E2E_GATE_DB_URL` under `run()`'s allowlisted env; spec and `cleanupTrial()` unchanged; `gate_readback_cli.sh` hides no blocker vs hosted E2E. Unit `delegatedTrialGate.test.js` + `delegatedReaders.test.js` 6/6 PASS; no hosted calls. Report `.ada/antigravity-report-7.md`.
- 2026-11-26 closed-2 (Claude, Kenji via Kurimanju): **hosted E2E closed run PASS**: 3 passed / 2 skipped (open-only), 0 rows, afterAll CLEANUP VERIFIED (grant aa1d8025… revoked and read back, flag off with 503 confirmed, gate closed, rows_written 0, rows_with_key 0). Gate readback (T279 fix) read closed before the run and at the append; the baseline was verified in all four readers incl. RECEIPT VERIFIED; the valid append got 503. Data md5s identical before and after, 0 v5 / 0 credential rows, 0 live grants, no ENTRY_ secret, grant file deleted. Logs: malformed_grant 4, secret_mismatch 1, grant_unknown 2, scope 1, **allowlist 1**, mixed_credentials 1, revoked 1; 0 leak hits. No redo, no push. Next: open trial (gate open + 1 permanent row) needs its own OK. Report `.ada/claude-report-closed-2.md`.
- 2026-11-26 open-1 (Claude, Kenji via Kurimanju): **E2E gate opened** (`update private.v5_write_gate set open = true`, 01:05:50Z, one statement; CHECK already dropped, both ticket triggers enabled) and **open trial PASS**: 4 passed / 1 skipped (closed-only refusals), **one permanent v5 row `1f0fc767-d40a-4e03-a645-cb7f5da5dcb8`** on fixture 0853c261… (performance.asserted, credential 6062dd5a… owner_account, actor = owner, key trial-open-1, links the previous tip). 201 then replay 200 with the same id; all four readers verified; in-process and CLI receipts RECEIPT VERIFIED; revoke read back, then replay 403; cleanup VERIFIED (flag off with 503, rows_written 1). Data: events 6133, md5 of the other rows unchanged; contracts unchanged except the fixture's state TERMS_ACCEPTED → AWAITING_CONFIRMATION (the normal projection; the fixture can't be reused for another open run). 0 live grants, 0 tickets, no ENTRY_ secret, grant file deleted, 0 log leak hits, 0 faults. **Gate left OPEN on E2E** (plan §4c step 6 = Kenji's call; flag off keeps the route at 503; close = one statement). Production untouched. No redo, no push. Report `.ada/claude-report-open-1.md`.
- 2026-11-26 T8 (Antigravity, read-only audit of `open-1`): **CONFIRMED.** Independently recomputed E2E receipt (`make-receipt` exit 0, `verify-receipt` exit 0, `RECEIPT VERIFIED — recomputed offline`, temp file deleted): act `1f0fc767-d40a-4e03-a645-cb7f5da5dcb8` has `hash_version` 5, `credential_id` `6062dd5a-c613-4b4f-926f-e2915aa1ddce`, `issuer_kind` `owner_account`, links baseline tip `1e928920-…` (`f2eab700…`), state `AWAITING_CONFIRMATION`. Primary artifacts (`open-1.json`, `.ada/open-1-run.log`) support 1 row + replay dedupe, revoke + refusal, flag off 503, cleanup `problems: []`; DB-wide MD5/counts/log-leak claims are report-only (not contradicted). Static v5-path audit with gate OPEN + flag OFF: all external/client/Edge/direct-insert/legacy-RPC paths blocked (`503`, `TF011`/`TF014`), but direct `service_role` can call `issue_entry_agent_credential` + `append_delegated_event` bypassing both Edge flags; recommend closing E2E gate until Row 8. No writes, no prod contact, no push. Report `.ada/antigravity-report-8.md`.
- 2026-11-27 gate close (Claude, Kenji via Kurimanju, after agy T8 recommended closing): **E2E gate closed**: `update private.v5_write_gate set open = false`, one statement, returned open=false at 15:18:41.69Z. Readback: 1 gate row with open=false (SQL and the spec's read-only `readGate()` both say closed); events 6133, v5 rows 1 (open-1's `1f0fc767…`, unchanged); 0 live grants, 0 tickets, both ticket triggers enabled; no ENTRY_ secret. Closes the service_role self-issue path agy T8 found (and that I had missed in the open-1 report). Reopening is the same statement with true. Production untouched, no push.
- 2026-11-27 Row 8 local candidate consolidation (Antigravity, local only — **Row 8 live E2E and Row 9/production NOT done; not pushed, no hosted calls**):
  - **Completed local commits (35 ahead of `origin/main` through `f17be05`):**
    - Row 6 (default-off owner credential UI, expired-vs-anonymous auth boundary, wiring tests): `f7edc32` → `2c8f057` → `3ce23d7` — **Claude GO** (`.ada/claude-review-row6-3ce23d7.md`).
    - Post-C SQL regressions (disposable PG 17.6): `ee70e95` — append races 29, owner-read races 14, receipt 39, ALL PASS (`.ada/post-c-local-regression-report.md`).
    - Row 7 (delegated bot bootstrap, grant-only owner agent, fail-closed recovery, exact `503 issuance_disabled` terminal refusal): `a19977e` → `4f62aea` → `001e149` → `ec4e10d` → `33f752e` — **Claude GO** (`.ada/claude-review-row7-33f752e.md`).
    - Row 8 delegated two-agent simulator (`--delegated`): `5339af3` — **Antigravity GO** (`.ada/antigravity-report-13.md`) and **Claude A3 GO** on final Row 7 interface (`.ada/row8-release-readiness-update-33f752e.md`).
    - Row 6 offline browser regression harness (`tests/browser/playwright.row6.config.js`, `tests/browser/row6-credentials.spec.js`): `f17be05` (**Claude GO**, `.ada/claude-review-row6-f17be05.md`, network isolation proven behind dead proxy) → `e736886` (flag-off explicitly pinned to `''` against local `.env*`, `ModalDialog` focus/`Escape` dismiss, second-user cross-tab switch) — **6/6 PASS offline in Chromium** (`16.7s`, 0 hosted/third-party calls).
    - W2b E2E-only zero-write direct `POST /rest/v1/events` denial probe (`scripts/probe-direct-events-insert.mjs`, `tests/unit/directEventsInsertProbe.test.js`): `80e0988` (pending Claude independent review).
  - **Pinned Row 8 run candidate SHA (`80e0988`, 38 local commits ahead of `origin/main`):**
    - `make check` **PASS** at `80e0988`: `check:migrations` 57 files OK, `npm test` **54/54 files / 1281/1281 tests**, `vite build` 1.08s.
    - Offline Row 6 browser gate **PASS** at `80e0988`: `npx playwright test --config tests/browser/playwright.row6.config.js` **6/6 PASS** (`16.7s`, 0 hosted calls).
    - Restricted simulator child CLI/auth route (code/config inspection, zero secret reads / zero hosted calls): `delegated-two-agent.mjs:229-232` forwards `PATH` (`/opt/homebrew/bin/supabase`), `HOME`, `TMPDIR`, and optional `SUPABASE_ACCESS_TOKEN` into `bootstrap.mjs`, and `delegatedTrial.mjs:64-82` forwards `PATH`, `HOME`, `TMPDIR`, and `SUPABASE_ACCESS_TOKEN` into `supabase projects api-keys --project-ref yqjtawffpesplqyurlpj -o json`. On macOS without `SUPABASE_ACCESS_TOKEN`, `supabase` CLI resolves its login via `HOME` (`~/.supabase/access-token`) / macOS Keychain (`getuid()`), so no local code blocker exists; operator must export `.env.e2e` vars in the shell before W1 because `operatorEnv` sets `TF_E2E_ENV_FILE=/dev/null`.
  - **W0 read-only hosted preflight (`.ada/row8-w0-preflight.md`, E2E `yqjtawffpesplqyurlpj` only, ~18:31Z):**
    - **Clean baseline:** 57 migrations matching repo through C; `private.v5_write_gate` closed (`open = false`); 0 `ENTRY_*` secrets; 7 revoked grants (0 live); 0 v5 write tickets; contracts **3852**, events **6133**, 1 known delegated row (`1f0fc767…`); 0 `agent bootstrap %` deals; QA earner `5984f56a…` verified.
    - **Function drift (1 item for B1):** `manage-entry-agent-credential` v7, `log-event` v29, `delegated-owner-read` v14 match HEAD; `validate-invite-token` v28 is Row-8-equivalent; **`guest-contract-events` v26 (deployed 11-24 19:53Z) DRIFTS from HEAD** (missing `648653c` blank `recorded_credential` refusal and `dbc21a1`/`47469da`/`0dce5bc` `eventVerifyV5` withheld-input branches).
    - **Exact next E2E-only B1 deploy + readback step (after OK):** deploy **`guest-contract-events` only** from pinned SHA `80e0988` with Docker local bundling (`supabase functions deploy guest-contract-events --project-ref yqjtawffpesplqyurlpj`), then read back `version` (>26), `status: ACTIVE`, `verify_jwt: true`, and `entrypoint` (`file:///Users/…`); no other function needs a deploy.
  - **Minimal operator approvals needed before W1 (each a separate OK; E2E `yqjtawffpesplqyurlpj` only):**
    1. **B1:** Approve E2E-only redeploy of `guest-contract-events` from `80e0988` + readback (or explicitly accept v26 as reader of record).
    2. **A6/A7:** Decide local-checkout vs push for Row 8 (any push auto-deploys Vercel production → requires read-only Vercel prod env check confirming `VITE_OWNER_CREDENTIALS_UI` is absent first).
    3. **A8:** Confirm SQL race proofs (`ee70e95`) + optional rolled-back `TF011` denial suffice (no live races).
    4. **W1 approvals (B2–B5):** B2 `ENTRY_CREDENTIAL_ISSUANCE=on`; B3 `ENTRY_DELEGATED_READ` + `ENTRY_DELEGATED_APPEND` on; B4 open `private.v5_write_gate` (close + read back after W1); B5 simulator budget **`1/1/2`** + fresh `--run <id>` (expected W1 deltas: contracts +1 → 3853, events +2 → 6135, grants +1 → 8 revoked, tickets 0).
    5. **Separate W2/W3 budget (excluded from simulator `1/1/2`):** Approve **`+1` grant G2** (`1/2/2` total) on deal D for W2 live Row 6 UI + W2b `probe-direct-events-insert.mjs` (0 writes) + W3 post-expiry negatives (0 writes), and decide whether B3 stays on across the ≥1 h expiry wait. Production (Row 9) stays untouched and unapproved.
