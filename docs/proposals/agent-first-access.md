# Agent-first access: delegated authority, evidence semantics, and one MCP server

Design only, 2026-11-08. No implementation, nothing deployed. Every statement
about today's behaviour is cited to a file and line, or to a read-only query
whose text is in the session that produced this document.

The premise, from Kenji: his own use of TrustFlow goes through an agent, so the
agent path is the primary surface and the web UI is for human review and
approval. The direction is **one remote MCP server**, not a plugin per agent.

The judging rule is also his, and it cuts against some of the rest of his
direction: ease of use decides, and people are put off by buttons, fields and
explanations. So every option below carries a count — **new buttons / new input
fields / new lines of explanatory text** — and the recommendation goes to the
smallest one that stays honest, not to the most capable one.

---

## 0. What already exists, measured

Four Edge Functions are live on production, all `verify_jwt: true`
(`mcp list_edge_functions`, 2026-11-08): `log-event` v12,
`validate-invite-token` v12, `guest-contract-events` v10,
`reissue-guest-access` v3. Five more are retired and must stay 404
(`scripts/smoke-production.mjs` asserts it).

Two credentials exist, and neither is a delegation:

- **The owner's Supabase JWT.** Obtained by an emailed OTP behind a Cloudflare
  Turnstile challenge (`src/views/SignInView.jsx`, `src/lib/captcha.js`). An
  agent cannot complete that, which is the whole reason this document exists.
- **The guest's `guest_access_token`**, a bare UUID stored in plaintext in
  `contracts.guest_access_token` (column type `uuid`, verified), presented in
  `x-guest-access-token` and scoped to one contract.

And one hard constraint that shapes the entire design, found by looking rather
than assumed: **because every function has `verify_jwt: true`, the platform
gateway validates `Authorization: Bearer` before the function body runs.** A
delegation token cannot go there — the gateway would reject it with no chance
for TrustFlow to interpret it. It must travel in its own header, with the anon
key in `Authorization`, which is exactly the shape the guest path already uses.

`log-event`'s own comment records the trap that comes with a custom header: it
must be listed in `Access-Control-Allow-Headers` or browsers fail the preflight
and the request never leaves the page — and *server-side callers do not
preflight*, so an API-level test cannot see the break. An MCP server is a
server-side caller. Any browser use of the same header needs a browser-level
test.

### The write path, as it is

`log-event` is the general writer for party-asserted events. It is **not** the
only writer to `events` — `validate-invite-token` and `reissue-guest-access`
each append inside their own RPC — although `log-event`'s own header comment
still claims it is (`index.ts:3`), which is stale and is reported below. A caller supplies
`type`, `contract_id`, `payload`, `idempotency_key` and nothing else that
matters: `actor_id`, `created_at`, `event_hash`, `prev_event_hash`, `dod_hash`
and the agreement snapshot are all derived server-side, and a caller offering
`dod_hash` is refused rather than ignored (`:243-246`). Authority is resolved
from credentials only (`resolveActor`, `:146-196`), role is checked against
`ROLE_REQUIRED` (`:130-140`), and the whole thing retries a contested chain tip
five times.

**This is the right shape for an agent surface and needs no redesign.** An agent
is simply another caller that cannot choose what the record says.

### Idempotency, as it is

Only `log-event` accepts a key. Its rule is `idempotencyOutcome`
(`_shared/eventWriteRules.ts`), matched on **contract + key + type + actor** —
tightened on 2026-11-06 after a measured disclosure where a guest supplying an
owner's key received the owner's event in full, payload included
(`log-event/index.ts:270-306`). `events_idempotency_idx` on
`(contract_id, idempotency_key)` backs it.

`validate-invite-token` (acceptance) and `reissue-guest-access` accept no key at
all. Both are chain writers that can fail mid-retry, so both are retried blind
today.

### Reads, as they are

- The owner reads through PostgREST under `parties_read_own_contracts`
  (`auth.uid() = earner_user_id OR hirer_user_id`), via `listContracts`
  (`src/lib/contracts.js:97-112`).
