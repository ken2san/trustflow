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
