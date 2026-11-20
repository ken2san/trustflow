# Row 2 — C5 server-side create trunk plan

## View

Use an authenticated PostgREST SECURITY DEFINER RPC and an additive A, client migration, then B cutover. Preserve the existing create flow and accepted record bytes; verify every bypass and supported writer before closing direct INSERT.
The two-day baseline is at risk: estimate 3–4 working days including fixture conversion and local proof, plus separately authorized rehearsal. Record any spill; never weaken gates to meet 11-24.

## Contract and authority

`public.create_entry_contract` takes the existing eight terms only, derives `auth.uid()` as owner, locks that `auth.users` row FOR SHARE, checks non-anonymous and `email_confirmed_at`, validates, and inserts atomically under READ COMMITTED. No caller-supplied ID, owner, state, token or timestamps. Generate UUID, state AWAITING_ACCEPTANCE, invite and 72-hour expiry server-side; existing trigger fills amount mirror. Explicitly grant authenticated EXECUTE only; empty search_path. Verify this function owner's UPDATE privilege on auth.users, not just row 1's owner. Test JWT identity, missing/anonymous/unconfirmed accounts, spoofed or extra fields and privilege denial. Service-role and DB owners remain trusted.

Return `{status:'created', contract:<row>}` where `contract` is the same owner-visible column set as today's `.insert(...).select().single()` including `id`, `invite_token`, `invite_token_expires_at`, owner, state and terms. Define the explicit column list from the actual SELECT grants at implementation, avoid inadvertently exposing privileged columns, and test equality with the legacy owner-visible shape. `createContract` returns `{contract, error}` as today; `App.jsx` uses `contract.invite_token` to build the link. A named refusal maps to a non-null Error and no contract; database/transport errors also propagate to the existing error UI. Test real browser success, invite acceptance and failure. Never automatically retry a timed-out create: look up the owner's recent drafts, inspect terms and invite, then resume or delete only after checking evidence; ambiguous duplicates may exist.

No creation event or snapshot is added (decision (a)). Acceptance freezes the existing snapshot and agreement hash. C2 requires credential ID and issuer kind inside v5 for delegated events; create emits none. Row 3 settles exact v5 representation. Compare snapshot serialization and hash for equivalent legacy and RPC creates, preserving input terms without silent rewriting.

## Validation parity and deliberate changes

| Input | Current DB/client behavior | RPC plan |
|---|---|---|
| project_name | DB nonblank, length ≤500, existing NOT NULL | same; test null, whitespace and boundaries |
| dod | DB 1–50 strings, nonblank, serialized JSON ≤20000; creation trigger each ≤1000 | same, preserve JSON; test types, nested/null, whitespace and lengths |
| amount_minor/currency | positive integer and six supported currencies; mirror trigger/constraints | same; test omitted/null, range, noninteger, JPY and non-JPY mirror |
| deadline | nullable date, creation trigger ≥ current_date - 1 | same; test boundary and UTC date |
| invited_hirer_email | DB shape check permits null; UI supplies trimmed value | **intentional tightening:** required and existing shape; no server trimming. Test null, empty, whitespace and valid inputs |
| performed_by | existing allowed values/default; client normalizes to creator or counterparty | validate allowed values, preserve client default; verify actual DB default and null behavior before implementation |
| earner_display_name | nullable, length ≤200 | same; test null and boundary |
| owner/verification | existing JWT policy; client supplies owner | **intentional tightening:** locked live confirmed non-anonymous account, owner server-derived |
| ID, invite, timestamps, state | defaults/grants and existing client behavior | server-derived; test exact state and expiry semantics |

The authoritative current predicates are the latest migrations, not superseded historical checks: verify exact null/default, JSON serialization length and currency constraints in the current catalog before coding. For valid typed parameters, return `invalid_terms` plus field for explicit validation; typed parameter coercion or missing/extra RPC arguments can fail at PostgREST before the function and produce a non-2xx database/API error, not necessarily `invalid_terms`. Client must display a safe error, create no row and never assume a field code. Unexpected constraints/errors propagate rather than being masked. Tests must distinguish these cases.