- The guest reads through `guest-contract-events`, which returns a *shaped*
  view: payloads filtered by a per-type allowlist (`_shared/guestEventView.ts:60`),
  per-event hash and chain verification, `verification` notes, and a `chain`
  block. It caps at **500 events, oldest first**, and sets
  `chain.truncated` when the cap is hit (`index.ts:51,160-162,289`). There is no
  cursor: beyond 500 events the rest is unreachable.

### The error vocabulary, as it is

Extracted from the four live functions: 16 distinct reasons in `log-event`, 13
in `validate-invite-token`, 5 in `guest-contract-events`, 7 in
`reissue-guest-access`, over HTTP 400/401/403/404/409/410/413/500. It is a good
vocabulary — `guest_credential_revoked` is deliberately distinct from
`not_a_party` so a revocation taking effect is visible in the log
(`log-event/index.ts:390-397`) — with two blemishes:

1. **Two reasons contain spaces**: `'missing invite_token'` and
   `'valid hirer_email required'` (`validate-invite-token/index.ts:76,81`),
   where everything else is snake_case. `smoke-production.mjs` asserts the first
   one literally, so they cannot simply be renamed.
2. **Nothing says whether a reason is retryable.** A client has to know that 409
   `chain_contention` is worth retrying and 409 `idempotency_key_in_use` never
   is. A human reads the docs; an agent guesses.

---

## 1. Delegated authority

### 1.1 Why neither existing credential will do

The guest token is per-contract, stored in plaintext, transferable, and carries
`bearer_capability` assurance — which is correct for a guest and wrong for an
owner's agent, because it would erase the fact that a *verified account holder*
authorised the act. The owner's JWT is the opposite problem: handing it to an
agent gives away everything, for its lifetime, with no record that an agent was
involved and no revocation short of ending every session.

### 1.2 The object

A new `delegations` table. Phase 1 fields, kept deliberately short:

| column | why |
| --- | --- |
| `id uuid pk` | the `D` in the evidence sentence; appears in every delegated event |
| `owner_user_id uuid not null` | the party on whose authority the agent acts |
| `label text not null` | the `A`: "Claude Code on Iris". Free text, owner-chosen, no verification claimed |
| `token_sha256 text not null unique` | **the hash, never the secret** |
| `scopes text[] not null` | §1.4 |
| `contract_id uuid null` | null = every agreement of this owner; set = exactly one |
| `issuer_assurance jsonb not null` | §2.2 — the human authentication fact, captured once |
| `created_at`, `expires_at not null`, `revoked_at null`, `last_used_at null` | lifecycle |

**Storing a hash is a deliberate divergence from the two existing credentials**,
which are plaintext UUID columns. A delegation is longer-lived and more powerful
than an invite token, and a database dump should not be a set of working agent
credentials. The cost is that the secret cannot be redisplayed — which is right,
and is how every other API key a developer has ever used behaves.

Secret format `tfd_<43 chars base64url>` (32 random bytes). The prefix is not
decoration: it makes a leaked token greppable in logs and recognisable to
secret scanners, and it tells a confused user which of the three tokens in their
clipboard they are holding.

### 1.3 Issue and revoke

**Issue** — a new owner-only Edge Function, modelled on `reissue-guest-access`:
verify the JWT with `admin.auth.getUser`, reject `is_anonymous`, capture
`assuranceFromClaims(claimsFromVerifiedJwt(...))` as `issuer_assurance`, insert,
and return the secret **once**. No event is written: issuing a delegation is not
a fact about an agreement, and writing one to every contract the owner holds
would be absurd. It is recorded in `delegations`, and it becomes evidence the
moment it is used.

**Revoke** — set `revoked_at`. The owner lists and revokes from the web UI; an
agent cannot revoke its own delegation, and a delegation with `manage` authority
over other delegations is not in phase 1.

