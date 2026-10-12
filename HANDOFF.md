# TrustFlow — AI Session Handoff

_Last updated: 2026-10-12 (migration-history drift repaired; both migration
ledgers level at 34; all four Edge Functions now identical on production and
E2E; everything pushed through `545526c`. The backend queue is empty)_

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
mock state, reachable through command-palette entries labelled "(legacy)". It is
no longer somewhere the app can put you without asking: the initial view is
`'home'` (`ContractsHomeView`), onboarding lands there explicitly, and a
snapshot restore may only reopen a view on `RESTORABLE_VIEWS`. An earlier
version of this file said the onboarding default was the legacy marketplace;
that was wrong when written — see Next Priority #4 for what the real defect
turned out to be. Its `logEvent` calls fail server-side by design. Do not
mistake it for the real flow, and do not read its "✅" history as evidence of
anything working.

**One transaction has now been carried end to end, 2026-10-11.** Contract
`8c98dca5`, ¥50,000, on the E2E project: acceptance, delivery asserted with a
note, two access re-issues, delivery accepted, payment reported — six events,
ending at `PERFORMANCE_ACCEPTED`. The chain was then **re-verified
independently** from the raw rows through `_shared/eventCanonical.ts`, outside
the app: every `event_hash`, `payload_hash`, `agreement_hash`, `dod_hash` and
chain link recomputed, thirty checks, all matching. The central claim holds on
a real transaction rather than only in the export's own `VERIFIED` flag.

Ten defects surfaced on the way and all are fixed: a truncated email field, a
deadline with no floor, a delete confirmation with no Yes, a signed-out screen
that promised records were safe without having looked, no sign of which
account you were acting as, two Edge Functions two weeks stale on E2E, an
unapplied migration, a counterparty permanently locked out, a URL race that
discarded the recovered view, and a failed load that showed a spinner for
ever. None was a design fault; every one was something built and never driven.
What the run did **not** cover is Next Priority #1.

## Current State

- Branch **`main`**, **pushed through `545526c`** (2026-10-12): the nineteen
  commits held back since `1930d20` went out in one push, which also deployed
  the frontend. Check for later local-only work with
  `git rev-list --count origin/main..main` rather than reading a number here —
  a number written in this file goes stale on the commit that writes it.
  **A push to `main` is a production frontend deploy** (see below) — that is
  why those commits were held until the backend caught up, and it is still true
  of the next one. Working tree is NOT clean: `tests/e2e/anonymousSession.js`
  (new) and edits to `tests/e2e/event-ingestion.spec.js` /
  `tests/e2e/invite-persistence.spec.js` are **Codex's uncommitted work** —
  do not commit, revert or edit them (see "Ownership and locks").
- Build ✓ 0 errors. Unit tests **373 passing across 17 files** (`npm test`,
  measured 2026-10-12). `node scripts/check-migrations.mjs` → migrations OK.
  `npm run test:api` (E2E project only) → **20 checks, 0 failed**, and
  `scripts/verify-chain.mjs` recomputed that run's chain independently — 4
  events, 17 checks, `CHAIN VERIFIED`.
- **Two Supabase projects**, both in org `wavfjqgbnahqfhgeleqe` (free), Mumbai:

  | | ref | used by |
  |---|---|---|
  | `trustflow` | `fqgpzhwvvfsxswlnbbgg` | the deployed site, `.env` |
  | `trustflow-e2e` | `yqjtawffpesplqyurlpj` | live E2E only, `.env.e2e` |

  See `docs/e2e-project.md` for the whole arrangement. The Playwright suite
  last stood at 92/92 on 2026-09-26 and **has not been re-run since**, which
  now matters more than it did: live-flow code HAS changed under it. It is held
  back by the per-IP anonymous-signup cap (see Active Constraints), not by a
  judgement that it would pass. The API-level `npm run test:api` has been run
  against the current build and passes 20/20.