## Writer inventory and conversion

Search repository again before B, including dynamic paths. Convert valid creation to RPC, adapting return shape; retain direct POST only as explicit denial tests after B:

- `src/lib/contracts.js` and `src/App.jsx`: RPC and working invite/error flow; update mocks and unit/browser tests.
- E2E: `cancellation-refusal`, `currency`, `event-ingestion`, `earner-signin`, `agreement-binding`, `invite-persistence`, `guest-evidence`, `guest-credential`, `mixed-surface`, `atomic-acceptance`, `evidence-core` specs. Convert legitimate creation; preserve explicit direct POST denial and move currency validation cases to RPC with equivalent assertions. Update route mocks where relevant.
- `scripts/api-e2e.mjs` (all three creates), `scripts/agents/owner-agent.mjs` (and its two-agent simulation), `scripts/sim-counterparty.mjs`, `scripts/race-delete-vs-append.mjs`, `scripts/offer-for-tester.mjs`: convert supported session creation and test callers; retain intentional bypass attempts as negatives.
- `tests/sql/entry_agent_credentials.sql`, `tests/sql/entry_agent_credentials_races.sh`, `scripts/race-guest-reissue-vs-append.sh`, `scripts/check-sql-draft.mjs`, `scripts/two-session-gate.mjs`, and migration SQL fixtures: privileged SQL setup is not a client bypass; retain where needed, distinguish from real client tests and check fixture prerequisites. Historical migrations remain immutable.
- `public/llms.txt` and `docs/api/openapi.draft.yaml` describe direct create: update current client instructions at cutover; do not direct delegated credentials to create. Search other documentation and scripts for equivalent or dynamically constructed writes. Reads, PATCH denial probes and UI route mocks are not creates; review them for changed RPC behavior.

## A then B: mandatory checklist

- [ ] A creates RPC, explicit grants and apply-time privilege/owner/search_path assertions; prove on disposable representative catalog and separately authorized rehearsal, including valid/invalid inputs, identity, atomic errors, returned shape, invite acceptance and snapshot/hash parity.
- [ ] Move browser client, supported scripts and fixtures before B; test new client before and after B, cached old client refused without partial rows, bot workflows and dev-browser create/error/invite flow. Run build and relevant suite.
- [ ] Test both account-update/create interleavings and concurrent issuance/delete with actual trigger dependencies; verify no deadlock and correct committed account state.
- [ ] B revokes table and every column INSERT from PUBLIC/anon/authenticated including inherited effective grants, drops permissive client INSERT policy, and asserts these on the target catalog. Test injected faults and transaction rollback.
- [ ] Inventory reachable SECURITY DEFINER functions, owner-rights views, rules and dependencies; account for dynamic, parsed SQL and opaque bodies, refusing unreviewed paths. Test direct REST and exposed RPC bypasses. Assert pg_graphql absence on that target, or if present test its mutation/privileges. Literal name scans alone are insufficient.
- [ ] Record forward repair and lost-response recovery. After B, old UI cannot create; restoring direct INSERT violates C5. No hosted apply is authorized by this plan alone. Production release retains its separate approval.

## Later

Wording polish, idempotency feature, rate limiting, provenance marker, unused hash cleanup and account schema changes. Row 4 must enforce that delegated credentials cannot create. Payment is parked; bot simulation, not real users, is the first-deal gate.

## Older-document contradictions

The fixed four Edge Functions count in HANDOFF is stale as a design limit; local row 1 source is not proof of deployment. Entry contract's temporary direct inserts are compatible with C5 only during A–B. PostgREST RPC is a server-side endpoint; the wording is not a demonstrated contradiction. The old policy comment becomes stale at B. Prior reports of pg_graphql absence are dated, not target proof. Historic design's held/uncommitted row 1 wording conflicts with local commits; preserve the distinction from deployed status.
