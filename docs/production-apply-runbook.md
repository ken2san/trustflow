# Production cutover for server-side agreement creation

Apply and verify row 1, then A, then B, then push the reviewed frontend commit. Each action has its own approval. This document is a procedure for the release worker.

A adds the RPC while the current frontend can still insert. B closes direct INSERT, so the old frontend cannot create between B and the new deployment becoming live. Cached old bundles will still fail to create until refreshed. Before B, agree on that interruption and stage the frontend release and recovery path. If the interruption is unacceptable, stop and bring the order back to Kenji. A frontend release between A and B could shorten the interruption but would keep direct creation open and would require a different approved plan.

## Release preflight

- Require Claude T166's successful real-browser E2E evidence for the reviewed frontend, together with T163–T165 and T164's disposable fault test. Confirm that the fixture and other outstanding checks are explicitly accounted for in the release decision. The first deal is bot-simulated and payment remains parked.
- Pin the reviewed frontend commit and verify that its three migration files match the rehearsed files. Verify production project `fqgpzhwvvfsxswlnbbgg` against the authoritative project record and target below before opening credentials. E2E is `yqjtawffpesplqyurlpj`; neither the ambient CLI link nor Vercel preview settings select production. Use the rehearsed Supabase CLI 2.105.0. Verify the production frontend project, branch, current live deployment and expected automatic deployment on push.
- Record a fresh read-only baseline. Expect production migration history through `20261118010000` and none of the three target versions. Compare history, grants including column and inherited grants, RLS and policies, relevant definer ownership and privilege, views/rules/extensions, and trusted writers with the rehearsed state. Confirm production email confirmation remains required and delegated issuance remains off. Stop on drift, uncertain project identity or a failed precondition.
- Measure record preservation at each stage. During an agreed quiet measurement interval, compare exact counts and stable ID-ordered digests for `contracts` and `events`, including stored agreement and event hashes. Row 1 adds a nullable column, so compare the original column projection and check that the new field is null on existing rows separately. If concurrent writes prevent equal full snapshots, compare the same baseline IDs and reconcile every intervening change before proceeding. Retain counts, digests and redacted catalog evidence, without row payloads, JWTs, invite tokens or credentials. Fresh read-only catalog observations never substitute for the E2E write tests.

## Common apply procedure

For each approved stage, use its own detached scratch worktree and shell. T162 stopped on an unexpected pending set. T163 used a pre-B worktree so the runner could apply row 1 and A without picking up B. Here the worktrees isolate one stage per approval:

| Stage | Worktree pin | Expected history tip before | Exactly one pending filename |
|---|---|---|---|
| Row 1 | `6942691` | `20261118010000` | `20261118214020_entry_agent_credentials.sql` |
| A | `5a7f2be` | `20261118214020` | `20261120090000_create_entry_contract.sql` |
| B | `cbd02d3` | `20261120090000` | `20261120180000_close_contract_client_insert.sql` |

From the release checkout, substitute the matching pin and a fresh private scratch path. After the stage's approval, use one `op read` for the production DB credential and pass it only through `PGPASSWORD` in that shell. Disable shell tracing before the lookup. The 1Password reference below is a placeholder. Never embed the password in the URL, print it or save it to a file.

```bash
git worktree add --detach '<fresh-private-scratch-path>' '<stage-pin>' || exit 1
cd '<fresh-private-scratch-path>' || exit 1
set +x
PROD_DB_URL='postgresql://postgres@db.fqgpzhwvvfsxswlnbbgg.supabase.co:5432/postgres?sslmode=require'
PGPASSWORD="$(op read '<production-DB-password-reference>')" || exit 1
test -n "$PGPASSWORD" || exit 1
export PGPASSWORD
PGOPTIONS='-c default_transaction_read_only=on' psql -X --dbname "$PROD_DB_URL" \
  -v ON_ERROR_STOP=1 -Atc 'select version from supabase_migrations.schema_migrations order by version' || exit 1
```