- **34 migration files; both projects' ledgers now hold 34 rows and are level
  again** (repaired 2026-10-11/12). Before the repair, three October migrations
  appeared TWICE in each remote ledger — once under the local filename's version
  and once under a timestamp the management API minted for itself — so
  `supabase migration list` was not bijective and `db push` was blocked. The
  schema bodies were never in doubt: every CHECK constraint definition, the
  `party_read_contract_events` policy expression, all `contracts` triggers and
  `validate_contract_creation_only`'s source were compared across both projects
  and are byte-identical. Only the ledger was wrong, and only the ledger was
  touched. See `20261011235959_reconcile_october_security_migrations.sql`, which
  documents the drift table and why replaying the bodies was unacceptable.
- **`reissue_guest_access` now exists in production** (applied 2026-10-12).
  `md5(pg_get_functiondef(...))` = `36c958a35945282f244052fe573cc7a7` on BOTH
  projects; `prosecdef` true, `proconfig` `search_path=""`, and `proacl` =
  `{postgres=X/postgres,service_role=X/postgres}` on both — no EXECUTE for
  `anon`, `authenticated` or `public`. The two projects' migration ledgers and
  this function are now level; **their Edge Functions are not** (next bullet).
- **Edge Function vintage, measured 2026-10-12 by downloading the deployed
  source, not by `updated_at`:**

  | function | production | trustflow-e2e | `ezbr_sha256` |
  |---|---|---|---|
  | `log-event` | **v10** | v5 | `edb1fae3…` |
  | `guest-contract-events` | **v9** | v5 | `2d15e3a2…` |
  | `validate-invite-token` | **v9** | v3 | `a94f9381…` |
  | `reissue-guest-access` | **v1 (new)** | v2 | `a415bd80…` |

  **Both projects are on one vintage as of 2026-10-12, and the digests are
  identical across them** — the version numbers differ only because each
  project has its own deploy count. `verify_jwt` is true on all four. The
  two-week production lag described below is closed; the paragraph stays
  because the reasoning is what makes the rule worth keeping.

  E2E briefly ran two vintages during this work: `validate-invite-token` was
  deployed alone, before the batch deploy of the other three was refused. It
  was benign (`legacyAuthMethod()` holds the old `_auth_method` vocabulary
  fixed, and the chain verified throughout), and it is the concrete
  demonstration of why the set deploys together rather than a hypothetical.

  **The rule this cost, which outlives the incident: each Edge Function bundles
  its own copy of `_shared` at deploy time.** Deploying one of a set puts two
  vintages of `eventRecord.ts` live at once — the exact drift that file's header
  comment warns about. Deploy the set together, or not at all.

  `npm run test:api`'s footer is the parity check, not decoration. It read
  `0 / 4` recomputable while E2E was behind `be0cba1` and reads **`4 / 4`** now.
  Read it on every run.

  Plus `create-payment-intent`, `capture-payment`, `cancel-payment` (deployed,
  unreachable from the app).

  **Past, for context — do not read as current.** Until 2026-10-12 production's
  bundle predated `0b8f409` / `5ab1140` / `be0cba1`: no `'access.reissued'` in
  `SERVER_RECORDED_TYPES`, an `_shared/eventRecord.ts` that took no `assurance`
  and wrote no `_authentication`, and no `_shared/authAssurance.ts` at all. It
  was never a hole — `access.reissued` was absent from `ALLOWED_TYPES` too, so
  no party could assert it. Meanwhile the reissue **frontend** had been live
  since 2026-10-11 calling a function that did not exist, reported to the user
  as "Try again in a moment", which was wrong advice. Both halves are now
  deployed. **A push to `main` is a production deploy.** Verify a deploy by
  behaviour or by downloading the source back and diffing — never by
  `updated_at`.
- **`send-acceptance-email` and `timestamp-event` remain deleted** (both 404
  since 2026-09-26). Do not redeploy either.
