# Minimum-usable design (CONFIRMED 2026-11-19, Kenji — C1–C3, C5 and (a)–(c) decided)

_2026-11-18, Claude Task 141. Sources: `HANDOFF.md`, `Roadmap.md`, `docs/entry-contract.md`,
`Decisions.md` and the code at `918d25c` plus the uncommitted step-2 files. No code until confirmed._

## View: what the true minimum is

A human can already complete one deal end to end today: sign up, create, invite, accept,
record, export. What is missing for the 11-18 spine is **one thing: the owner's AI acting on
one deal with a credential that is scoped, revocable and named on the record** (today it
holds a full-account refresh token). AI2Human therefore needs delegated owner read and write,
a way for a human to issue, see and revoke that credential, and a doc the AI can follow.
AI2AI adds counterpart issuance and delegated acceptance. C5 also requires the server-side
create endpoint and closure of direct client-insert bypasses before release. Rank-1 commits
2–3 and display polish are not in the minimum.

## Who, and what "usable" means

- **Phase 1, AI2Human:** the owner human with their AI on one side, a human guest on the other.
- **Phase 2, AI2AI:** both sides have an AI, each holding a credential its own human issued.

**Done (Phase 1), checkable on production with bots acting as the parties** (the first deal
runs through bot simulations; nothing here waits for real users, `Decisions.md` 2026-11-18):
1. The owner signs up and creates a deal in the web app, then sends the invite.
2. From the web app, the owner gives their AI a credential for **that deal only**, with chosen scopes. The secret is shown once.
3. Using only that secret and the published doc, the AI reads the deal and records an event that is in its scope. An out-of-scope event or another deal is refused.
4. The guest accepts through the invite and sees the AI's event on their record.
5. Both exports verify, and the event records which credential (non-secret ID) wrote it.
6. The owner revokes the credential. The AI's next read or write is refused.

Phase 2 is the same, plus: the counterpart signs up with the invited email, issues their own AI a credential, and that AI accepts the deal.

## Trunk flow: what exists today

| # | Step | State | Where |
|---|---|---|---|
| 1 | Sign-up (verified email) | **Built** | `src/lib/earnerAuth.js` (anonymous sign-in, then email OTP); CAPTCHA on in production |
| 2 | Issue scoped, revocable agent credential | **Store built (schedule row 1, built 2026-11-19, verified 2026-11-20)**: store + issue/list/revoke RPCs and function, committed locally (`6942691`), not pushed or applied anywhere, gated off (`ENTRY_CREDENTIAL_ISSUANCE`). Expiry capped at 30 days. No UI (row 6) | `supabase/migrations/20261118214020_entry_agent_credentials.sql`, `supabase/functions/manage-entry-agent-credential/` |
| 3 | Create the deal | **Partial**: owner human currently inserts under RLS; C5 server-only path and closure of direct inserts are **not built** | `src/lib/contracts.js:39` `createContract`; `docs/entry-contract.md:15` |
| 4 | Invite the counterpart | **Built** (server-issued token, 72 h, shared out of band) | `contracts.js` `inviteUrlFor`; `validate-invite-token` |
| 5a | Accept (human guest) | **Built** (atomic acceptance + snapshot, guest capability) | `validate-invite-token`, Decisions 2026-09-28 |
| 5b | Accept (counterpart AI) | **Missing** (`counterpart_account_id` column exists in the row 1 migration, committed locally, not applied) | step 4 |
| 6a | Record events (owner session / guest token) | **Built** | `log-event`, `append_guest_event` (Task 58) |
| 6b | Record events (delegated) | **Missing** | `log-event` accepts only a JWT or a guest token |
| 7a | Read (delegated) | **Missing** | no endpoint takes a credential |
| 8 | Revoke | Guest reissue **built**; agent credential revoke **built in the row 1 store** (committed locally, not applied; no consumer enforces it until rows 4/5) | `reissue-guest-access`; row 1 RPC |
| 9 | Export / verify | **Built** (owner + guest, format-aware wording pushed `eee0889`) | `src/lib/auditExport.js`, `guestRecordExport.js`, `eventFormat.js` |
| 10 | Agent-facing instructions | **Partial**: protocol published, delegated calls absent | `public/agent-protocol.md`, `public/llms.txt` |