Compare the full history and read-only baseline for the stage. Stop on an unexpected version or any unexplained catalog difference. In the same shell and worktree:

```bash
supabase db push --dry-run --db-url "$PROD_DB_URL"
```

Stop unless the dry run exits 0 and lists exactly the pending filename in the table. Reuse the same shell, worktree and production URL. Keep the apply command separate from the dry run so the worker can inspect its output first. Once the gate passes:

```bash
supabase db push --db-url "$PROD_DB_URL" --yes
```

If the apply exits nonzero or its response is ambiguous, stop. Read history and catalog before deciding what happened. Do not retry, repair history manually or use flags that widen the pending set. The CLI batches the migration and history entry together. The corrected B has no in-file COMMIT. After verification, unset `PGPASSWORD` and close the stage shell. Record the applied version, catalog diff and verification evidence before seeking the next approval.

## 1. Row 1 — credential store and account binding

**STOP — needs Kenji's OK.**

Use the row 1 pin and expected state above. Confirm T163's row 1 evidence and issuer email confirmation. Use the common dry run and apply commands. The only new history version should be `20261118214020`.

Verify the new nullable counterpart field and distinct-account constraint, immutable credential evidence and expected delete guard. The credential table must start empty, with RLS on and no effective client table or column privilege. The three credential RPCs are service-role-only, SECURITY DEFINER with an empty search path. Check their owner privileges and no unexpected client path, and confirm the credential edge function and issuance gate have not been enabled. Verify the original contract/event projection, counts and digests.

