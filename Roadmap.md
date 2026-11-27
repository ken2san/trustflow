# TrustFlow Roadmap

_The canonical roadmap. Rebuilt 2026-11-18; maintained by 棟梁 (Kenji, 2026-11-20).
Last updated **2026-11-27**, against `docs/schedule.md` rev 3 and HANDOFF through **M1 achieved (`2026-11-27`, 7 calendar days ahead of `2026-12-04` baseline; pinned local candidate `37684db`; not pushed; Row 9 / M2 production NOT done)**._

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

**Row 3 (v5 canonical + readers), planned 2026-11-25: started 2026-11-22, production-complete 2026-11-23, about 2 working days early.**
v5 canonical module + KAT/tamper tests, strict core v5 reader, shared verify, guest reader/wire, owner/export/CLI, and guest response v2
(behind `?response_version=2`) are built and reviewed. Storage migration `20261122130000` (v5 authority columns) applied to hosted E2E 11-22
and to **production 11-23 16:03 ET** (T224, after the gated check set T217–T223, Codex T182–T186, E2E read-only validation PASS).
Production `guest-contract-events` **v14 from `1011b99`** deployed 11-23 16:06 ET (T225, Kenji OK; same bytes as E2E v13, OPTIONS 200).
**v5 writes stay gated off**; writers come with later rows. Deferred nonblocking hardening: Codex T186 (RNG exit check in the check-set E2E wrapper).

**Now: row 4 (owner delegated append + resolver), planned 2026-11-26..27, started 2026-11-24 (~2d early): 4a and 4b built, Codex-reviewed, and pushed 11-24 (T237); writer migration `20261124130000` on E2E (T238); log-event v16 and guest-contract-events v14 on E2E with the flag off (T239, `d16e1c8`); TF011 proven on E2E by a rolled-back insert (T240, `acb6b46`). real-grant admission + header-log redaction proof PASS with the flag off (T241, `2ed64cd`; agy fix `648653c` Codex YES, pushed). log-event v21 on E2E with publishable-key probes PASS 11-25 (T261: allowed call clears auth, stops at closed gate; refusals, revoke, flag back off, data unchanged). Row 4 local SQL suites + hosted E2E live owner/guest suite PASS 11-25 (T262). Local race suite PASS 11-25 (T263, 30; all three row 4 local suites green). Migration C written + proven locally 11-25 (T264 `d337e61`); pre-C suites still green (T265); Codex T210 NO: 2 must-fixes (lock before trigger-catalog check + trigger binding; column grants in ACL checks), fixed T266-T268 (`c00996d`, Codex T212 PASS); C applied to hosted E2E 11-26 (T269, gate closed, flag off, data unchanged). Next for row 4: gate open (Kenji OK).**

**Row 5 (delegated owner read), planned 2026-11-30: started 2026-11-24 (~4 working days early)**, plan `docs/plans/row5-owner-read.md`; 5a (owner read SQL) signed off 11-24 after 4 Codex review rounds (T198–T201; redos recorded in HANDOFF); 5a pushed in T246; 5b (Edge route, default off) built T246, fixed T247–T249 after Codex T202–T204 NO (verifier option (a) exit 3 for withheld input, 2 MiB response cap, calendar checks), Codex T205 YES 11-25; pushed 11-25 (T251, Kenji OK; 584021a..ad5694e, Vercel prod READY; route not deployed, flag off). 5b E2E runbook step 1 done 11-25 (T255: migration 20261124231214 applied to hosted E2E, checks PASS). Steps 2-4 PASS on hosted E2E 11-25 (T260; T256 admission block fixed by publishable-key apikey transport T258/T259, Codex T208/T209): verify_jwt true, flag-on read 200, revoke 403, flag back off, data unchanged; pushed 11-25 (T261). 5b hosted E2E trial done.

**Rows 6–8 & M1 achieved 2026-11-27 (7 calendar days ahead of rev 3 `2026-12-04` baseline; local candidate `37684db`, unpushed; Row 9 / M2 production NOT done):**
- **Row 6 (owner credential UI, default-off):** `f7edc32` → `2c8f057` → `3ce23d7` (Claude GO); offline Playwright browser regression harness (`f17be05` → `e736886`, Claude GO, 6/6 PASS offline).
- **Row 7 (delegated bot bootstrap + grant-only agent + fail-closed recovery):** `a19977e` → `4f62aea` → `001e149` → `ec4e10d` → `33f752e` (Claude GO).
- **Row 8 & M1 (Phase 1 AI2Human E2E with bots — DONE 2026-11-27, Claude M1 GO `.ada/claude-review-row8-m1.md`):**
  - Executed W0, B1 (`guest-contract-events` v27), W1 (`row8-w1-20261127`), W2/W2b (local E2E owner UI + direct-INSERT `401/42501` probe `37684db`), and W3 (post-expiry `403 delegation_refused` on read + append for fresh & G1 keys, `503` contrast, product-route revoke) on E2E `yqjtawffpesplqyurlpj` within exact **`1/2/2`** budget; full cleanup verified (`grants_live: 0`, gate closed, `0` `ENTRY_*` secrets, local secret dir removed).
  - **Explicitly unproven live (bounded):** live guest export download (rests on W1 live guest v2 + offline tests), live browser OTP/CAPTCHA sign-in & session rotation (W2 used injected QA-earner fixture auth; offline harness covers UI auth boundary), same-grant post-expiry replay & live races (SQL-proven `ee70e95`), second owner / counterpart / mixed-release live runs. Owner export of a v5 deal reports `INDETERMINATE_INCOMPLETE_EVIDENCE` by design (`auditExport.js:233-235`).
