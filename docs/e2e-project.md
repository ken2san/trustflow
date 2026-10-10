# The E2E Supabase project

The live E2E suites used to run against the same project the deployed site uses.
Since 2026-09-26 they run against a separate one.

| | ref | role |
|---|---|---|
| `trustflow` | `fqgpzhwvvfsxswlnbbgg` | production; the deployed site and `.env` |
| `trustflow-e2e` | `yqjtawffpesplqyurlpj` | live E2E only; `.env.e2e` |

Both are in organization `wavfjqgbnahqfhgeleqe` (free plan), Mumbai / `ap-south-1`.

## Why

Every one of the 1272 contracts in production belonged to the QA Earner — there
was no real data — but that was the reason to act, not to wait. `events` carries
`no_delete_events` and `no_update_events` as **`DO INSTEAD NOTHING`** rules, so a
`DELETE` on events *succeeds and deletes nothing*. `contracts` has no such rule and
`events.contract_id` is `text` rather than a foreign key, so contracts can be
deleted while their events survive: 814 of 2310 events were already orphaned that
way. Once one real contract exists, its events are permanent by design and could
never be separated from test rows sharing the table, so the split had to happen
first.

A second, independent reason: the per-IP signup cap is a property of the project.
Three back-to-back full runs saturated it on 2026-09-24 through anonymous
`/signup` and took the whole project — including the live site — offline until a
manual restart. The suites now spend their own budget.

**Production's existing test data was deliberately left in place.** The goal was a
boundary against new writes, not a cleanup.

## How the boundary is enforced

- `tests/e2e/liveEnv.js` is the single source of the four live credentials, loads
  `.env.e2e` itself, and throws rather than skipping when one is absent.
- `playwright.config.js` passes `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` into
  the dev server through `webServer.env`. Without this, the four browser-driving
  suites (`contracts-home`, `earner-signin`, `guest-evidence`,
  `invite-persistence`) would act through an app Vite built from `.env` — a
  different file — and would have kept writing to production while the API-level
  suites moved.
- `tests/e2e/00-backend-guard.spec.js` asserts that the page under test reports the
  expected Supabase URL, reading `window.__TF_SUPABASE_URL__`. Needed because
  `reuseExistingServer: true` lets an already-running dev server serve the tests
  without ever seeing those values. Named `00-` so it runs first.

Verified with data rather than inference: production's newest contract is
`07:15:46Z`, the last run before the switch. The E2E project's contracts start at
`07:30:57Z`. Nothing has landed in production since.

## Rebuilding from migrations — and what that test found

`supabase db push` has **no `--project-ref` flag**. Either link, or pass a
connection string. The repo stays linked to production so that a bare
`supabase db push` still means production; the E2E project is targeted explicitly:

```
supabase db push --db-url "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
                 --include-all --yes
```

All 28 migrations then run in order against an empty database. This was the rebuild
capability that had never been executed — the claim had rested on static analysis
because no Docker or local Postgres is installed. Running it for real found two
faults that static reading had not:

1. **The chain stopped at 22 of 28.**
   `20260924132813_reconcile_fixture_migration` records version `20260924140000`,
   which is dated *after* it, so on an empty database `db push` had not reached that
   migration yet: the insert succeeded, then `db push` failed applying the very
   migration it had just declared applied — `duplicate key value violates unique
   constraint "schema_migrations_pkey"`. History claimed the fixture was in place
   while its DDL had never run. The file's own comment asserted the opposite. Now
   guarded on the real precondition: a history repair does nothing unless the
   generated row it exists to remove is actually present. Fixed in `a19c6c8`.

2. **The expired-guest-token fixture named one production account.**
   `contracts.earner_user_id` is a foreign key into `auth.users`, so
   `20260924140000` needs a real account, and it selected a hardcoded address. On
   any other project it inserted nothing and `guest-evidence`'s expiry test failed
   with `invalid_guest_token` instead of `guest_token_expired`. It now takes the
   earliest non-anonymous account — which introduces the **ordering requirement
   below**.

The feared failure did not materialise: the event trigger in `20260313000000`,
normally superuser-only, applied without complaint.

The rebuilt schema matches production where it counts — 28 versions, both
acceptance functions with `execute` granted to `service_role` only, both
append-only rules on `events`, 10 policies, the same 5 tables, `invite_token` uuid,
`hash_version` default 4.

## Order of operations, if this is ever done again

1. Create the project.
2. **Create the test Earner account** — before the migrations, because
   `20260924140000` attaches its fixture to the earliest non-anonymous account and
   silently inserts nothing if none exists. Use the admin API with
   `email_confirm: true` rather than disabling email confirmation project-wide;
   `contracts`'s `verified_earner_only_insert` policy only requires that the JWT is
   not anonymous.
3. Apply the migrations.
4. Deploy the Edge Functions.
5. Enable anonymous sign-ins.
6. Switch `.env.e2e` and delete the cached session files.

## Edge Functions

Deploy with `--project-ref <ref>` (this one does take the flag). Deployed on the
E2E project: `log-event`, `validate-invite-token`, `guest-contract-events`.