**Revocation must be immediate, and this is the one place the design is
deliberately better than what exists.** The guest path cannot do this: a token
revoked while a request is in flight can still write, because `log-event`
re-reads the credential just before the insert but the window is not zero, and
closing it needs the check *inside the insert's transaction* — which the event
row cannot do because it does not carry the token that was presented
(`log-event/index.ts:377-399`, and `.ada/claude-report-2.md`). A delegation
*can* carry it: the delegation id is already inside the event payload as
evidence, so a BEFORE INSERT trigger can join `delegations` and refuse a revoked
or expired one under the same lock the other guards take, in the same
transaction. That is a new custom SQLSTATE in the family TF001–TF005 already
established — call it **TF006, "the delegation is not live"** — and it makes
revoke-while-in-flight structurally impossible rather than narrow.

This is the strongest argument for doing the delegation work properly rather
than papering over it with a long-lived JWT: it is the first credential in the
system whose withdrawal is exact.

### 1.4 Scopes — three, not a matrix

Kenji's rule applies to agents too: fewer, with sensible defaults. So:

| scope | permits | default |
| --- | --- | --- |
| `read` | status, list events, export, verify | always granted |
| `write` | create an agreement; append a reversible event (`performance.asserted`, `payment.reported`, `contract.initiated`) | granted unless the owner says read-only |
| `approve` | the acts that end something: `performance.accepted`, `performance.rejected`, `payment.acknowledged`, `payment.disputed`, and deleting a draft | **never granted by default** |

`read` is implied by everything, so the real choice is a two-way one the owner
can answer without a table: *can this agent act, and can it approve?* The
mapping from scope to act lives server-side in one object next to
`ROLE_REQUIRED` (`log-event/index.ts:130-140`), so there is exactly one place
that decides, and it is the same file that already decides who may say what.

`contract_id` is the second axis and it is one field, nullable, defaulting to
null. A per-contract delegation is what you hand to a counterparty's agent in
phase 2.

### 1.5 What phase 1 deliberately does not have

- **No guest-side delegation.** A guest has no account, no password and no place
  to keep a delegation — `hirer_email` is self-asserted and the only credential
  they hold is the one the owner handed them. A counterparty's agent therefore
  gets a **per-contract delegation issued by the owner**, which is the same
  authority shape as the guest token it replaces, and it is phase 2.
- **No scope on reading other people's agreements.** RLS already answers that
  and the delegation adds nothing: a delegated read runs as the owner.

---

## 2. Evidence semantics

### 2.1 The sentence, corrected

The task asks for a record that states *"party P said X via agent A under
delegation D at T"*. **That sentence is an overclaim, and `authAssurance.ts`
already explains why in a comment about a different field.** What the system can
establish is:

> An agent presenting delegation **D** — issued by **P** at **T₀**, labelled
> **A**, scoped **S** — asserted **X** at **T**, bound to agreement version
> `agreement_hash`. **P** authenticated at **T₀**. Nothing shows P saw this act.

The difference is the whole value of the feature. "P said X" through an agent is
precisely the claim `act_bound_authentication: false` exists to deny
(`authAssurance.ts:116-133`): there is no challenge bound to this agreement and
this action, so neither a recent login nor a valid delegation shows intent.
Delegation makes that gap *wider* — the human may have been asleep — so the
record has to be more careful, not less.

### 2.2 How it is recorded

Three additions to `_shared/authAssurance.ts`, and nothing to the `events`
schema:

1. `PresentedCredential` gains `'delegation_token'` (`:58-61`).
2. `AssuranceLevel` gains `'delegated_authority'` (`:75-81`). It is **not**
   `account_session` — no credential of the acting party was tested — and not
   `bearer_capability`, because unlike an invite token there is a verified
   account behind it.
3. A `delegation` block in `assuranceForRecord` (`:359-371`):
   `{ id, label, scopes, contract_scoped, issued_at, expires_at, issuer_assurance }`.

`issuer_assurance` is the move that makes the sentence provable rather than
asserted: it is the owner's own `assuranceForRecord` output **captured at
issuance**, so every delegated event carries, immutably and hashed, how and when
the human authenticated. Without it, "P authorised this" is an unsupported
inference from a secret the server cannot attribute.

`assuranceMeaning` (`:211-260`) gains the delegated case. It proves: a delegation
issued by this owner was presented and was live at write time (TF006, §1.3);
the act was within its scopes; the act was bound to this agreement version. It
does not prove: that the owner saw or intended this act; that the agent did what
the owner asked; that the label names the software that actually ran. Those
three lines belong in `does_not_prove`, travelling inside the data, for the
reason the module already gives — a machine reader has no README (`:202-210`).