- **Auth, materially changed this session:**
  - **This project's OTP length is 8 digits**, not Supabase's 6-digit default —
    a project setting, deliberately kept rather than reverted (see Lessons).
    Both OTP inputs (`SignInView`, the BYOC email-claim box) now match it.
  - **Custom SMTP is live on both projects**, via Resend over
    `smtp.resend.com:587`. This replaces the platform default mailer's ~2/hour
    cap, which had been hit repeatedly through ordinary testing; enabling it
    raises the email limiter, which `auth_logs` records as
    `GOTRUE_RATE_LIMIT_EMAIL_SENT ... from 2/1h to 30`. Treat that line as a
    hint and not a verdict — editing the limit by hand in Auth → Rate Limits
    logs exactly the same thing, so it says the cap is gone, not that SMTP is
    configured. Auth email templates were rewritten to name TrustFlow and show
    the code plainly — Supabase's stock Magic Link template carries only
    `{{ .ConfirmationURL }}`, so without `{{ .Token }}` in the body there is no
    code to type and the screen asking for one cannot be satisfied.
  - **The sending domain is `loveharu.ca`** as of 2026-10-10, moved from
    `kenji.com.hk` when that became the operator's main Google Workspace
    address. Production sends as `noreply@loveharu.ca`, the E2E project as
    `noreply-e2e@loveharu.ca`, under **two separate Resend API keys** so that
    exhausting or revoking one cannot stop the other — the projects were split
    precisely so test activity could not reach production, and one shared
    credential would have re-coupled them. Nothing in the repository depends on
    the domain: the only reader of `EMAIL_FROM` is `send-acceptance-email`,
    which is deleted. A new sending domain starts with no reputation, so expect
    the first messages in spam, as happened on the previous domain.
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
  `db push` has no `--project-ref` — use `--db-url`, or the linked project.
  **The CLI is now linked to `trustflow-e2e`, not production**, and
  `supabase/.temp/project-ref` is absent, so anything taking `--linked` fails
  with "Cannot find project ref". Pass `--project-ref` explicitly instead; that
  also removes any chance of a command meant for E2E landing on production.
  `supabase functions deploy <name> --project-ref <ref>` works and was how both
  projects were deployed on 2026-10-12 — so there is no reason to relink, and
  relinking to production would leave exactly the footgun this avoids.
  The management API's `apply_migration` is banned for a concrete reason, paid
  for twice: **it mints its own timestamp version per call and rewrites the
  body** (schema-qualifying identifiers, stripping the file's `begin;`/`commit;`
  because it supplies its own transaction), so the ledger records a version no
  file has. That is the whole cause of the October drift above.
- **A single owner per workspace and per database.** See "Ownership and locks".
- **Never run the full E2E suite repeatedly** — per-IP signup cap risk.
- **Do not restart, delete or otherwise destructively touch the production
  Supabase project as a whole.** Deleting one test user (as done this session)
  is a scoped, requested action; wiping the project is not the same thing.
- **Do not redeploy `send-acceptance-email` or `timestamp-event`.**
- **Do not delete production's existing test data** (the QA Earner's 1272
  contracts / 2310 events) — still an open decision, not a chore.
- **The guest access token is authority, not identity.** It is a bearer
  capability: it says the holder may act on this agreement, and nothing about
  who they are. The address recorded at acceptance is the one the guest typed
  and is stored as `_claimed_identity` with `_claimed_identity_verified:
  false`, and `_auth_method` says `invite_capability` precisely so a reader
  can tell the two apart. Nothing downstream may treat either as a verified
  account identity — not the record, not the export, and not an
  authorisation check. This is what makes recognising a hirer by email the
  wrong repair, and it is easy to reach for twice; see
  `20261011000000_reissue_guest_access.sql` and `Decisions.md`'s
  "What TrustFlow actually knows about the guest".
- Gemini API and eKYC are out of scope for the current MVP spec.

## Ownership and locks

Adopted 2026-10-12. Not a new design — the working arrangement that was already
in force, written down because two agents editing the same tree and the same
database is how the migration drift above happened in the first place.

- **Kenji → ADA (orchestrator) → the assigned agent.** Direct instructions to an
  agent are avoided; when one happens anyway, it is mirrored back to ADA so the
  orchestrator's picture stays whole.
- **Claude = Builder. Codex = Auditor (read-only).** The roles were stated
  backwards once and real edits were made under the wrong one, so: an auditor
  reports, it does not write.
- **One owner at a time for the working tree and for each database.** Codex is
  paused as of 2026-10-11; its uncommitted test files are listed under "Current
  State" and are not Claude's to touch.
- **Every push, every deploy and every production write is individually
  approved.** Approval for one does not carry to the next, and approval in E2E
  never implies approval in production.
- **Report to ADA:** what was done, what is blocking, what needs a decision, and
  the exact scope of what changed.
