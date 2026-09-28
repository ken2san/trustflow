# TrustFlow — AI Session Handoff

_Last updated: 2026-09-27 (payment evidence shipped; Custom SMTP live; a run of
real-usage bugs found and fixed; Protocol.md/Roadmap.md brought current)_

> Brief a new session with this file. It describes where the project **is**, not
> what each past session did. `Decisions.md` is the source of truth for
> architectural decisions; if this file contradicts it, `Decisions.md` wins.

---

## What TrustFlow is

An AI-native escrow and contract prototype. React 18 + Vite + TailwindCSS on
Vercel; Supabase (PostgreSQL + Edge Functions) behind it; Stripe Connect as the
payment rail, not currently wired to the live flow.

Target user is the operator themselves, receiving work from clients who may not
want to register. **The priority is a court-admissible evidence trail over feature
breadth**, and that ordering has decided most of what follows. `Protocol.md` now
describes exactly what the evidence protocol does and does not claim; read it
before touching anything in the evidence model.

## Where the product stands

**Evidence core.** The UI is wired to the DB-backed flow.

- A signed-in Earner creates an agreement, invites a counterparty by link, and both
  sides work from `AgreementView`. `ContractsHomeView` is the home screen.
- Accepting an invitation consumes the invite, records the claimed identity, issues
  the guest credential, moves the contract to `TERMS_ACCEPTED` and writes the
  acceptance evidence — **one database transaction, all or nothing**
  (`accept_invitation()`).
- Events are hash-chained and server-attested. Canonical v4 binds an agreement
  snapshot, so an acceptance proves the whole deal — price, deadline, which side
  performs — not only the completion criteria.
- Reachable states: `DRAFTING → AWAITING_ACCEPTANCE → TERMS_ACCEPTED →
  AWAITING_CONFIRMATION → PERFORMANCE_ACCEPTED` (terminal), with
  `performance.rejected` returning to `TERMS_ACCEPTED`. `SETTLED`, `DELIVERED` and
  `CANCELLED` are **not reachable** — money moves outside TrustFlow by design, and
  cancellation is undecided.
- Both parties can download the record, and they get **different documents**: the
  owner a self-contained re-verifiable audit trail, the guest a server-verified
  record that does not invite recomputation. Do not converge them — see
  `Decisions.md`.
- **Payment is now a party assertion, the same shape as performance.** Three new
  event types — `payment.reported` (receiver), `payment.acknowledged` /
  `payment.disputed` (performer) — let either side record a claim about payment
  moving on whatever rail they actually use, outside TrustFlow. Not a payment
  processor integration; a timestamped statement, nothing more. Live in production
  (`log-event` v9, `guest-contract-events` v8). `AgreementView` seeds the payment
  note with the agreed amount and gives delivery its own optional note (file name,
  a checksum) — neither is verified, both are just easier to say than to omit.
- **The invite link can be found again after creation.** It used to exist only in
  the "New contract" dialog and in `ContractsHomeView`'s single expanded lead
  card. Now: `AgreementView`'s header, and every compact `ContractRow`, both show
  a "Copy invite link" affordance whenever the invite is unaccepted.
- **A never-accepted draft can be deleted.** `owner_delete_unaccepted_draft` (RLS)
  lets the owner hard-delete their own contract only while it is still
  `AWAITING_ACCEPTANCE` with an unused invite token — which is exactly the
  contracts that have zero rows in `events`, so nothing evidentiary is ever at
  risk. UI: a trash icon next to Copy invite link, same visibility condition.

The legacy five-step `ContractView` / Marketplace surface still exists on local
mock state, reachable through command-palette entries labelled "(legacy)", and
through "Skip Intro" on first visit — **the onboarding flow's default landing
view is still this legacy marketplace, not `ContractsHomeView`**; noticed but not
fixed this session. Its `logEvent` calls fail server-side by design. Do not
mistake it for the real flow, and do not read its "✅" history as evidence of
anything working.

## Current State

- Branch **`main`**, in sync with `origin/main`, tree clean.
- Build ✓ 0 errors (`index-*.js` ~610 kB, css ~62 kB). Unit tests **201 passing**
  across 12 files (`npm test`).
