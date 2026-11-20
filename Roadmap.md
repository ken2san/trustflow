# TrustFlow Roadmap

_The canonical roadmap. Rebuilt 2026-11-18; maintained by 棟梁 (Kenji, 2026-11-20).
Last updated **2026-11-20 13:05 ET**, against `docs/schedule.md` rev 3 and HANDOFF through Task 159 / Codex 143._

`HANDOFF.md` holds the current state and `Decisions.md` holds the reasons. If this file
disagrees with either of them, this file is wrong. The longer product-strategy text that
used to live here (target users, BYOC, the unbuilt feature vision, the risk register) is in
git history: `git show eee0889:Roadmap.md`.

## Mission

Make trust the default, not the exception. The record of what two parties agreed belongs to
them, not to the platform. TrustFlow witnesses the record; it does not own it.

## Current spine (Kenji, 2026-11-18)

**Get TrustFlow usable by real users by the shortest path.** The entry path comes first:
onboarding (sign-up, issuing a key, the first deal) and scoped, revocable agent credentials.
Wording and interpretation polish waits until that flow works.
The first deal runs through bot simulations, with bots acting as the parties. Design and the
entry path never wait for real deals or real users (`Decisions.md` 2026-11-18).

## Done (built and verified, per HANDOFF)

- **Evidence core, on E2E and production:** create, invite, atomic acceptance,
  server-written hash-chained events, the agreement snapshot bound at acceptance, owner
  export and guest export.
- **Guest append under the credential lock:** live on both projects (Tasks 73/79). After
  a reissue commits, the old guest token cannot create an event.
- **Hardening:** clients lose TRUNCATE, and client default privileges are closed. Both
  migrations are applied to E2E and production (Tasks 107/109, 121/123).
- **Record wording states the hash format, not the writer** (rank-1 provenance, commit 1:
  frontend, both exports, public docs). Live `guest-evidence` passed 13/13 on E2E at
  `eee0889` (Task 136) and was pushed to origin/main (Task 137).
- **Entry contract** `docs/entry-contract.md`: `75a1c3f`, plus the `918d25c` fix for both
  Task 139 blockers. Pushed with `122bac2` (Task 153).
- **Schedule row 0, design cross-review:** done 2026-11-19 (Codex T126 + Claude T147).
- **Schedule row 1, one-deal credential store (issuance off):** built 2026-11-19 (`6942691`),
  verified 2026-11-20 (Codex T129 review, Claude T152 races 6/6), pushed `122bac2`.
  No migration or edge function applied to E2E/production; issuance stays off.

## Now: where we are against the schedule (rev 3)

**Row 2 (C5 server-side create), planned 2026-11-23..24: started 2026-11-20, about 3 working days
ahead of the planned start.** Revised estimate 3–4 working days (Codex T131), so the finish may spill
1–2 days past 11-24; Kenji accepted that (2026-11-20). M1 2026-12-04 unchanged.

| Row 2 step | Status |
|---|---|
| Stage A: migration `20261120090000` adds RPC `create_entry_contract` (additive; direct INSERT still open), client and all writers switched, E2E specs converted | Built locally (T134–T137), **uncommitted** |
| Stage A local tests: SQL suite, 2-session races, legacy-vs-RPC hash parity, row 1 races | PASS (Claude T154/T155); harness hardened after Codex T138/T139 blocks (T156/T157) |
| Codex final re-review, then one local commit (no push) | **Done 12:29 ET: stage A committed locally 6371d87** (make check 779/779 twice; tests made load-safe in Codex T142). Not pushed, migration A not applied. Before-B fixes built by Codex T143 (12:36 ET: apply-time SELECT assertion in migration A, currency B-pending cases require 403/42501). Claude T159 (13:05 ET) Docker-verifying + local commit |
| Before-B fixes: `currency.spec` B-pending asserts; explicit projection instead of `to_jsonb(c)` | Open |
| E2E rehearsal incl. the 5 converted scripts (Kenji chose to run them there) | Needs Kenji's OK |
| Migration B: close direct client INSERT (no rollback after it, only forward fix) | Needs Kenji's OK |

**Deploy order:** apply and verify migration A on the target **before** pushing any frontend
with the RPC client; a push auto-deploys the production frontend.

Next rows: 3 (v5 canonical, opens with an independent review of the v5 preimage) 11-25,
4 (owner delegated append + resolver) 11-26..27, then 5–8 to M1 on 12-04.

**C5 decided:** build server-side creation and close direct client inserts. C2 binds credential ID
and issuer kind in v5; C3 applies normalized email matching to relevant RLS checks as well.
No `issuer_assurance` column. Auth/record work gets independent cross-review; production
release needs Kenji's separate OK.

**Decided 2026-11-19 (Task 145):** (b) grant evidence is kept, and a draft with any grant cannot be
deleted; (c) v5 preimage has a fixed key order, `hash_version` and a domain separator; (a) the creation
snapshot is deferred, because the acceptance snapshot already fixes the terms.

## Parked (not on the current path)

- **Payment / Stripe Connect.** TrustFlow records the money promise and what each party
  says happened. It does not move or hold money (`Decisions.md` 2026-11-06). Stripe Connect
  stays "decided, not built", and nothing puts it back in the queue.
- **Reputation and escrow layer**: points, staking, tiers, blind rating, wallet, Trust
  Passport. These were removed, not deferred (`Decisions.md` 2026-11-05).
- **Rank-1 provenance commits 2–3** (guest function response version 2, then the flip).
  Planned, not built.
- **Wording and interpretation polish**, per the spine.

## Later (only what HANDOFF or Decisions.md already list)

- Items the entry contract excludes: cross-contract or account-wide agent keys,
  agent-created deals, a creation event, identity verification beyond account/invite,
  external timestamps or checkpoints, scores, and payment execution.
- Per-event provenance marker `server_asserted_v1`, then Ed25519 signatures by a signer
  outside the database (`Decisions.md` 2026-11-16).
- From HANDOFF's older priority list: an acting counterparty without a second human; the
  first non-JPY acceptance in production; cancellation and withdraw-before-acceptance
  (unspecified); `App.jsx` decomposition; an MCP server over the published protocol; the
  remaining blind-review findings.
- Open decisions in HANDOFF: production test data, whether
  creation should be an event, the empty payment schema (recommendation: leave it).

## Unverified

- The push of `122bac2` (Task 153) triggers a production frontend redeploy; nothing in
  HANDOFF confirms it finished.
- `918d25c` has not been cross-reviewed since the fix. Task 139 reviewed `75a1c3f` only.
- Row 2 stage A HTTP/REST behavior and the 5 scripts are untested until the E2E rehearsal.