**`actor_id` stays the owner's user id.** The agent is not a party; it is how a
party acted. This keeps `ROLE_REQUIRED`, `roleInAgreement`, RLS, the state
projection and `idempotencyOutcome`'s actor match all working unchanged, and it
is the single biggest reason this feature needs no change to `events`.

### 2.3 Receipt and verify

`scripts/make-receipt.mjs` already surfaces `_auth_method` and `_authentication`
per event (`:114-115`) and calls `assuranceMeaning` for its narrative, so most
of this arrives free. Two concrete changes:

- `make-receipt.mjs:181` hardcodes
  `counterparty_authority: assuranceMeaning(bearerAssurance('guest_access_token'))`.
  Once a counterparty can act under a delegation that line is **wrong rather
  than incomplete**, and it must read the recorded assurance instead of assuming
  the credential.
- The receipt should name the agent beside the act — "Marked delivered · via
  *Claude Code on Iris* under delegation `D` · the owner authenticated 6 days
  earlier" — because the elapsed time between `issuer_assurance` and the event
  is the fact a reader actually wants, and it is already derivable from
  `seconds_since_authentication` plus `created_at`.
- `verify-receipt.mjs` needs no new cryptography. The delegation block is inside
  `payload`, covered by `payload_hash` and therefore by `event_hash`, so it
  verifies by the existing path. What it must **not** do is treat a delegated
  event as equivalent to a human-session one; the distinction is in the data and
  should be in the output.

A reader who should see less: `guestEventView.ts`'s allowlist never carries
`_`-prefixed keys (enforced by a test), so `_authentication` and its delegation
block are not projected to the guest per-event. Note the lesson from Task 4 —
`guest-contract-events` returns `acceptance_identity` as a separate block
outside that filter (`index.ts:243-245`), so **the projection has to be checked
explicitly, not inferred from the allowlist.** Whether a counterparty should see
which agent acted for the owner is a product question; my view is yes, since it
is exactly the kind of fact the counterparty is entitled to weigh, and the label
is owner-chosen free text with no claim attached.

---

## 3. The MCP tool set

### 3.1 Six tools

Fewer tools with sensible defaults, per the judging rule. Required arguments in
bold; everything else defaults.

| tool | arguments | returns |
| --- | --- | --- |
| `create_agreement` | **project_name**, **counterparty_email**, **amount_jpy**, dod[], deadline, performed_by=`creator` | id, the invite URL to send through a channel the user already has |
| `agreement_status` | id, or nothing for all of them | state, **waiting_on**, **since**, deadline, invite/access expiry, next action — §3.2 |
| `record_event` | **id**, **type**, note | the event, or a refusal naming the reason |
| `list_events` | **id**, after, limit=100 | events oldest-first with a cursor — §4.3 |
| `export_record` | **id** | the same bytes the web UI's export produces |
| `verify_record` | **id**, or a receipt file | per-event hash and chain result, and what it does not prove |

Mapped onto what exists: `create_agreement` is the PostgREST insert
`createContract` already does; `record_event` is `log-event`;
`list_events`/`export_record` are PostgREST plus `src/lib/auditExport.js`;
`verify_record` is `scripts/verify-chain.mjs` and `verify-receipt.mjs`, which
already exist as scripts and need no server.

`agreement_status` is the one that is **not** a thin wrapper, and it is the tool
Kenji will use most. It needs the derivation that `docs/proposals/web-ux-waiting-and-wrong-email.md`
§4A recommends for the web UI — waiting-on, since-when, three distinct clocks —
and that is an argument for computing it **once, server-side, and serving both
surfaces from it**, rather than implementing the same rules in
`contractStatus.js` for the browser and again in the MCP server for agents. That
file's purity (`src/lib/contractStatus.js:1-14`, no React, no Supabase) makes it
portable to Deno as-is.

### 3.2 No seventh tool for approval, and no `confirm` parameter