## Data and authority shape

**Records**
- `entry_agent_credentials` (held migration): id, contract_id, issuer_id, issuer_kind
  (`owner_account` | `counterpart_account`), secret_hash (SHA-256; secret returned once),
  invite_hash, scopes, created_at, expires_at (finite), revoked_at. Service-role only.
- `contracts.counterpart_account_id` (held migration): set only at delegated acceptance.
  The owner cannot hold it (check constraint).
- `events`: each delegated event additionally carries the credential id and issuer kind.
  **Inside the hash, under a new canonical version (C2, decided 2026-11-19).**

### Canonical v5 contract (OPEN for row 3: preimage not yet reproducible; C2 binding is decided, code not built)

The compact ECMAScript `JSON.stringify` object has these **keys in this exact order**:
`id`, `type`, `contract_id`, `actor_id`, `dod_hash`, `created_at`, `prev_hash`,
`payload_hash`, `agreement_hash`, `credential_id`, `issuer_kind`. The first nine
retain v4's canonical definitions: timestamp normalization, `GENESIS` for a missing
predecessor and null for missing digest fields (`supabase/functions/_shared/eventCanonical.ts:287–303`).
The last two are the server-derived nonsecret credential UUID and the literal issuer kind
(`owner_account` or `counterpart_account`), never the secret. For a delegated v5 event
both must be present, valid and match the live grant; missing, null or inconsistent values
fail closed. Existing v1–v4 rows and their bytes stay unchanged; nondelegated writers may
continue using v4. The exact v5 wire names and order above are a **proposal for independent
review**, not a claim that this format is implemented. Guest canonical blocks, owner/guest
exports and standalone verifiers must carry and recompute both fields; a reference vector,
tamper tests and reader-first deployment are required before a v5 write.

**Row 0 review (Codex T126, 2026-11-19): v5 preimage NOT yet pass.** The eleven-key list above is
incomplete under (c): the names, values and positions of `hash_version` and the domain separator
are unspecified, so nobody can reproduce the preimage independently yet. **Open item for row 3.**

Codex's 13-key candidate, a **proposal that needs independent review before the first v5
write; not adopted, not decided:**
`domain` (`"trustflow.event"`), `hash_version` (`5`), `id`, `type`, `contract_id`, `actor_id`,
`dod_hash`, `created_at`, `prev_hash`, `payload_hash`, `agreement_hash`, `credential_id`,
`issuer_kind`. Further row-3 points from that review: say whether nondelegated writers
*stay* v4 or may write v5 with both authority fields null (and forbid a mixed null pair);
treat missing inputs in an export as unverifiable, never as a pass; publish a reference
vector with per-field tamper tests.

**Open — representation (C2 wording vs design):** `Decisions.md` C2 says the credential reference
goes inside the "canonical payload"; this design puts it in top-level preimage fields. Row 3 must
pick one authoritative representation. If it is duplicated, the two must match exactly.

**Decided (C2):** `credential_id` and `issuer_kind` are inside the hash.

**Decided 2026-11-19 (Kenji, `Decisions.md`; were Codex T125 proposals).** These cannot be
rolled back once the first production row exists:

- **(b) Trunk — grant evidence survives.** Revocation, expiry and draft deletion never delete
  or rewrite a grant's nonsecret id, issuer account/kind, deal, scopes, issuance, expiry or
  revocation time. **Delete rule:** a draft with any grant (revoked or expired included)
  cannot be deleted. No grant outlives its deal, and the grant FK to `contracts` is not
  changed to cascade or set null. The held migration's FK already refuses by default. The
  build should refuse explicitly, under the same lock as the existing events check, with a
  clear error rather than a raw FK violation.
- **(c) Trunk — v5 preimage fixed before the first v5 write:** the key order above plus an
  explicit `hash_version` and a domain separator inside the hashed object, so a v5 preimage
  can never be read as another version's. Exact names and positions of those two fields are
  set in piece 3 and reviewed before any write.
- **(a) Later — no immutable creation snapshot/event for now.** The acceptance snapshot
  already fixes the agreed terms in the hash. A creation snapshot would only keep the terms
  first offered, and adding it later loses that only for deals created before it ships.