- **Refresh this file** at the end of each phase, before any production change,
  and before any handoff — updating what is stale rather than appending beneath
  it. Check its "Last updated" line against `git log -1 -- HANDOFF.md` and the
  working tree before trusting it.

### Still waiting on approval

Nothing. The backend queue is empty for the first time since 2026-10-10.

### Rollback, if the deploy turns out to be wrong

- **Edge Functions**: there is no CLI rollback. Redeploy the three pre-existing
  functions from **`50e8147`** (an ancestor of `origin/main`), which is what
  production ran until 2026-10-12. `reissue-guest-access` is new; leaving it in
  place is harmless, and its RPC is `revoke`d from everything but
  `service_role`.
- **Frontend**: Vercel keeps the previous production deployment
  (`1930d20`, `dpl_9sATxFCyNfX42WACVEc8axGBU9nb`); promote that rather than
  reverting commits.
- **Database**: nothing to roll back. No DDL and no row was written in this
  work — `events` stayed at 2396 and `contracts` at 1321 across the whole
  deploy, checked before and after.


### Approved and done, 2026-10-12

- Production DB: `20261011000000_reissue_guest_access` applied; the three
  duplicate October ledger rows deleted by Kenji in the dashboard SQL Editor.
- E2E: all four Edge Functions brought current.
- **Production: all four Edge Functions deployed**, digests identical to E2E,
  `verify_jwt` true on each. `reissue-guest-access` existed nowhere in
  production before this. An unauthenticated POST now returns 401 rather than
  404, which establishes only that the function exists and is routed — **the
  authenticated re-issue path has not been exercised in production**, and
  deliberately will not be: that would write an `access.reissued` event onto a
  real contract. It is exercised on E2E by `npm run test:api` checks 16 and 17.
  So the live "Re-issue counterparty access" button is no longer calling a
  function that does not exist; whether it succeeds end to end in production is
  untested and will stay untested until there is a contract worth testing it
  on.
- **Pushed `1930d20..545526c`** (fast-forward, no force), which deployed the
  frontend.
- Measured: 373 unit tests / 17 files, build clean, `check-migrations` OK,
  `test:api` 20/20 with a `4 / 4` parity footer, chain independently
  recomputed, and production row counts unchanged either side of the deploy.

### Not approved — do not do these without a fresh instruction

The approvals given on 2026-10-12 were for the work listed above and are spent.
They do not carry forward.

- A further `git push`, and therefore a further production frontend deploy.
- A further production Edge Function deploy.
- Any production SQL beyond what is listed above.
- Touching Codex's uncommitted test files.

### The next safe step

**Next Priority #1 — a real second human.** The backend queue that has filled
this file for three days is empty, both projects are level, and nothing left in
the list tests what that tests. Resist adding backend work in front of it; the
reason it keeps getting deferred is that it is the only item that cannot be
done alone.

Also outstanding, not blocking: Codex's three uncommitted E2E test files still
sit in the tree, untouched, and Codex is still paused. Decide what happens to
them before anyone else edits `tests/e2e/`.

## Next Priority (in order)