- **Next (Row 9 / M2 NOT started):** decision plate in `.ada/row9-next-decision-plate.md` (push + Vercel prod A7 check, minimum prod rollout sequence, owner export verdict decision, release-blocking vs acceptable live gaps). Phase 2 Row 10 prep plan: `.ada/row10-counterpart-entry-plan.md`.

_Row 2 history below._

**Row 2 (C5 server-side create), planned 2026-11-23..24: started 2026-11-20, released to production 2026-11-22 (T173), about 1 working day early
(Monday–Friday calendar). Closed 2026-11-22:** cancel fixture closed as covered by `cancellation-refusal` 4/4 (T175; Kenji 11:39 ET); prod refusal probes added and both refused 401/42501 (T176 `d747cff`, smoke:prod 18/18); Codex T157 must-fix on the probe classifier (2xx hard stop, 400 vs 23514, scoped no-write claim) fixed by Claude T177 `5b1a2a5` (pushed, Vercel READY; create probes now gated on pinned target + `--backstops-verified`; prod catalog readback 8/9 + ws-stripped md5 match, then smoke:prod --backstops-verified 18/18, both create probes db_refused (T179/T180 `63e72b7`, local)). Claude T178 = row 3 step 1 (freeze v5 contract + KAT/tamper tests, local). **Next: row 3 (v5 canonical), preimage confirmed by Kenji 2026-11-22 11:39 ET (Codex T156 `d53fc5e`).** Revised estimate 3–4 working days (Codex T131), so the finish may spill
1–2 days past 11-24; Kenji accepted that (2026-11-20). M1 2026-12-04 unchanged.

| Row 2 step | Status |
|---|---|
| Stage A: migration `20261120090000` adds RPC `create_entry_contract` (additive; direct INSERT still open), client and all writers switched, E2E specs converted | **Committed locally 6371d87** (11-20); with row 1, applied to **E2E only** 11-20 (Claude T163). Not pushed. **Production: row 1 (T167, `61024dd`), A (T170, `c6c88d4`) and B (T171, `11d2075`) applied + verified 11-22; pushed and live on Vercel production 11-22 (T173)** |
| Stage A local tests: SQL suite, 2-session races, legacy-vs-RPC hash parity, row 1 races | PASS (Claude T154/T155); harness hardened after Codex T138/T139 blocks (T156/T157) |
| Codex final re-review, then local commit (no push) | **Done.** 6371d87 (12:29 ET, make check 779 x2, tests load-safe via Codex T142) |
| Before-B fixes: `currency.spec` B-pending asserts; apply-time SELECT assertion on returned columns (chosen instead of explicit projection, output/hash unchanged) | **Committed locally d2e4b9f** (Codex T143, Claude T159–T161: SQL, races 9/9, harness, make check 779, lint 0). Codex T144 review: no code blocker. A/B split done (Codex T146, 5a7f2be). Grants/RLS and catalog rechecked on E2E at A apply (Claude T163) |
| E2E rehearsal incl. the 5 converted scripts (Kenji chose to run them there) | **PASS on E2E 11-20** (T163): currency spec pre-B 9/9, all 5 scripts PASS |
| Migration B: close direct client INSERT (no rollback after it, only forward fix) | **Built locally 5609c46**; T150 committed `cbd02d3` (removed in-file `begin;`/`commit;`, T107). Not applied anywhere yet. T148 blockers fixed in T149 (`29c1fce`). **T164 PASS** (`9de7425`): Docker B rehearsal incl. rollback, E2E A-stage invite-persistence 9/9. **T165 done 11-21 (`bee5c8d`): B applied to E2E**, catalog diff exactly 3 lines, rows/hashes unchanged, currency 15/15 + invite 9/9 incl. `@post-b`, 5 scripts PASS, make check 779. Not pushed. Browser owner-create spec PASS (T166 `e7df5de`, T169 `4f426c1`). **Production B applied + verified 11-22 (T171 `11d2075`); pushed, Vercel production READY, read-only smoke all PASS (T173).** Remaining: none (refusal probes T176/T180 18/18, cancel fixture closed T175, runbook §4 fixed T174) |

**Deploy order:** apply and verify migration A on the target **before** pushing any frontend
with the RPC client; a push auto-deploys the production frontend.

Next rows: 4 (owner delegated append + resolver) 11-26..27, then 5–8 to M1 on 12-04 (row 3 done 11-23, see above).

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