Credential ID and issuer kind alone do not prove a grant was valid or establish a verified
writer. Do not silently delete or rewrite existing grants or events.

**Who may do what**

| Actor | Create deal | Issue/revoke credential | Read deal | Accept | Append event |
|---|---|---|---|---|---|
| Owner human (session) | yes | own `owner_account` only | yes | no | yes (role/state rules) |
| Owner AI (credential) | no | no | if `read` | never | only listed event types |
| Guest human (bearer) | no | no | yes (token) | yes (invite) | yes (token) |
| Counterpart human (verified, email = invite) | no | own `counterpart_account` only | — | — | — |
| Counterpart AI (credential) | no | no | if `read` | if `accept` + invite | only listed event types |

Every delegated call is checked under the contract lock: secret, deal, issuer, scope, expiry and
revocation, failing closed. The owner session is never used as a fallback.

## Contradictions found

1. **Decisions.md 2026-11-16 vs entry contract:** **Resolved (C1, 2026-11-19): the entry contract governs; the proposal is superseded for delegation.** Decisions says delegation follows
   `docs/proposals/agent-first-access.md`. That proposal has account-wide keys
   (`contract_scoped` optional), `read` always granted, a `create_agreement` scope and an
   `issuer_assurance` column. The entry contract forbids the first three, and the held code has
   no `issuer_assurance`.
2. **Where authority is recorded (C2):** **Resolved (2026-11-19): inside the hash, new canonical version + verifiers.** The entry contract §5 binds the credential id into the
   hash under a new canonical version. `codex-report-121` says the hash inputs stay unchanged.
   Decisions 11-16 puts the `server_asserted_v1` marker outside `event_hash`. Code:
   `HASH_VERSION = 4`, supported 1–4 (`_shared/eventCanonical.ts:38,55`).
3. **Email match rule:** **Resolved (C3, 2026-11-19).** The counterpart account binding matches
   `lower(btrim(invited_hirer_email))` against `lower(btrim())` of the account's verified email,
   as the held RPC already does. The same normalisation applies everywhere an email is compared,
   including any RLS `hirer_email` check. _(Correction, Task 147: per migration source there is
   none today. `20261011212432` replaced `party_read_contract_events` with an owner-only policy,
   so the case-sensitive `=` cited here was historical. Effective policies are still verified in
   the E2E rehearsal. Do not reintroduce guest access by self-claimed email just to normalise it.)_ `invited_hirer_email` (what the owner invited) and `hirer_email` (what
   the guest claimed at acceptance) stay two different facts (migration `20260923000001`);
   normalising the comparison does not make a self-claimed email proof of authority.
4. **Function count:** HANDOFF says "four, and only four" Edge Functions. The held step-2 code
   adds a fifth (`manage-entry-agent-credential`). `smoke-production.mjs` assumptions need checking.
5. **Create endpoint:** **Resolved (C5, 2026-11-19):** build the server-side owner-session
   endpoint and close direct client insert paths. `codex-report-121` and the current code
   use a client insert; those are superseded as target behavior, not evidence of implementation.
6. **Guest API label:** entry contract says the v1 `server_attested` label must not reach
   external agents without a fix or a truthful client interpretation. Roadmap parks rank-1
   commits 2–3. That matters for Phase 2, where the counterpart AI reads the guest API.
7. **Scoped key timing:** resolved. HANDOFF's old "deferred until there are outside users" note
   is superseded: the 11-18 spine builds per-deal credentials now, and nothing waits for
   outside users (`Decisions.md` 2026-11-18).
8. **No UI or doc in the contract:** the contract specifies issue/revoke as server operations.
   A human gets a session only through the browser (CAPTCHA), so without a UI no real user can
   issue a credential. Memory note 2026-11-10 says the public agent spec lacks endpoints and auth.
9. **Stale status:** Decisions 2026-11-16 says the TRUNCATE revoke is "not yet applied anywhere",
   but it was applied to both projects (Tasks 107/109). Decisions 2026-11-18 says commit 1 is
   "not pushed", but it was pushed at `eee0889`. HANDOFF's header says "Last updated 2026-11-14".
10. **Withdraw before acceptance:** the old Roadmap called it "decided 2026-09-25". HANDOFF says
    it is unspecified. Not in the minimum either way.
