# TrustFlow Roadmap

_The canonical roadmap. Rebuilt 2026-11-18 from `HANDOFF.md`, `docs/entry-contract.md`
and `.ada/codex-report-121.md`._

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
  Task 139 blockers. **Committed locally, not pushed.**

## Now: entry path (codex-report-121)

| # | Step | Status |
|---|---|---|
| 1 | One-deal contract: issuer/acceptance binding, scopes, revoke/replay rules | **Done** (local) |
| 2 | Credential store, issue and revoke for one deal; no direct client mutation | Uncommitted Codex Task 123 code, reworked per the design in schedule row 1 |
| 3 | Owner delegated reads and writes, with atomic liveness checks and an authority reference on each event | Not started |
| 4 | Counterpart account-to-invite binding and delegated acceptance (AI2AI) | Not started |
| 5 | One end-to-end deal, negative authority/revoke/replay cases, E2E release rehearsal | Not started |

**C5 decided:** build server-side creation and close direct client inserts; current client insert
is not the target. C2 binds credential ID and issuer kind in v5; C3 applies normalized email
matching to relevant RLS checks as well. No `issuer_assurance` column. See the dated baseline
in `docs/schedule.md` (**rev 3**, **execution authorized 2026-11-19**; whole design confirmed by Kenji. Row 0 (cross-review) **done 11-19** as planned (Codex T126 + Claude T147): **on schedule, 0 days late**. Next: row 1 (Codex builds the credential store, input = T126 must-fix list). The v5 preimage is still open for row 3; M1 2026-12-04, M2 12-07, M3 12-15, M4 12-16; +1 working day vs rev 2 because row 4 was under-sized); auth/record work gets independent cross-review and production release
needs Kenji's separate OK.

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

- The Vercel deploy of `eee0889` was still "pending" right after the push (Task 137).
  Nothing in HANDOFF confirms that it finished.
- `918d25c` has not been cross-reviewed since the fix. Task 139 reviewed `75a1c3f` only.
- Step 2's actual state is whatever Codex Task 123 reports. Nothing was read from the
  uncommitted files for this roadmap.
