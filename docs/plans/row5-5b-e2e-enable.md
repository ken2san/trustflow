# Row 5b: enabling the delegated owner read on hosted E2E (runbook)

**Scope:** hosted E2E only, project `yqjtawffpesplqyurlpj`. Production is out of scope. Production keeps no migration, no function and no flag.

**Status:** written in T254, plan only. Codex is reviewing the migration and the `verify_jwt` choice separately, in codex-task206.

**🔑 marks a step that needs Kenji's OK.** Each OK covers that one step. If a step fails, stop: no retry, no manual fix, and report as blocked.

**Already in place:**
- Code: 5a (Codex T201 YES) and 5b (Codex T205 YES), both pushed in T251 (`ad5694e`).
- Row 4's gateway, CORS and header-log proofs passed on E2E in T241. Row 5 plan §3 waited on these.

## 0. Pre-checks (read-only, no OK needed)
Run against E2E through the Supabase connector:
1. **Migration history:** `20261124130000` is the latest, and `20261124231214` is absent.
2. **Functions:** `delegated-owner-read` is not in the function list. Record `log-event` and `guest-contract-events` as they are now (version and ezbr).
3. **Secrets:** checked by name only, never by value. `ENTRY_DELEGATED_READ` is absent.
4. **Baseline:**
   - gate: one row, closed;
   - `events_v5_writes_disabled`: present;
   - grant count;
   - events and contracts counts;
   - md5 fingerprints as in T238: `(id, event_hash, prev_event_hash, hash_version, payload_hash)` over events, and the jsonb of each contract.
5. **Local file:** `supabase/migrations/20261124231214_delegated_owner_read.sql` must satisfy `git diff --quiet HEAD` and have sha256 `581c2884b2459c6a6737600dea9b3cadded626a3b3efd3bb9791db4c8c78f717`. That is the reviewed content. Anything else means stop.

## 1. 🔑 Apply migration `20261124231214` to E2E
This follows the T238 procedure:
- **Credential:** one `op read` of the E2E DB password into `PGPASSWORD` only. It is unset at exit and never printed.
- **Dry run:** `supabase db push --db-url <e2e> --dry-run`. It must list exactly `20261124231214_delegated_owner_read.sql`; the script stops on any other list.
- **Apply:** `supabase db push` once.

**Post-apply checks (read-only):**
- **History:** `20261124231214` is now the latest.
- **The RPC:** `public.read_delegated_owner_deal(uuid, uuid, text)` is SECURITY DEFINER with an empty `search_path`. EXECUTE goes to `service_role` only, with none for `anon`, `authenticated` or PUBLIC.
- **Private helpers:** none of `resolve_owner_read_grant`, `owner_read_*` or `owner_read_payload` gives EXECUTE to any client role or to `service_role`.
- **Unchanged since the baseline:** gate, CHECK, grant count, both counts and both fingerprints. The migration adds functions only, with no table, RLS or gate change.

**Effect and reversibility:**
- The RPC can't be reached until step 2, because only `service_role` can call it.
- The history row is permanent. Undoing it would take a forward migration that drops the functions. It would not be an edit to the migration file.

## 2. 🔑 Deploy the function with the flag absent
- **Type check:** `deno check --no-lock supabase/functions/delegated-owner-read/index.ts` must be clean.
- **Deploy:** with Docker running for local bundling, run `supabase functions deploy delegated-owner-read --project-ref yqjtawffpesplqyurlpj` **once**.
  - Always name the function explicitly; never a bare deploy.
  - Never pass `--no-verify-jwt`.

**Checks (read-only):**
- `list_edge_functions` shows `delegated-owner-read` ACTIVE at v1, with `verify_jwt: true`. Record the ezbr.
- `log-event` and `guest-contract-events` are unchanged from step 0.
- **Probes** (a scratchpad Playwright spec reusing `tests/e2e/liveEnv.js`; `.env.e2e` is never printed):
  - an OPTIONS preflight from `https://project-trustflow.vercel.app` gives 200, with that allow-origin, `x-trustflow-grant` in the allowed headers, and `Cache-Control: private, no-store`;
  - a POST with no Authorization header is rejected by the gateway with 401, so the request never reaches the function;
  - a POST with the anon key and a well-formed **fake** grant gives `503 delegated_read_unavailable`, so the flag is off.

### `verify_jwt`: recommend **true**
- **It matches `log-event`.** T241 proved on E2E that the anon key as the bearer plus `x-trustflow-grant` gets through the gateway with `verify_jwt` true. So the clients the route is meant for are not blocked.
- **True costs nothing.**
  - The route's authority is the grant alone. The bearer is transport only, and the code never reads a user identity from it.
  - True does not widen anyone's access. Any holder of the public anon key passes.
- **False only adds exposure.** Anyone on the internet could reach the function without even the project's public key, which means:
  - more invocations;
  - SHA-256 hashing and RPC load from junk headers;
  - more noise in the logs that the redaction check reads.

  It would also be the only function in the project configured differently. HANDOFF records every function as `verify_jwt: true`.
- **The repo has no `supabase/config.toml`.** A CLI deploy without `--no-verify-jwt` therefore gets the default, true. The post-deploy readback is what proves it. If it reads false, stop and report.

## 3. 🔑 Flag on, then the positive and negative checks
**Turn the flag on:** `supabase secrets set ENTRY_DELEGATED_READ=on --project-ref yqjtawffpesplqyurlpj`.
- Only this route reads the secret. `ENTRY_DELEGATED_APPEND` stays absent.
- Confirm the flip by probe, not by reading the value: a fake grant must now give `403 delegation_refused` instead of 503.
- If it is still 503 after a few minutes, stop and report. Don't redeploy.