Run the existing read-only credential inventory from this worktree using the same credential:

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql -X --dbname "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f tests/sql/entry_agent_credentials_inventory.sql
```

Review its notices and opaque functions. The inventory is a source-based aid. Compare catalog dependencies and callable paths independently. Local credential races and T163's read-only E2E evidence remain the functional reference.

Stop on any missing grant, unexpected grant, failed invariant or data drift. If apply failed, verify rollback from the catalog and history. If committed, leave the evidence schema and issuance off while preparing a separately approved forward fix. Dropping tables, fields or evidence is outside this runbook.

## 2. A — additive owner create RPC

**STOP — needs Kenji's OK.**

Require signed-off row 1 verification and no B history. Use the A pin and common dry run and apply commands. The only new history version should be `20261120090000`.

Verify the exact eight-argument `create_entry_contract` signature, SECURITY DEFINER and empty search path, postgres ownership and effective EXECUTE for authenticated only among client roles. Verify the owner can lock the relevant `auth.users` row, authenticated retains SELECT on every returned `contracts` column, and party SELECT RLS remains as rehearsed. Check the four contract policies and that effective direct INSERT grants match the pre-A snapshot. Recompare existing rows and hashes.

Functional reference on E2E is T163's A-stage currency suite (9/9), T164's A-stage invite-persistence suite (9/9), and T163's five scripts below. Do not run a create on production as a smoke test.

Stop if the RPC, legacy compatibility, response visibility or record comparison differs. After a committed A, keep the old frontend on its current route until B and the push are ready. Fix A forward under separate approval if needed. No B or push while A is unverified.

## 3. B — close direct client INSERT

**STOP — needs Kenji's OK.**

Require A verification, the post-B E2E evidence, an agreed interruption window, and a prepared RPC-compatible frontend and recovery path. Use the B pin and common dry run and apply commands. The only new history version should be `20261120180000`.

Compare with T165. Expect the new history row, removal of the ten authenticated column INSERT grants and removal of `creator_insert_contract`. No effective table or live-column INSERT may remain for PUBLIC, anon or authenticated, including inherited privileges. Trusted writers retain their grants. Verify the three remaining policies, RLS, RPC executability and per-column return visibility. Inventory reachable definer functions, writable owner-rights views, rules and dependencies. Confirm pg_graphql is absent as rehearsed or stop for review if present. Recompare existing contracts and events, counts and hashes. Re-run the read-only credential inventory from step 1.

Reference T165's E2E currency 15/15 and invite-persistence 9/9 with `--grep-invert '@pre-b'`, plus T166 for live browser create, error and invitation behavior. T163 and T165 rehearsed these five workflows on E2E: `scripts/api-e2e.mjs`, `scripts/race-delete-vs-append.mjs`, `scripts/sim-counterparty.mjs`, `scripts/agents/owner-agent.mjs` via `npm run sim:two-agents`, and `scripts/offer-for-tester.mjs`. Keep them on E2E. Production catalog checks do not prove the HTTP 403/42501, successful RPC write or browser acceptance end to end.

Stop on unexpected catalog changes, failed verification, or any uncertainty about the deploy candidate. After B commits, fix forward. Restoring INSERT or the creator policy reopens the C5 boundary. An old bundle is incompatible with B even if Vercel can serve it.

## 4. Push and read-only production smoke

**STOP — needs Kenji's OK.**

Require all three production versions and signed-off verification, recorded in order. Verify the reviewed SHA is a normal fast-forward of current `origin/main`, the release diff has only reviewed changes and the Vercel integration points at the intended production project. From the release checkout, with `RELEASE_SHA` set to that inspected commit, run:

```bash
git push origin "${RELEASE_SHA}:refs/heads/main"
```

Keep the braces: in zsh, `$RELEASE_SHA:r…` applies the `:r` history modifier and mangles the refspec (T172).

Wait for Vercel to show Ready for that SHA and confirm the production alias resolves to it. Read-only smoke: GET the production page and served assets, confirm the exact production Supabase ref and RPC create route in the bundle, and GET `/llms.txt` and `/agent-protocol.md` to confirm the RPC instructions and digest vectors. Check deployed function inventory and auth/CAPTCHA settings by readback. The existing `npm run smoke:prod` is the T123 supplemental probe if approved for the release worker. It loads production configuration through its existing loader and sends only its documented refusal/status probes, with no real signup or invitation. Since T176 it can send two contract-create refusal probes: an anonymous direct `POST /rest/v1/contracts` and an anonymous `rpc/create_entry_contract`, each with `currency: 'XXX'`. These are write-capable POSTs. They are expected to write nothing only on the confirmed production target and only while the backstops hold: `contracts_currency_check` rejects `XXX`, neither BEFORE INSERT trigger on `contracts` rewrites `currency` or writes elsewhere, and `create_entry_contract` is not executable by anon and refuses a null `auth.uid()` and an unlisted currency before its INSERT. Confirm those for this release with a read-only catalog readback (needs Kenji's OK, since it is SQL on production), then run `npm run smoke:prod -- --backstops-verified`. Without the flag, or on any other target, the script sends no probe (T177). Outcomes: 42501 = database refusal (pass). 401/403 without 42501 = refused at the HTTP boundary only, database ACL not shown (pass, reported separately). 23514 = privileges did not refuse; a CHECK rejected the row (fail). Any other 400 or status = inconclusive (fail). Any 2xx = exit 2 before another request. For an unconditional no-write check, use the catalog readback; keep write-capable HTTP rehearsal on E2E. Do not submit the create form, accept invites, request a real OTP, or run live-writing specs. Read-only smoke cannot establish production end-to-end write behavior.

Stop on the wrong SHA or target, a failed deploy, a failed smoke or an ambiguous push. Read remote and deployment state before any further action. Vercel recovery needs separate approval. In the production project's Deployments view, identify the exact known-good deployment by its SHA. Use Promote to Production only if that deployment already uses the create RPC and is compatible with B. Verify the alias and rerun the read-only smoke after promotion. The pre-cutover direct-INSERT deployment cannot restore creation with B active. If no compatible rollback candidate exists, fix the frontend forward or keep creation unavailable until a compatible build is ready. Do not force-push, rewrite history, or undo B to make an old frontend work.

Sources: T162 (pending-set stop), T163 (row 1/A E2E isolation and checks), T164 (disposable B and rollback), T165 (final B E2E), T123 (production CLI and smoke precedent), `Decisions.md`, `docs/entry-contract.md` and `HANDOFF.md`.
