# TrustFlow

An append-only, hash-chained record of what two parties said they agreed,
delivered and paid.

**What it attests:** that a party *said* something, at a server-recorded time,
in an order, bound to the terms as the server held them at that moment.

**What it does not:** that work was delivered, that money moved, or who anyone
really is. `performance.asserted` is a claim by the performer,
`payment.reported` a claim by the payer. Neither is an observation by this
service, and the names are deliberate. The operator is inside the trust
boundary: there is no timestamping authority and no external anchor, so the
hash chain is tamper-evidence against later edits, not proof that anything
claimed is true.

## Agent-first

Every step of a transaction — create, accept, deliver, accept delivery, report
payment, acknowledge — is reachable over HTTP with no browser. The web
interface is for review and approval, not for the workflow.

The protocol is published, so a client needs no access to this repository:

- **[/llms.txt](https://project-trustflow.vercel.app/llms.txt)** — the index:
  what the service attests, the shape of a transaction, and what a client gets
  wrong first.
- **[/agent-protocol.md](https://project-trustflow.vercel.app/agent-protocol.md)**
  — normative. The shown-terms digest algorithm with reference vectors, and the
  invitation hand-over rule. A client that computes the digest differently
  cannot accept an agreement in any currency other than JPY.

Source of truth for both: `public/`. `tests/unit/shownTerms.test.js` asserts the
server reproduces the published vectors, so the document cannot drift from the
implementation unnoticed.

## Stack

React + Vite, deployed as a static bundle. Postgres with row-level security,
plus Deno edge functions, on Supabase. Four functions are live —
`validate-invite-token`, `log-event`, `guest-contract-events`,
`reissue-guest-access` — and the payment and mail surfaces are retired and
asserted absent on every release.

## Development

Node **>=22.18** (the unit suite imports TypeScript from
`supabase/functions/_shared` directly). Install with `npm ci`.

```sh
npm run dev              # local app
npm test                 # unit suite
npm run lint
npm run build
npm run check:migrations  # offline: migration filenames and ordering
```

Before a commit, `make check` runs the migration check, the unit suite and the
build.

### Live suites

These write real, permanent events and refuse to run anywhere but the test
project — the allowed project is pinned in source, not read from the
environment it is meant to validate.

```sh
npm run test:api         # one transaction, API only, both parties
npm run sim:two-agents   # the same, as two independent processes
npm run sim:counterparty # several agreements, counterparty decides
npm run verify:chain <contract-id>   # recompute the chain independently
npm run test:e2e         # browser suites
```

Credentials come from a local `.env.e2e`, which is not in the repository. The
live suites error rather than skip when it is missing: a skipped live suite
exits 0, which is how a broken acceptance path once went unnoticed.

## Repository layout

| Path | What |
| --- | --- |
| `src/` | the web client |
| `supabase/functions/` | edge functions; `_shared/` is the canonical form, event assembly and write rules, and is bundled into the web client too |
| `supabase/migrations/` | schema, RLS and the triggers that enforce event order |
| `public/` | the published protocol and the crawling policy |
| `scripts/` | harnesses, release smoke, chain verification |
| `tests/` | unit, browser and visual suites |

`AGENTS.md` is the behavioural contract for coding agents working here, and
`CLAUDE.md` imports it.

## Licence

See `LICENSE.md`.