The task asks for "an approval step for irreversible actions such as
acceptance". The cheapest honest version adds **zero** tools and **zero**
parameters:

An act needing `approve` scope, attempted under a delegation without it, is
refused by the server with a reason and a URL:

```
403 approval_required
"performance.accepted needs your approval.
 Open https://project-trustflow.vercel.app/?agreement=<id> and accept there."
```

The agent relays one sentence; the human clicks one button on the screen that
already exists (`AgreementView`'s single-action section,
`src/views/AgreementView.jsx:296-431`). **No new UI at all** — which is the
point. A `confirm: true` parameter would be worse than useless: the agent can
set it, so it records nothing about the human, and it would read in the log as
approval that never happened.

Acceptance specifically is the counterparty's act, not the owner's, so in phase
1 it is out of reach of Kenji's own delegation entirely and the question does
not arise. In phase 2 it is the first act that should be `approve`-only.

### 3.3 Counts

| option | new buttons | new fields | new lines of explanation |
| --- | --- | --- | --- |
| **recommended**: 6 tools, approval by refusal + link | **1** ("Create agent token", on an existing settings surface) | **1** (label, optional, defaults to "My agent") | **~3** (what the token does, that it is shown once, how to revoke) |
| 6 tools + an `approve_action` tool | 1 | 1 | ~6 (plus explaining when to call it) |
| 10 tools (one per endpoint) + per-act scopes | 1 | ~8 (a scope checkbox each) | ~15 |

The third row is what this design would have looked like without the judging
rule, and it is worth keeping on the page as the thing not to build.

---

## 4. Uniform behaviour

### 4.1 Idempotency on every write, including owner retries

`Idempotency-Key` as a header on every write endpoint, not a body field, so it
is uniform across the three functions that currently disagree. Then:

- `log-event` already honours it; the header simply joins the body field.
- `validate-invite-token` (accept) and `reissue-guest-access` gain it. Both
  already write an event inside their RPC, so the natural implementation is to
  pass the key into the event row and let `events_idempotency_idx` do the work —
  no new table, no new index.
- The matching rule stays `idempotencyOutcome` **exactly as written**
  (contract + key + type + actor). It was tightened after a measured
  cross-actor disclosure (§0), and a second copy of that rule is how this
  project's one production chain bug happened.
- For a delegated write the actor is still the owner (§2.2), so an owner
  retrying by hand and their agent retrying the same operation deduplicate
  against each other — which is the behaviour you want the first time an agent
  and a human both press the same button.

### 4.2 One error envelope, no renames

Keep every existing `error` string, including the two with spaces, because
`smoke-production.mjs` asserts one of them literally and a permanent record's
API is not the place for cosmetics. Add fields beside it:

```json
{ "error": "chain_contention", "detail": "…", "retryable": true,
  "where": "log-event", "docs": "https://…/errors#chain_contention" }
```

`retryable` is the field that earns its place: `chain_contention` and
`clock_behind_chain` are retryable, `idempotency_key_in_use`,
`wrong_party_for_event_type`, `guest_credential_revoked` and `already_used` are
not, and today a client has to know the difference from prose. Separately,
propose snake_case **aliases** for the two malformed reasons, served alongside
the originals, and fix the strings only when the smoke check is updated in the
same commit.

### 4.3 Pagination past 500

`guest-contract-events` caps at 500 and flags `chain.truncated`
(`index.ts:51,289`). Add a cursor over the ordering the system already treats as
canonical — `(created_at asc, id asc)`, the same tuple used by the tip read in
`log-event:316-324`, by `accept_invitation` and by `derive_contract_state()`:

```
POST /functions/v1/guest-contract-events { "after": "<created_at>|<id>", "limit": 100 }
→ { events: [...], next: "<created_at>|<id>" | null, chain: { …, truncated } }
```

Keep `truncated` for existing readers; it becomes `next !== null`. The chain
verification block needs care: today it reports over the whole returned set, and
on a page it can only report "this page links to the previous one", which must
be said rather than quietly narrowed — `expectedPrev` already threads through
the loop (`index.ts:215-220`) and would need to be carried in the cursor.