- **Two Supabase projects**, both in org `wavfjqgbnahqfhgeleqe` (free), Mumbai:

  | | ref | used by |
  |---|---|---|
  | `trustflow` | `fqgpzhwvvfsxswlnbbgg` | the deployed site, `.env` |
  | `trustflow-e2e` | `yqjtawffpesplqyurlpj` | live E2E only, `.env.e2e` |

  See `docs/e2e-project.md` for the whole arrangement. Live E2E stood at 92/92 as
  of 2026-09-26; not re-run this session (no live-flow code changed there).
- **29 migrations**, fully applied to production, nothing pending. Newest:
  `20260929000200_delete_unaccepted_drafts.sql` (grants `delete` on `contracts`
  to `authenticated`, gated entirely by the RLS policy above it).
- **Edge Functions in production**: `log-event` (v9), `guest-contract-events`
  (v8), `validate-invite-token` (v8) — all called from `src/`. Plus
  `create-payment-intent`, `capture-payment`, `cancel-payment` (deployed,
  current, unreachable from the app). Every deploy this session was verified by
  downloading the source back and diffing — do that, not `updated_at`.
- **`send-acceptance-email` and `timestamp-event` remain deleted** (both 404
  since 2026-09-26). Do not redeploy either.
- **Auth, materially changed this session:**
  - **This project's OTP length is 8 digits**, not Supabase's 6-digit default —
    a project setting, deliberately kept rather than reverted (see Lessons).
    Both OTP inputs (`SignInView`, the BYOC email-claim box) now match it.
  - **Custom SMTP is live**, via Resend, using the already-verified domain
    `kenji.com.hk` (`noreply@kenji.com.hk`, `smtp.resend.com:587`). This
    replaces the platform default mailer's ~2/hour cap, which had been hit
    repeatedly through ordinary testing. Delivery confirmed; first message
    landed in spam and was marked not-spam, which should improve going forward.
    Auth email templates (subject/body for the OTP emails) were rewritten to
    name TrustFlow and show the code plainly.
  - **Google sign-in was added, then removed the same session.** It was never
    finished (the OAuth provider was never configured in the Supabase
    dashboard), and on reflection was judged a poor fit for the product's own
    identity model — see `Decisions.md`'s 2026-09-27 entry. No trace of it
    remains in code.
  - **`isEarnerVerified()` now calls `refreshSession()`, not `getUser()`, and is
    wrapped in try/catch.** `verified_earner_only_insert` checks
    `auth.jwt() ->> 'is_anonymous'` — a claim baked into the access token at
    mint time — not a live lookup, so a token minted before an email was
    claimed kept failing inserts even after the account was genuinely
    verified. Reproduced live; see Lessons.
  - The verified test account `ken2san@loveharu.ca` created earlier this
    session was **deliberately deleted** (dashboard) at the user's request, for
    a clean restart. **There is currently no verified operator account** — the
    next real attempt starts from a fresh anonymous session claiming an email
    from scratch. The QA Earner (`trustflow.qa.1790033400@gmail.com`) is
    untouched and is not this account.
- **Frontend**: Vercel, `https://project-trustflow.vercel.app`, git-push-to-deploy
  from `main`. `.env` still points at production.
- **Docs are current, not stale.** `Protocol.md` and `Roadmap.md` were rewritten
  this session from the code, replacing legacy/aspirational content that
  contradicted the implemented protocol. `Decisions.md` gained a 2026-09-27 entry
  covering the identity/trust model discussion and why `invited_hirer_email`
  stays a required field.

## Active Constraints

- **Do not add npm packages** without explicit approval.
- **Do not deploy migrations or Edge Functions, or touch Stripe production config,
  without explicit instruction.** Each deploy is approved individually — this
  held throughout this session; expect the auto-mode permission layer to block
  the first attempt at each and ask again.
- **Push migrations with `supabase db push`, never the management API.**
  `db push` has no `--project-ref` — use `--db-url`, or the linked project
  (confirmed still linked to production, not the E2E project).
- **Never run the full E2E suite repeatedly** — per-IP signup cap risk.
- **Do not restart, delete or otherwise destructively touch the production
  Supabase project as a whole.** Deleting one test user (as done this session)
  is a scoped, requested action; wiping the project is not the same thing.
- **Do not redeploy `send-acceptance-email` or `timestamp-event`.**
- **Do not delete production's existing test data** (the QA Earner's 1272
  contracts / 2310 events) — still an open decision, not a chore.