11. **Payment scopes are not payment:** the held scope list includes `payment.reported/acknowledged/disputed`.
    These are claims that Decisions 2026-11-06 keeps in scope, not payment execution. Listed so
    nobody "fixes" it as a parked-payment leak.

## Out of scope

- Payment execution / Stripe Connect
- Agent-created deals (owner human uses the C5 endpoint)
- Account-wide or cross-deal credentials; credentials managing credentials
- Guest-bearer-derived delegation
- Creation as an event or creation snapshot — deferred as (a), 2026-11-19
- Rank-1 commits 2–3 (Phase 1); Phase 2 needs only an honest warning (C6)
- `server_asserted_v1` marker, Ed25519 signatures, external timestamps
- Naming actors on record screens (stays "a party")
- Withdraw-before-acceptance / cancellation semantics
- Identity verification beyond the account and invite binding
- Wording and interpretation polish; `App.jsx` decomposition
- MCP server; scores, ratings, reputation
- Production test-data cleanup; dropping the empty payment schema

## Work breakdown (remaining, in schedule order)

IDs match `docs/schedule.md` baseline rev 3. Schedule row 4 is 2d and covers 4a (the shared
delegated-auth resolver) and 4b (owner append). Sizes match the schedule.

| # | Piece | Size |
|---|---|---|
| — | ~~Kenji decides C1–C3, C5~~ Done 2026-11-19 (not a build task) | — |
| 0 | Design/security cross-review: C5 boundary, v5 preimage incl. (c), grant retention and delete rule (b). Step-2 code stays on hold | 1d |
| 1 | Take step-2 code off hold: one-deal issue/list/revoke store aligned with C1–C3 (`lower(btrim())`, verified counterpart binding, no `issuer_assurance`); grant rows never deleted; draft delete refused when grants exist (b), explicit check under the delete lock; issuance stays off | 1d |
| 2 | **C5:** server-side owner-session create endpoint; switch client; revoke direct table/column insert; test REST/RPC/GraphQL bypasses and mixed rollout | 2d |
| 3 | **Required (C2):** canonical v5 (fixed key order, `hash_version`, domain separator, credential id + issuer kind inside the hash; (c)) in all readers, both exports, `eventFormat.js`, standalone verifier, reference vectors. **Readers before any v5 write** | 1d |
| 4a | **Shared delegated-auth resolver:** secret → live grant under the contract lock; deal, issuer, scope, expiry, revoke; fail closed, no session fallback | 1d |
| 4b | Delegated owner append in `log-event`: v5 write with credential id + issuer kind; replay keyed to the grant | 1d |
| 5 | Delegated owner read (deal projection + events) with revocation boundary; C3-normalised RLS `hirer_email` checks | 1d |
| 6 | **Required (in the minimum, 2026-11-19).** Minimal owner UI: issue (scopes, expiry), show the secret once, list, revoke | 1d |
| 7 | `agent-protocol.md` / `llms.txt` for delegated calls, plus deterministic bot onboarding/E2E bootstrap (CAPTCHA not weakened) | 1d |
| 8 | Phase 1 bot E2E: server create, issue, read/write, guest accept, both exports, v5 recompute; negatives (no direct insert, wrong deal/scope, expired, revoked, revoke race, replay) | 2d |
| 9 | Phase 1 production release (separate OK): migration, functions with Docker, frontend, smoke | 1d |
| 10 | Counterpart authenticated invite entry + issuance UI (C3 verified-email match, distinct owner) | 1d |
| 11 | Delegated acceptance: invite + grant + shown terms atomic under lock, persist `counterpart_account_id`, v5 acceptance; no bearer fallback | 2d |
| 12 | Counterpart delegated read/append/revoke (reuses 4a, 4b, 5) + guest API v1 label handling (C6) | 1d |
| 13 | Phase 2 bot E2E + negatives | 2d |
| 14 | Phase 2 production release (separate OK) | 1d |

**Rev 3 (2026-11-19):** the rev 2 mismatch is resolved. Schedule row 4 was 1d for 4a + 4b, and is
now 2d, so M1 moves from 2026-12-03 to 2026-12-04. Proposal (a) is deferred, so piece 2 has no
creation-snapshot work. The other sizes already matched rev 2.