A paged export is a different question and should stay unpaged: a receipt that
covers 500 of 900 events is not a receipt. Phase 2.

---

## 5. Discovery

Three files, and only one of them is a standard that applies today.

**`/.well-known/oauth-protected-resource`** — RFC 9728 metadata. The MCP
authorization spec (revision 2025-06-18) makes it a **MUST** for a protected
MCP server, treats the server as an OAuth 2.1 *resource* server rather than an
authorization server, requires at least one entry in `authorization_servers`,
and expects a 401 to point at it through `WWW-Authenticate: resource_metadata=…`.
So it is **not** phase 1 material: with a pasted token there is no
authorization server to name, and publishing the file with nothing to point at
would be worse than not publishing it. It is the gate for phase 2 and it is the
expensive part of phase 2 — Supabase's GoTrue is not an OAuth authorization
server for third-party clients, so phase 2 needs one chosen, not written.

**`llms.txt`** — a convention, not a standard, and cheap. One page at the app
origin naming what TrustFlow is, what it refuses to claim, the MCP endpoint, and
a link to `docs/api/openapi.draft.yaml`. It is the single highest-leverage item
in this document relative to its cost: an agent that reads it stops guessing.

**`robots.txt`** — there is none today (no `public/`, no `vercel.json`, both
verified), so the prototype at `project-trustflow.vercel.app` is crawlable.
`HANDOFF.md` has a whole section on what being publicly reachable does and does
not expose; adding a `robots.txt` that disallows crawling while the product is a
prototype is a two-line file and is independent of everything else here.

The OpenAPI document itself is the fourth artefact and the draft is
`docs/api/openapi.draft.yaml`, delivered beside this one.

---

## 6. In-app channels that could later be retired or slimmed

**Listed only. Nothing below was removed, and this document does not propose
removing any of it.** Kenji's principle — do not rebuild email, WhatsApp, LINE
or chat; TrustFlow is the evidence layer — makes these the candidates:

| surface | where | why it is a candidate |
| --- | --- | --- |
| Activity log, the bell, and `unreadCount` | `src/App.jsx:219-221,423,949-960,1183-1186` | an in-app notification feed; notification belongs on a channel the user already reads, or to their agent |
| Activity log persisted into the cloud snapshot | `App.jsx:384,396`, `src/lib/runtimeState.js` | stores a notification history server-side for a feed nobody needs |
| Toasts doubling as a durable log | `App.jsx:423` — one call feeds the toast, the log and the unread count | the transient part is useful; the durable part is the feed above |
| Command palette | `src/components/ui/CommandPalette.jsx`, `App.jsx:911-915,935` | three commands, two of which are buttons already on screen. Its own comment says the surface it was built for is being removed; the footer still reads "TrustFlow Command Line v3.5" |
| Earner/Hirer mode toggle and its toast | `App.jsx:432,1174` | a UI concept with no counterpart in the data model — `performed_by` is per agreement — and no meaning at all on an agent surface |
| The three "GAINS" cards on the invite screen | `src/views/InviteView.jsx:11-41` | ~90 words of explanation on the counterparty's first screen; the judging rule is explicit about explanation volume |
| `OnboardingView` | `src/views/OnboardingView.jsx` | a gate before the first screen |
| `NeuralBackground` | `src/components/ui/NeuralBackground.jsx` | decoration |
| `send-acceptance-email` source | `supabase/functions/send-acceptance-email/` | an undeployed mailer: TrustFlow owning a channel, which the principle says it should not |

The first three are one feature and would go together. The last is already dead
code and is the clearest case.

---

## 7. Phasing

### Phase 1 — Kenji alone

| item | effort | migration |
| --- | --- | --- |
| `delegations` table, RLS (owner reads own), `token_sha256` unique | S | **yes** — new table, additive |
| TF006 trigger: refuse an event whose delegation is revoked/expired, under the row lock | S | **yes**, with its self-test at apply time, as TF002–TF005 have |
| Issue/revoke Edge Function, modelled on `reissue-guest-access` | M | no |
| `authAssurance.ts`: new credential, new level, `delegation` block, `assuranceMeaning` case | S | no |
| `log-event`: accept `x-trustflow-delegation`, resolve the actor from it, enforce scopes | M | no |
| MCP server: 6 tools, pasted token | M | no |
| `agreement_status` derivation shared with the web UI | M | no |
| `llms.txt`, `robots.txt` | S | no |
| Web UI: one button, one optional field, token shown once, revoke list | S | no |