- Gemini API and eKYC are out of scope for the current MVP spec.

## Next Priority (in order)

1. **Complete one real dogfood transaction end to end.** This has been the goal
   for several sessions and every blocker found so far was a real bug (JWT
   staleness, wrong OTP length, a stale code left in the input, the email rate
   limit) rather than a design problem. Nothing known is blocking it now. Start
   from a fresh account (see Current State) and actually run the certified-
   translation agreement through to `PERFORMANCE_ACCEPTED` with a real
   counterparty.
2. **Cancellation: build only the withdraw-before-acceptance half.** Decided
   2026-09-25, still not implemented. Voiding an *accepted* agreement remains
   undecided. Needs `derive_contract_state()` to project the withdrawal.
3. **The onboarding "Skip Intro" path lands on the legacy Marketplace, not
   `ContractsHomeView`.** Found this session, not fixed. Reroute it.
4. **The rest of the MVP consistency refactor** — `App.jsx` decomposition (still
   ~1740 lines), escrow-terminology cleanup, and whatever the full-spec review
   (not in this repo) still calls for. Trust Score / Trust Passport remain out
   of scope; do not build them speculatively — see `Decisions.md`'s
   identity/trust entry for why the current minimal model may already be enough.

## Open Decisions

- **What to do with production's test data.** Unchanged: 1272 contracts / 2310
  events belong to the QA Earner, boundary against new writes holds, deletion
  still undecided. See `Decisions.md`.
- **Whether creation should be an event.** Unchanged — `createContract` still
  logs nothing; acceptance is still the chain's first event.
- **Whether to run `scripts/check-migrations.mjs` in CI.** Unchanged — no
  `.github/workflows` exists yet.
- **Whether to keep the two deleted functions' sources.** Unchanged.
- **A small code-duplication nit from this session's ultrareview, not acted
  on**: `AgreementView` has three near-identical "expand a textarea, confirm or
  cancel" blocks (delivery note, payment report, payment dispute). Worth one
  shared component eventually; deferred as a refactor of working code, not a bug.

## Lessons this project has already paid for

- **A live database check beats an assumption about a client library's
  behaviour.** `isEarnerVerified()` trusted `getUser()`'s live, correct answer
  while the actual write used a token minted under the old, stale claim —
  found only by reading the RLS policy's own SQL and comparing it to what the
  function actually checked.
- **Don't hardcode a value that is actually a project setting.** Both OTP
  inputs assumed 6 digits; this project's is 8. `maxLength` silently discarded
  every character past the assumption, making the code impossible to enter no
  matter how correct it was.
- **Clear state when re-requesting, not just when explicitly cancelling.** A
  second OTP request left the previous code sitting in the input, which then
  failed as "expired" — true, but the real problem was staleness, not timing.
- **Check a plpgsql function's parameter types against the real column types.**
  (Prior session; still the sharpest example in this repo.)
- **A test suite that has never run is worth nothing**, and a skip that reports
  success is worse than a failure.
- **Verify a deploy by downloading the deployed source and diffing it.**
- **Being unreachable from `src/` protects nothing.**
- **A comment asserting a behaviour is not that behaviour.**

## Key Files

- `AGENTS.md` — agent behaviour rules. `CLAUDE.md` only imports it.
- `Decisions.md` — architectural decisions; do not reverse without instruction.
- `Protocol.md` — the implemented evidence protocol, current as of this session.
- `Roadmap.md` — product direction; explicitly marked as intent, not a build log.
- `docs/e2e-project.md` — the two-project arrangement, what enforces the
  boundary, and the order to rebuild in.
- `supabase/functions/_shared/eventCanonical.ts` — the one definition of what an
  event's hash covers. `_shared/eventRecord.ts` — the one place an event row is
  assembled.
- `src/lib/auditExport.js` — the owner's audit export.
  `src/lib/guestRecordExport.js` — the guest's.
- `src/lib/earnerAuth.js` — sign-in/sign-up, `isEarnerVerified()`,
  `describeAuthError()` (the one place a raw Supabase Auth error becomes a
  message that says what to do).
- `tests/e2e/liveEnv.js` — credentials, and the refusal to run without them.
- `src/lib/invite.js` and `src/lib/tsa.js` — **dead**. The first is the legacy
  client-side HMAC invite system; the second is imported by nothing and its Edge
  Function is deleted.