**Fixture:**
- **Deal:** an existing E2E fixture deal owned by the E2E earner whose acceptance is a legacy guest acceptance, with `actor_id` `guest:<address>`. That is the case decision (a) covers.
  - Choose it read-only at run time. `0853c261-…` from T241 is a candidate if it qualifies.
  - If no deal qualifies, create one with the existing live spec's fixture path.
  - Don't print the address. The route withholds it.
- **Grant:** issue it the same way as T241, through the reviewed `public.issue_entry_agent_credential`:
  - `owner_account`, scopes `['read']`, expiring in 24 h;
  - the secret is generated locally into a mode-600 scratchpad file and never printed;
  - only the grant id and the `secret_hash` are recorded.

**Order of requests:**
1. **Positive.** POST `{contract_id}` with the real grant gives 200, with `status: ok`.
   - Save the body to the scratchpad. Never print it, because it holds deal content.
   - Check:
     - the response carries `Cache-Control: private, no-store`;
     - the body is at most 2 MiB;
     - every event has `stored_format`;
     - `receipt.source.api` is `delegated-owner-read`;
     - the acts carry no `idempotency_key`.
2. **Withheld input, exit 3.** Run `node scripts/verify-receipt.mjs <saved receipt>`. It should exit **3**, report `hash=unavailable` for the guest acceptance act, and print no FAIL line. That is decision (a), also proven by the local suite's cG case.
   - If the deal has no withheld act, the expected exit is 0 or 3 depending on the legacy acts. Record which.
   - Either way, the exit must never be 1.
3. **Refusals.** Each must give `403 delegation_refused` with the same body:
   - the right grant id with a wrong secret;
   - this grant used on another fixture deal (wrong deal);
   - a mixed credential: a grant header together with a user JWT as the bearer.
4. **Body validation.**
   - `{contract_id}` in uppercase, or with an extra key, gives `400 invalid_body`.
   - GET gives 405.
   - Both are answered before admission.
5. **Revoked grant.** Revoke the grant through `public.revoke_entry_agent_credential`; that sets `revoked_at` only and deletes nothing. The same request as 1 must now give `403 delegation_refused`. That is the revoke-then-read order over HTTP. The read-then-revoke race is proven locally by `delegated_owner_read_races.sh`.
6. **Log redaction,** as in T241. Send a canary-first request with a format-valid fake grant. Then search, through `query_logs`, `edge_logs`, `function_edge_logs`, `function_logs` and `postgres_logs` for:
   - the canary;
   - the real grant id;
   - an 8-hex prefix of the secret.

   The 200 and 403 request rows must be visible in those logs; that is the positive control.
   - **Stop rule:** any hit means flag off at once, the grant already revoked, a record, and Kenji.

**The 2 MiB cap:**
- **Refusal can't be reached on hosted E2E.** The schema's own limits cap the worst case at 1,769,275 bytes. That case fits, and the local suite measured it as case cW. The refusal (`500 response_too_large`, case cX) only happens past the DoD CHECK, so the local test is its proof.
- **Optional, with its own 🔑:** a near-cap positive on E2E. It means writing 501 owner events to a fresh fixture deal through `log-event` and expecting `truncated` with exit 3. **The cost:** 501 permanent events on E2E, because `events` is append-only. My recommendation is to skip it.

**v5 parts are still pending:**
- the v5 row read;
- guest v2 with a real `recorded_credential`;
- the download → offline recompute.

They need an E2E v5 row, so they wait for row 4's migration C and the gate opening. Record them as pending, as row 5 plan §3 allows.

**After the checks (read-only):**
- events and contracts counts and fingerprints are unchanged from step 1, except for any fixture the run had to create;
- the gate is closed and the CHECK present;
- the test grant is revoked;
- the scratchpad secret file is removed.

## 4. Flag state after the trial
**🔑** Kenji decides whether `ENTRY_DELEGATED_READ` stays on for row 8's bot E2E or goes back off. My recommendation is **off** by default until row 8, matching row 4 plan §6.

## Rollback
1. **Flag off** (a route-level kill switch, effective immediately): `supabase secrets unset ENTRY_DELEGATED_READ --project-ref yqjtawffpesplqyurlpj`. A probe must then show 503 with no fallback. It needs no OK, because it only reduces exposure.
2. **Revoke any live test grant** through `revoke_entry_agent_credential`.
3. **🔑 Function removal**, only if the code itself is wrong: `supabase functions delete delegated-owner-read --project-ref yqjtawffpesplqyurlpj`. Before that there is no earlier version to roll back to, because this is v1. Rolling back to a later version means redeploying a reviewed earlier commit.
4. **The migration stays.**
   - The RPC is reachable only by `service_role`, and it is inert without the function.
   - If it must go, a reviewed forward migration drops its functions, with its own 🔑 and a Codex review.
   - Never edit or roll back the applied file.
5. **What can't be undone:** the history row, any fixture deals created, the revoked grant rows (kept as evidence), and any events written in the optional cap test.

## OK summary

| Step | Needs OK |
|---|---|
| 0. Pre-checks | no (read-only) |
| 1. Apply migration to E2E | **yes** |
| 2. Deploy the function, flag absent | **yes** |
| 3. Flag on, issue and revoke a test grant, probes | **yes** (one OK covers the step) |
| 3. Optional 501-event near-cap test | **yes**, separately (recommended: skip) |
| 4. Flag left on or off | **yes** (Kenji decides) |
| Rollback: flag off, revoke | no |
| Rollback: function delete, or a forward migration to drop the RPC | **yes** |

Steps 1–3 can run as one supervised session with three separate OKs. They must not be merged into one command.