Two migrations, both additive and reversible, both carrying their own apply-time
self-test in the pattern the four 2026-11-08 migrations established. Everything
else is functions and a server.

### Phase 2 — other users

| item | effort | migration |
| --- | --- | --- |
| OAuth 2.1 + RFC 9728/8414 discovery, an authorization server chosen | **L** | depends on the choice |
| Per-contract delegations for a counterparty's agent | M | no (the column exists from phase 1) |
| `Idempotency-Key` on acceptance and reissue | M | no |
| Cursor pagination with honest per-page chain reporting | M | no |
| `retryable`/`where` on every error, snake_case aliases | S | no |
| Rate limiting and `last_used_at` surfaced to the owner | M | no |

Phase 2 is dominated by the authorization server. Nothing else on that list is
hard, and none of it blocks phase 1.

---

## 8. Recommendation, including where it contradicts the brief

**Build phase 1 as listed. Paste a token; do not do OAuth.** Measured against
the judging rule, pasted-token onboarding is one button, one optional field and
three lines of text, and it works in every MCP client that can set a header.
OAuth is a consent screen, a client registry, redirect URIs and an authorization
server TrustFlow does not have. The MCP spec's OAuth requirements bind a
*protected server* that uses OAuth; they do not forbid a configured credential,
and phase 1 has exactly one user.

**Two places where I would push back on the brief:**

1. **"A record must state *party P said X via agent A under delegation D at
   T*"** — not quite, and the gap matters more here than anywhere else in the
   product. The honest sentence is §2.1's, and the thing that makes it
   defensible is `issuer_assurance`: capture the human's authentication once, at
   issuance, and carry it into every delegated event. Without that the record
   implies a human act behind every agent act, which is the exact failure
   `authAssurance.ts` was written to end.

2. **The agent surface should not be built before `agreement_status` has a
   single implementation.** The one tool Kenji will use hourly is the one that
   answers "where is this stuck", and the web UI cannot answer it today
   (`docs/proposals/web-ux-waiting-and-wrong-email.md` §1). Building that logic
   in the MCP server first would create a second implementation of the product's
   most-read derivation, in a different language, with the browser one still
   wrong — and this project's one production chain bug came from two
   implementations of a rule drifting apart (`_shared/eventRecord.ts:11-15`). So
   **do the Task 4 A1 work first**, in `contractStatus.js`, and have the MCP
   server import it. That is a sequencing claim, not a scope claim: it makes the
   agent surface cheaper, not larger.

**And one thing to resist.** TF006 makes delegated credentials exactly
revocable, while the guest token stays narrowly-but-not-exactly revocable
(§1.3). That asymmetry will be tempting to fix by routing guests through
delegations too. It should not be fixed that way in phase 1: a guest has no
account to issue against, and the per-contract delegation that would replace
their token is phase 2 work with a counterparty-facing onboarding story
attached. Record the asymmetry; do not paper over it.

---

## 9. Review verdict: FAIL, and what has to change before implementation

Codex reviewed the five load-bearing claims (2026-11-08, static, no queries).
**Verdict: FAIL — do not implement from this draft.** I verified each finding in
the source and agree with all of them. Three are blocking, and two of the three
are mistakes of exactly the kind this project has paid for before.

**B1. TF006 does not give exact revocation as designed (§1.3).** My claim was
that the trigger could refuse a revoked delegation "under the same lock the
other guards take". It cannot: the existing guards lock the **contracts** row,
while revoke updates the **delegations** row, so there is no common lock. The
sequence trigger-reads-live-D → revoke-commits → insert-commits survives. The
fix is for the trigger to lock the delegation row itself (`for update`, or at
least `for share`; `for key share` does not conflict with an UPDATE of the
non-key `revoked_at`) and re-test liveness on the locked row. The guarantee must
then be stated as a serialization point — *no new write is admitted under D
after a revoke commits* — not as cancelling a write already past the lock. The
expiry comparison also needs a stated clock: `now()` at statement time can admit
a delegation that expired while the statement waited.