1. **A real second human.** The dogfood proved the mechanism (see "Where the
   product stands"); it did not test a stranger. Both addresses were one
   operator in two browser profiles, and across all 86 accepted contracts
   `hirer_user_id` is null with only `hirer_email` set — a guest never gets an
   account row, and the address is the one they typed. So nothing yet has
   tested usability for someone who did not build this, identity,
   misunderstanding, correction or dispute. That is where `agreement_hash` and
   the invited-versus-claimed distinction stop being plumbing and become the
   product. It cannot be done alone.

   Worth knowing before arranging it: **Send Invite produces a shareable URL
   and sends no email.** Invitation delivery is manual, through whatever
   channel the owner picks, and so is a re-issued access link.

2. ~~Ship the re-issue work to production.~~ **Done 2026-10-12**: migration
   applied, all four Edge Functions deployed to both projects with identical
   digests, everything pushed. Nothing remains. The constraint it was carrying
   is recorded where it belongs — see the Edge Function table in Current State
   for why the set deploys together.

   **Proposed, NOT STARTED: independent-AI-counterparty simulation.**
   Implementation and the account/session architecture are **TBD with Claude in
   phase ②** and deliberately undecided here. Do not design it in this file.
   It is not a substitute for #1 — a simulated counterparty cannot test
   misunderstanding, correction or dispute between two real people.

3. **Cancellation: build only the withdraw-before-acceptance half.** Decided
   2026-09-25, still not implemented. Voiding an *accepted* agreement remains
   undecided. Needs `derive_contract_state()` to project the withdrawal.
4. ~~The onboarding "Skip Intro" path lands on the legacy Marketplace.~~
   **Settled 2026-10-12, and the diagnosis was wrong.** Skip Intro was already
   fine: the initial view is `'home'` and `onComplete` only dismisses the
   overlay. What put a user on the legacy surface uninvited was the **snapshot
   restore**, which accepted any view name but two. Since `view` is cloud-safe
   and the state those views need is not — `selectedItem` is local-cache-only,
   `projectDetail` is not persisted at all — a restore could also land on a
   blank screen or the spinner that never resolved for `'agreement'` in
   September. `RESTORABLE_VIEWS` in `src/lib/runtimeState.js` is now an
   allowlist (`home`, `wallet`), matching that file's existing payload
   allowlist and for the same reason. The legacy Marketplace / Command Center
   remain reachable from the command palette's "(legacy)" entries.
5. **The rest of the MVP consistency refactor** — `App.jsx` decomposition (still
   ~1740 lines), escrow-terminology cleanup, and whatever the full-spec review
   (not in this repo) still calls for. Trust Score / Trust Passport remain out
   of scope; do not build them speculatively — see `Decisions.md`'s
   identity/trust entry for why the current minimal model may already be enough.

## Open Decisions

- ~~A counterparty who loses their browser is locked out permanently.~~
  **Settled 2026-10-11: owner-initiated reissue**, shipped and exercised in
  the dogfood. The owner mints a fresh `guest_access_token` for their own
  accepted contract and sends the link the way they sent the invitation;
  `access.reissued` records that access changed hands, and the new value
  overwrites the old, which is also this system's first way to revoke a
  leaked credential. Recognising a hirer by email was rejected — see
  `20261011000000_reissue_guest_access.sql` for why, and do not revisit it
  without reading that first.

- **`hirer_email` is compared case-sensitively, and is stored as typed.**
  `validate-invite-token` only trims it; GoTrue lowercases the JWT email claim.
  So a guest who typed `Bob@Corp.com` does not match
  `party_read_contract_events`' `=` comparison (20260924000002). Latent today
  because guests read through their token rather than an account, but it
  cannot be repaired by normalising the stored value: `hirer_email` is inside
  the hashed agreement snapshot and the log is append-only. Any fix has to
  decide whether code compares case-insensitively while the RLS policy does
  not.

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

- **A client that collapses the server's reason hides bugs for weeks.**
  supabase-js turns any non-2xx into a `FunctionsHttpError` with `data` null,
  so `data?.error ?? 'error'` — the shape every invoke site used — reduced
  every distinct refusal to one word, and `logEvent` fell back to
  `error.message`, which for a non-2xx is a fixed sentence. The Edge Functions
  were always saying exactly what was wrong. Three separate symptoms on
  2026-10-10/11 were the same cause: `type_not_allowed` from a stale
  deployment read as a transient failure for two weeks, `invalid_guest_token`
  read as "could not be loaded", and the client's branch for
  `wrong_party_for_event_type` turned out to be unreachable code because a 403
  never arrived as anything but `'error'`. `invokeErrorReason` in
  `src/lib/supabase.js` is now the single place that reads the function's own
  `{error}` back off the failing Response. The unit test passed throughout,
  because it asserted a 2xx carrying `{error}` — a shape these functions never
  produce. **When a test for a failure path has never once gone red, check
  that it describes a failure the system can actually have.**

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
- **A migration ledger can be wrong while the schema is right, and the ledger
  is what blocks you.** Three October migrations were recorded twice under
  different versions; every constraint, policy, trigger and function body was
  byte-identical across both projects throughout. The fix was never to re-run
  the DDL — each of those files drops and recreates a constraint, so a replay
  that fails between the two leaves validation off. Prove the bodies match by
  digest first, then repair the ledger alone.
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