`capture-payment` is additionally needed by `evidence-core`, and would need a
test-mode `STRIPE_SECRET_KEY`. `cancel-payment` and `create-payment-intent` are not
used by any suite. `send-acceptance-email` and `timestamp-event` must **never** be
deployed here — they were deleted from production on 2026-09-26 as unreachable and
unauthenticated, and their sources carry a header saying so.

## Secrets

Only one is not auto-injected. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come
from the platform.

- `STRIPE_SECRET_KEY` — test mode, and only if `capture-payment` is deployed.
- `INVITE_SECRET` is **not** needed; nothing among the remaining functions reads it.
  It belonged to the legacy client-side HMAC invite system.
- `RESEND_API_KEY` / `EMAIL_FROM` are **not** needed; the only function that used
  them is gone.

## A platform difference worth knowing

The newer project's gateway rejects a request carrying only `apikey` with
`UNAUTHORIZED_NO_AUTH_HEADER`, while the older one accepts it. The suites' `api()`
helpers sent `apikey` alone unless a user token was supplied, so on the new project
every call 401'd at the gateway — and the negative-auth assertions would have
passed for the wrong reason, never reaching the function's own checks. The helpers
now always send a bearer: the user's token when there is one, otherwise the anon
key, which is what supabase-js does and what those tests' comments already claimed
("anon key only"). `verify_jwt` is `true` on every function in both projects; this
is gateway behaviour, not configuration.

## `.env.e2e`

Gitignored, loaded automatically by `tests/e2e/liveEnv.js`. Switching projects means
replacing all four values and nothing else:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
TF_TEST_EARNER_EMAIL=<the project's QA earner>
TF_TEST_EARNER_PASSWORD=<its password>
```

Also delete the cached sessions, which hold tokens for the previous project:

```
rm -f tests/e2e/.earner-session.json tests/e2e/.anon-fixture.json
```

`.env` — the deployed site and an ordinary `npm run dev` — keeps pointing at
production. Only the test path moved.

## Status

Every live suite has now run against this project and all of them pass — **92 of
92**: `00-backend-guard` 1/1, `atomic-acceptance` 10/10, `agreement-binding` 15/15,
`guest-evidence` 11/11, `event-ingestion` 10/10, `earner-signin` 8/8,
`contracts-home` 13/13, `evidence-core` 16/16, `invite-persistence` 8/8.

Anonymous sign-ins were the last blocker: `invite-persistence` mints an anonymous
identity to prove an unverified Earner cannot persist a contract, so that one test
could not run while the provider was off. Enabled on 2026-09-26 through the
dashboard (Authentication → Sign In / Providers), which is the only route — doing it
from a session would need the account-level access token.

## Where this project still differs from production

The two databases are built from the same migrations, but a Supabase project is
more than its schema, and the parts that live only in the dashboard drift
silently. Each of these cost real confusion during the 2026-10-10 manual run,
so they are written down rather than rediscovered.

**One migration behind.** `20260929000200_delete_unaccepted_drafts` is applied to
production and not here (production 29, this project 28), so neither the
`owner_delete_unaccepted_draft` policy nor the `delete` grant on `contracts`
exists. Deleting a draft therefore removes nothing. It now says so — the client
asks for an exact count and reports a refused delete — but the drafts cannot be
cleared here until this is pushed. Pushing it needs the explicit `--db-url`
form; a bare `supabase db push` means production.

**Auth email templates are configured per project.** Supabase's stock Magic Link
template contains only `{{ .ConfirmationURL }}`. An app that asks for a typed
code cannot be satisfied by it: the mail arrives with a link and no code, which
reads as a broken sign-in rather than a missing template. Production's templates
were rewritten on 2026-09-27; this project's were not, and that was found the
hard way on 2026-10-10. Any template here needs `{{ .Token }}` in the body.

**OTP length is a project setting too.** This product uses 8 digits rather than
Supabase's default 6, and the inputs are fixed at 8 — a 6-digit code cannot even
be submitted. A project restored or rebuilt from migrations comes back at 6.

**Custom SMTP** is configured here as of 2026-10-10, sending as
`noreply-e2e@loveharu.ca` under its own Resend API key, deliberately distinct
from production's `noreply@loveharu.ca`. Separate keys keep the boundary this
whole document exists to defend: one credential shared between the projects
would mean test activity could stop production's auth mail. The different
sender also makes it obvious from the inbox which backend a browser is driving.
Enabling it raises the email limiter, which `auth_logs` records as
`GOTRUE_RATE_LIMIT_EMAIL_SENT ... from 2/1h to 30`. That is a hint, not proof:
raising the limit by hand in Auth → Rate Limits logs the same line. What does
settle it is a delivered message — an auth email that arrives after the change,
with no mailer error in `auth_logs`, means the credentials and the sender
domain were both accepted by Resend. A sender on a domain Resend has not
verified is rejected outright, so a one-character slip in the address fails
every send rather than degrading quietly.

The general lesson: **migrations reproduce the schema, not the project.** Auth
providers, email templates, OTP length, SMTP and rate limits are dashboard
state, outside source control and outside `supabase db push`. Anonymous
sign-ins were the same kind of gap in 2026-09-26. When a flow behaves
differently here, suspect this list before suspecting the code.