**B2. The guest/delegation asymmetry is not fundamental (§1.3, §8).** I claimed
guest tokens cannot be checked in-transaction because the event does not carry
the token. True as implemented, but the fix does not need the secret: record a
non-secret credential **generation id** on the guest event and the same
lock-and-check works. So the asymmetry is an implementation gap, not a property
of the credential, and §8's advice to "record the asymmetry, do not paper over
it" rests on a distinction that does not hold.

**B3. Delegated reads do not run as the owner (§1.5, §3.1).** `auth.uid()` is
null for a request carrying the anon key plus a custom header, so
`parties_read_own_contracts` returns nothing. `agreement_status`, `list_events`
and `export_record` therefore **cannot be thin PostgREST wrappers** — each needs
a server endpoint that verifies the delegation and applies owner/contract/scope
itself, because service-role access bypasses the RLS that was doing that work.
This raises phase 1's effort materially and is the single biggest correction.

**B4. Idempotent replay bypasses every delegation check (§4.1).** `log-event`
returns an existing event before any insert (`index.ts:293-305`), so a
trigger-based TF006 never runs on a replay; and `idempotencyOutcome` matches on
type and `actor_id` only (`eventWriteRules.ts:43-50`), so with `actor_id` kept
as the owner, a **revoked** delegation, or one with narrower scope, replays
another delegation's event — and the authentication recorded on it still names
the first delegation. My "the matching rule stays exactly as written" was wrong:
the rule can stay, but liveness, owner, contract and scope must be checked
*before* the replay lookup, and whether cross-delegation dedup is wanted is an
open decision, not a default.

**B5. `issuer_assurance` does not make "P authorised this" provable (§2.1-2.2).**
It shows that a verified account session requested issuance. It does not show
the human's intent to delegate, that the secret was not stolen, or anything
about the individual act — issuance has no act-bound challenge either. The
honest claim is server-attested: *TrustFlow issued D on the authority of an
authenticated session belonging to P, and recorded acts by D's bearer.* So §2.1's
sentence needs its last clause weakened from "P authenticated at T₀" to "an
authenticated session of P requested D at T₀; the authentication itself was
earlier, and recoverable only when `amr` was present". Relatedly, §2.3's receipt
arithmetic is wrong: `issuer_assurance.seconds_since_authentication` is relative
to **issuance**, so it must be subtracted from `delegation.issued_at`, never
from the event's `created_at`.

Two narrowings rather than errors: the custom header is the right choice *given
that verify_jwt stays on*, not the only possible design; and "agent A acted" is
itself unverified, since the label is owner-chosen text — "the bearer of D,
under the label A" is what the record supports.

**The OpenAPI draft's `live` half needs these corrections**, all verified:
`wrong_state_for_event_type` (409, with `detail` and `hint`) and
`internal_error` (500) are missing from `log-event`; `internal_error` is missing
from the other three; `ownerJwt` is defined but never referenced by any
operation while global security names only `anonKey`; `securitySchemes.anonKey`
should say *legacy anon JWT* rather than "publishable"; `POST /rest/v1/contracts`
has no `requestBody` and omits `Prefer: return=representation`, without which it
does not in fact return the row and the invite token; the DELETE needs an
`id=eq.<uuid>` filter and `Prefer: count=exact` (and `count` is a
`Content-Range` header, not a body field); `truncated` means "the cap was
reached", which at exactly 500 events is true with nothing left; the invitation
digest check binds only when a non-empty digest is supplied; the two response
schemas in the `oneOf` have no `required` fields, so they are not actually
exclusive; and `Event.type` must be split into a write-input enum and a
read-event type, since stored rows include `dod.consent_recorded`,
`access.reissued` and the retired names.

**One code defect found by the review, reported and not changed:**
`log-event/index.ts:3` says it is "the only writer to the `events` table". That
stopped being true when acceptance moved into `validate-invite-token` so that
the acceptance and its evidence commit together.
