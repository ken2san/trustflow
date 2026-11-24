# Row 4 plan: owner delegated append and the shared resolver

_Claude Task 227, 2026-11-23; revised in Tasks 228–231 after Codex T187–T190, and in Task 232 with Codex T191's two should-fixes (T191: YES). **Signed off by Kenji 2026-11-24 10:57 ET:** Q1–Q6, the agreed design points including the `entry_agent_grant` label, and row 4 ownership changed to Claude builds / Codex reviews (`Decisions.md`). Sources:_
- _`docs/schedule.md` (rev 3, row 4)_
- _`docs/minimum-usable-design.md` (4a/4b)_
- _`docs/entry-contract.md` items 3–6_
- _`Decisions.md` 2026-11-09, 11-16 and 11-19_
- _`HANDOFF.md` through T226_
- _the code at `0ce3b64`: `log-event/index.ts`, `_shared/eventWriteRules.ts`, `_shared/eventCanonicalV5.ts`, migrations `20261114120000`, `20261118214020` and `20261122130000`_

## Goal

The owner's AI holds one `owner_account` grant (row 1 store) for one deal. With that secret alone it can append an event type allowed by the grant, through `log-event`.

- **Format:** every such event is written as **v5**, with the grant's nonsecret `credential_id` and `issuer_kind` inside the hash (C2, built in row 3).
- **Authorization:** every check runs in the database, under the contract lock, and fails closed.
- **No fallback:** there is never a fallback to the owner session or the guest bearer.
- **What the record claims:** the actor was someone holding this grant. It doesn't claim that the human owner acted.

## What counts as done (row 4, on E2E)

1. **A valid grant appends.** A valid `owner_account` grant whose scopes include an allowed type appends that event to its own deal.
   - **Stored row:** `hash_version = 5`, with `credential_id` and `issuer_kind` equal to the grant's.
   - **Readers:** the actual E2E row recomputes as `match` in every row 3 reader: the strict slice, guest response v2, the owner export and the receipt CLI. Server-side checks are reported separately from what is available locally to the guest.
2. **Everything else is refused, and nothing lands:**
   - another deal, or a deal that doesn't exist (the same 403)
   - a type outside the grant, or outside the row 4 allowlist
   - an expired or revoked grant, or a wrong, blank, malformed or repeated grant header
   - a grant whose issuer is no longer the deal's owner
   - a grant presented together with a user JWT, a guest token or a second grant
   - a role or state that the owner-session path would also refuse, in both `performed_by` directions
3. **Revoke vs append.** Admission means passing the resolver under the contract lock. Whichever takes the lock first wins.
   - **After revoke commits:** nothing new is admitted, a fresh write or a fresh replay alike.
   - **The only "in-flight" case:** a request admitted before the revoke whose HTTP reply arrives after it.
   - **Queuing doesn't count:** being queued on the lock before revoke is not admission (`entry-contract.md` item 6).
4. **Replay is bound to the grant.**
   - **Same grant:** the same key returns the original event.
   - **Other writers:** the same key from another grant, the owner session or a guest is a 409 with no row returned. This holds in both directions, including the owner path's own lookup, TF001-twin and unique-violation branches.
5. **Records stay intact:**
   - nondelegated writers stay v4
   - existing rows are untouched
   - the guest path, the owner path and all row 1–3 tests pass
6. **v5 inserts are confined in the database to the reviewed writer.** That holds even after the CHECK is gone; see §4c.
7. **Production is untouched in row 4.** Opening v5 writes there is row 9, with its own approval.

**Out of row 4:** delegated acceptance (the `accept` scope), delegated reads, and any payment execution. Payment events stay claims (minimum-usable-design §11).

## Order: readers first, then the writer, then the gate

Row 3 already shipped every reader, on E2E and on production. This row goes: resolver → writer (built and proven with v5 still blocked) → database enforcement proven → gate opened on **E2E only**.

### 4a. Admission and the shared resolver (about 1d)

**Admission in `log-event`: two credentials, kept apart**
- **Transport credential.** `log-event` is `verify_jwt: true` (`HANDOFF.md:55–59`), and that setting stays.
  - A delegated request carries `Authorization: Bearer <public anon key>` to pass the gateway.
  - The function checks that this value is exactly the configured public key, and treats it as transport only. It is never owner authentication.
  - Any other bearer, such as a user JWT, makes the request mixed.
- **Grant credential.** `x-trustflow-grant: <credential_id>.<secret>`.
  - The format is exactly a lowercase UUID, one `.`, then the secret's fixed length and charset (row 1's issue format).
  - Total length is capped before parsing.
  - It is never accepted in a URL or the body.
- **Routing.**
  - **A present grant header commits the route.** Once the header is present (blank, malformed, repeated, comma-joined), the request takes the delegated route. It never falls back to the owner or guest route.
  - **Dispatch comes first.** It happens **before** the legacy contract lookup and its 404 (`log-event/index.ts:310–334`), and before `resolveActor`.
  - **Mixed credentials are refused.** That means the grant together with `x-guest-access-token`, a non-anon bearer, or a second grant value.
- **Answers.**
  - Every authorization refusal is one public `403 delegation_refused`: missing deal, wrong deal, wrong or unknown grant, bad secret, malformed header, mixed credentials, revoked, expired, issuer no longer owner, scope, allowlist.
  - Request-body validation stays 400, as today, and runs before admission so it reveals nothing about grants.
  - Flag off is `503 delegated_append_unavailable`. Chain and key conflicts are 409.
  - The internal refusal reason goes only to a redacted structured log line (reason code, contract id, credential id), never to the response.
- **Redaction.**
  - The secret is hashed (SHA-256) in the isolate. Only the hash goes to SQL.
  - The secret is never logged, echoed or stored, and never appears in an error string or RPC response.
  - The request headers are never logged.
  - **E2E check, canary first.**
    1. A request carries a noncredential random canary in `x-trustflow-grant`, and the function and gateway logs are searched for it.
    2. Then one disposable test grant is used, its secret is searched for, and the grant is revoked straight after, whatever the result.
  - **Stop rule.** If the canary or the secret appears in any platform log, row 4 stops: revoke the exposed grant at once, record it, and go to Kenji.
  - **A replacement transport is not chosen in advance.** End-to-end redaction must be demonstrated first. Moving the credential to the body would need its own redaction proof and approval.
- **CORS.** `x-trustflow-grant` is added to `ALLOW_HEADERS` (`_shared/cors.ts`) for allowed origins only, with a preflight test.

**Resolver: migration A, `2026112x000000_entry_agent_resolver.sql`**
- **The function** (built in Task 232, `20261124120000_entry_agent_resolver.sql`). `private.resolve_entry_agent_grant(p_contract_id uuid, p_credential_id uuid, p_secret_hash text, p_operation text, p_for_insert boolean)` returns `(status text, issuer_id uuid, issuer_kind text, now timestamptz)`. `p_for_insert` is true for append, which also takes the gate lock (§4c); replay passes false. It takes the contract id rather than the caller's row, and re-takes the contract lock itself, so the lock order and the fresh read never depend on the caller.
- **An unexposed schema.**
  - `private` is not in the API's exposed schemas.
  - `revoke all on schema private` and `revoke execute` on the function from `public`, `anon`, `authenticated` and `service_role`.
  - `security definer`, `set search_path = ''`.
  - Only the two writer RPCs below (owned by the same role) call it.
  - A test proves that a direct call through PostgREST and a direct call as `service_role` both fail.
- **Locks and the clock.** The calling writer has already taken `contracts … for update`; the resolver's own `for update` on the same row is then a no-op re-entry. The resolver takes `entry_agent_credentials … for share`. When `p_for_insert` is set, it then takes `private.v5_write_gate … for share`.
  - Only after the **last** lock has been granted does it read `clock_timestamp()`, **exactly once**.
  - That one sample (`now`) is used for expiry and is returned for the created-at window, so no time check can come before a lock wait.
  - Revoke (`20261118214020:131–143`) takes contract `for update`, then grant `for update`, so the two serialize on the contract row in the same order.
  - The writer RPCs require READ COMMITTED and refuse otherwise, as `20261108134500` does for the guest RPCs. The re-read after the lock is only fresh under it.
- **Checks, all against locked rows:**
  - the grant exists and its `contract_id` matches
  - `secret_hash` matches
  - `issuer_kind = 'owner_account'`
  - the deal's `earner_user_id` still equals `issuer_id`
  - `p_operation` is in `scopes` **and** in the row 4 allowlist
  - `revoked_at is null`
  - `expires_at > now` (the single sample)
  - for append only, the gate row exists and is open (`gate_missing` / `gate_closed`)
- **Result.** `ok`, or one internal refusal code, checked in this order: `malformed`, `grant_unknown` (no deal, no grant, or another deal's grant), `secret_mismatch`, `issuer_kind`, `issuer_not_owner`, `revoked`, `expired`, `scope`, `allowlist`, `gate_missing`, `gate_closed`. A refusal returns no issuer.

**Tests**
- **`tests/unit/delegatedAuth.test.js`:**
  - **Parsing:** exact format, length cap, blank, repeated and comma-joined headers.
  - **Credential mixing:** mixed-credential refusal; the anon key accepted as transport; a user JWT refused as mixed.
  - **Redaction:** the secret is absent from every response, error and log string.
- **`tests/sql/entry_agent_resolver.sh`** (local Docker, the `create_entry_contract.sh` pattern):
  - every refusal code
  - direct `execute` denied to `anon`, `authenticated` and `service_role`
  - one clock sample, read after the last lock
  - expiry while waiting on **any** lock:
    - contract held past `expires_at`
    - grant held `for update` by a revoke past `expires_at`
    - gate held by an operator close past `expires_at`
  - refusal under REPEATABLE READ
- **Hosted E2E, before the writer is enabled:** grant-only admission through the real gateway (anon key plus grant reaches the function); the CORS preflight; and the log-redaction search.

**Review points (Codex):** the lock order against revoke, that no client or service-role path reaches the resolver, the uniform refusal, the secret in clear never reaching SQL or logs, and the gateway behaviour.

### 4b. Delegated owner append (about 1.5–2d)

**Migration B, `2026112x000001_delegated_owner_append.sql`.** It adds `append_delegated_event(...)` and `replay_delegated_event(...)` in `public`, as `security definer` and `search_path = ''`, executable by `service_role` only. The modelled shape is `append_guest_event` / `replay_guest_event` (`20261114120000`). The same migration adds the ticket and triggers described in §4c, while the CHECK is still present. The gate row itself is created closed by migration A (Task 232), because the resolver reads it.

**Steps inside `append_delegated_event`, in this order**
1. Assert READ COMMITTED.
2. Lock the contract (`for update`).
3. Call the resolver with `p_operation = type, p_for_insert = true`. It:
   - takes the grant `for share`
   - takes the gate row `for share` (§4c)
   - samples `now` once
   - checks the grant and expiry
4. Check the created-at window with that `now`.
5. Run the twin lookup.
6. Do the binding checks, including the **reserved-field check** against the resolver result and the locked contract ("Reserved fields" below). Any mismatch raises here, before the ticket exists and before any insert.
7. Issue the ticket.
8. `INSERT … RETURNING`, then the comparison.

All locks are held until commit.

**Steps inside `replay_delegated_event`**
1. Assert READ COMMITTED.
2. Lock the contract.
3. Call the resolver with `p_for_insert = false`. It takes the grant `for share`, samples `now` once and checks expiry.
4. Look up the key.

**No gate lock and no gate check in replay.** The database gate stops *inserts* only. An authorized same-grant replay returns its existing evidence even while the gate is closed. The HTTP flag `ENTRY_DELEGATED_APPEND` still refuses the whole delegated route, replay included, with a 503.

A missing contract is a refusal at step 2 in both, the same refusal as a bad grant.

**Replay**
- **Namespace.** It stays `events_idempotency_idx` on `(contract_id, idempotency_key)` (`20260924000001:52–55`); no new index.
- **Fresh replay.** `replay_delegated_event` runs steps 1–3 first, so a fresh replay after revoke or expiry is refused before any lookup.
- **Matching the occupant.** It then reads the occupant of `(contract_id, key)`. The occupant is a replay only if `type = p_type`, `actor_id = issuer_id`, `credential_id = p_credential_id`, `issuer_kind = resolved`, and `hash_version = 5`. Any other occupant gives `conflict`, and the RPC returns no row.
- **Twins.** `append_delegated_event` repeats the same lookup under its lock before inserting, to catch a twin.
- **Owner-session sites (a required change; Q3 depends on it).** All three call `ownerKeyedOutcome`: the lookup (`index.ts:371–386`), the TF001 twin (`:639–650`) and the 23505 race (`:664–681`). Today it compares only type and actor (`eventWriteRules.ts:43–69`). With the shared owner UUID, it would hand the owner session the AI's row.
  - `idempotencyOutcome` gains `credentialId: string | null` in its operation argument.
  - A row is a replay only if `existing.credential_id` matches (`null` for the owner session).
  - All three sites pass `credentialId: null`.
  - A delegated row is therefore a 409 to the owner session, including in the unique-violation and readback branches. Unit tests cover each site.
- **Guest path (no code change).** `guest_append_replay` matches `actor_id = 'guest:<email>'`. A delegated owner row carries the issuer UUID, so it can never match. A delegated `counterpart_account` grant (not row 4) would carry the counterpart account id, which also can't match.
  - Tests prove both directions: a guest key against a delegated row, and a delegated key against a guest row.

**Binding: one atomic, re-derived insert**

| v5 preimage field (`eventCanonicalV5.ts:25–33`) | Where the value comes from, re-derived or checked under the lock |
|---|---|
| `domain`, `hash_version` | constants `trustflow.event`, `5` |
| `id` | proposed by Edge (UUID). SQL checks the shape and that it is unused; the PK enforces it |
| `type` | request; checked against scope ∩ allowlist, `ROLE_REQUIRED` for the locked owner role (both `performed_by` directions) and the locked state. `enforce_performance_order` still runs on insert |
| `contract_id` | the locked row |
| `actor_id` | the resolver's `issuer_id`, which equals the locked `earner_user_id` |
| `dod_hash` | inputs: the locked contract's DoD fields. SQL checks that the inputs Edge hashed equal the locked values |
| `created_at` | proposed by Edge. SQL checks it is v5-canonical, then calls `private.v5_created_at_ok(created_at, now, tip.created_at)` with the single post-lock sample: `now − 60 s ≤ created_at ≤ now`, both bounds inclusive, and `created_at > tip.created_at`. `enforce_event_created_at_follows` still runs on insert. See "Clock" below |
| `prev_hash` | the locked tip, ordered the same way as the existing tip read, or explicit `GENESIS` when there are no events. A mismatch gives `chain_conflict` |
| `payload_hash` | inputs: the **final recorded tree** (below), which is stored verbatim. Edge hashes it with the existing TS function |
| `agreement_hash` | **Draft:** explicit null agreement evidence. **After acceptance:** the current locked terms, read in the field set of the contract's accepted snapshot version (Decisions 2026-11-09, which keeps the drift signal). SQL checks that the inputs Edge hashed equal the locked values under that version |
| `credential_id`, `issuer_kind` | the resolved grant, never the request body. A body that carries either is a 400 |

The stored non-preimage fields are also checked:
- `payload`: the final recorded tree, verbatim
- its reserved fields: the exact key set **and every value**, checked against the resolver result and the locked contract ("Reserved fields" below)
- the accepted snapshot version the row records, which must be the locked value
- `idempotency_key`

**Who computes the inner digests.** `log-event`, running with the service role, is the restricted RPC's **only trusted caller**. It computes `dod_hash`, `agreement_hash` and `payload_hash` with the existing TS functions that every reader verifies with.
- **Checked under the lock:** SQL compares the exact typed DoD inputs and the agreement-term inputs with the locked rows, and stores exactly the final recorded tree that was digested.
- **Not proven by SQL:** the inner digests themselves. Recomputing the outer hash over them doesn't prove them.

This is the accepted condition of pushback 1 (T188).

`event_hash`:
1. SQL re-derives the outer v5 canonical. It is a flat JSON of validated ASCII values in fixed key order, so SQL can produce the identical string.
2. SQL computes `sha256` and compares it with Edge's `event_hash`.
3. A parity test runs shared fixtures through both TS and SQL.

`INSERT … RETURNING *`:
- The typed returned row is compared field by field with the proposal.
- Any difference raises and rolls back the whole transaction: from a trigger, a default or a cast.

What Edge does:
- **Builder:** a dedicated `buildDelegatedEventV5` (it uses `buildEventCanonicalV5`).
- **Context:** a service-role pre-read of the tip, the contract terms, the accepted version and `performed_by`, then one call to the RPC. No resolver output is available to Edge, and none is needed (below).
- **Stale reads:** any check failure from a stale pre-read returns `context_changed` or `chain_conflict`. Edge rebuilds and calls again, within `MAX_CHAIN_RETRIES`, and every call re-authorizes from scratch.
- **No generic insert:** a v5 candidate never goes through the generic `.insert()` or `buildEventRecord`.

**One final recorded tree (Task 230, closing Codex T189's must-fix).** The payload is built once, in this order, and the same object is hashed, sent and stored:
1. **Parse once.** `JSON.parse` of the request body, so an ordinary duplicate key is last-key-wins. Nothing re-parses the body later.
2. **Domain check** on the client tree (below).
3. **Strip reserved fields.** Every top-level key beginning with `_` is removed, the same rule as `partyAssertedOnly` (`eventRecord.ts:70–74`). So a caller-supplied `_auth_method`, `_authentication`, `_actor_role` or `_role_in_agreement` never survives, whichever duplicate won the parse.
4. **Add the expected server fields**, never from the request. Edge has no resolver result at this point (the resolver runs only inside the RPC, after the locks), so it builds what the route rules say a successful delegated append must record, plus the pre-read `performed_by`. The RPC then verifies every one under lock. The four fields are listed under "Reserved fields" below. No acceptance facts, because deal acceptance is out of scope (Q2).
5. **Domain check again** on the assembled tree, so the server fields obey the same rule.
6. **Hash, send, store.** Edge hashes that final tree with `payloadHash` (sorted keys, `stableStringify`) and sends `JSON.stringify(tree)`; the RPC stores it as jsonb and checks the reserved fields (binding table above). Neither what was hashed nor what is stored can carry a duplicate key.
- **Evidence.** The raw request body is not evidence; the stored final tree is, and the response returns it.

**Reserved fields (Task 231, closing Codex T190's must-fix).** Edge predicts them; the RPC proves them. The tree is never rewritten in SQL, so the one hashed tree is the one stored.

| Key | Edge builds it from (before the call) | The RPC requires (after the resolver, under lock) |
|---|---|---|
| `_actor_role` | the route rule: only `owner_account` grants are admitted, so the actor is `'earner'` | resolver `issuer_kind = 'owner_account'` and `issuer_id` = locked `earner_user_id`, and the value is exactly `'earner'` |
| `_role_in_agreement` | `roleInAgreement('earner', performed_by)` (`eventRecord.ts:54–60`) over the pre-read `performed_by`, which Edge also sends as the typed proposal `p_performed_by` | first, consistency with the **proposal**: `p_performed_by` is exactly `'creator'` or `'counterparty'` (the persisted domain, `20260926000000:26–31`), and the value is `'receiver'` for `'counterparty'` and `'performer'` for `'creator'`; then, freshness: `p_performed_by` equals the **locked** `performed_by` |
| `_auth_method` | the route constant `'entry_agent_grant'`, from a new grant branch in `legacyAuthMethod` | exactly `'entry_agent_grant'` |
| `_authentication` | `assuranceForRecord` over a fixed grant-possession assurance: `assurance 'bearer_capability'`, `credential 'entry_agent_grant'`, `method`, `aal` and `seconds_since_authentication` null, `recent_authentication false`, `act_bound_authentication false`, `act_binding_mechanism null`, and the window constant | jsonb equality (`=`, so key order and whitespace don't matter) with the same fixed object, held as one SQL constant |

- **Exact key set.** The set of top-level keys with `left(key, 1) = '_'` must equal these four: none missing, none extra.
- **Answers (Task 232, Codex T191 should-fix 1).** The checks run in this order, so a role mismatch alone is never read as staleness:
  1. **Well-formedness of the proposal**, with no reference to locked state: the exact key set, the three fixed values, `p_performed_by` in the persisted domain, and `_role_in_agreement` consistent with `p_performed_by`. Any failure is the non-retryable `reserved_fields_mismatch`, logged loudly, and a 500 if it reaches the route. That holds even when the context is also stale.
  2. **Freshness:** a well-formed proposal whose `p_performed_by` differs from the locked value returns `context_changed`. Edge rebuilds from a fresh pre-read within `MAX_CHAIN_RETRIES`.
  3. **Authorization under the locked role:** the event type's required role (`ROLE_REQUIRED`, `log-event/index.ts:162–170`) and the state rules are checked against the **locked** contract, as on the owner path. A well-formed, fresh proposal that the locked role doesn't permit is refused, never retried into success.
  - The proposal is checked for drafts too, where agreement evidence is null: `performed_by` is a column of the draft, not of the accepted snapshot.
  - Every refusal raises before the ticket and the insert, so nothing is stored.
  - **One helper.** Steps 1 and 2 are a pure `private.v5_reserved_fields_status(p_payload jsonb, p_proposed text, p_locked text)` returning `ok`, `reserved_fields_mismatch` or `context_changed`. No client may revise `performed_by` after creation (`20260926000000:32–35`), so a flip between pre-read and lock needs a privileged write; the classification is tested on the helper in isolation rather than by staging one.
- **Retry exhaustion stays distinguishable.** The window check returns its own internal code, `clock_window`, not `context_changed`. When `MAX_CHAIN_RETRIES` runs out, Edge answers from the **last** refusal: `clock_window` gives 409 `clock_skew`; `context_changed` gives 409 `context_changed`; a chain mismatch gives 409 `chain_conflict`.
- **No secret or grant id in the payload.** `credential_id` is already a bound column; the grant's id is not repeated in `_authentication`.
- **Readers (Task 232, Codex T191 should-fix 2).** `'entry_agent_grant'` is a new `_auth_method` value and a new `PresentedCredential`. Hash recomputation alone can pass while a reader hides or misstates the label, so each surface gets its own assertion:
  - **`authAssurance.ts`.** The new `PresentedCredential` and `legacyAuthMethod` branch leave the existing guest and account-session mappings unchanged (unit test over all existing inputs). If `assuranceMeaning` is used for grant evidence, it gets an explicit grant branch, so its invitation wording can't describe a grant.
  - **Receipt.** Receipt V2 copies `_auth_method` and `_authentication` as recorded (`scripts/lib/receiptV2.mjs:55–56`). A test over the real delegated row asserts the emitted receipt has `_auth_method = 'entry_agent_grant'`, `_authentication.credential = 'entry_agent_grant'` and `_authentication.seconds_since_authentication = null`.
  - **Guest event view.** `filterPayload` drops every `_` key (`guestEventView.ts:94–108`), so the label never reaches the guest through `payload`. The view gains a dedicated server-derived field beside `actor`, `recorded_credential`, read from the stored `_authentication.credential` (null for rows without one). A test asserts it is `'entry_agent_grant'` for the delegated row, and unchanged values for existing guest and owner rows.
- **Why not a duplicate-aware parser.** One would need a new dependency, or a hand-written parser at an auth boundary. *Codex accepted this in T189.*

**Domain (delegated only):** strings, safe integers, booleans, null, and arrays and objects of these.
- Floats and unsafe integers are refused with a 400.
- So are `\u0000` and lone surrogates, which jsonb rejects.

**Clock.** `now` is the resolver's single sample, read after the contract, grant and gate locks.
- **When the window or tip check fails:** the RPC returns `clock_window`. Edge remakes the whole proposal (fresh stamp, tip and id) and calls again, within `MAX_CHAIN_RETRIES`. Each attempt re-authorizes.
- **When retries run out on it:** 409 `clock_skew`, kept separate from an exhausted `context_changed` (above).
- **Measured before enabling:** the Edge-to-database offset is logged on E2E. An Edge clock persistently ahead of the database would refuse every delegated write.

**Pushback 1 (T228), accepted with conditions in T188:** the dod, agreement and payload digests are not re-implemented in SQL. Their *inputs* are compared under the lock, and the digest code stays single-source in TS. A second SQL implementation of those canonical forms is the drift class `eventWriteRules.ts` warns about, and the risk the lock closes is stale inputs. The conditions are the trusted-caller statement, the single final recorded tree, and the parity and round-trip tests.

**`log-event/index.ts`: a third admission path**
- **Flag.** Behind `ENTRY_DELEGATED_APPEND` (default off; 503 when off, the same pattern as `ENTRY_CREDENTIAL_ISSUANCE`).
- **Placement.** Dispatched first (see 4a).
- **Unchanged.** The owner-session and guest write paths keep their code and hash version. Their one change is the `credentialId` replay guard.

**Tests**
- **New `tests/sql/delegated_append.sh`:**
  - **Gate and enforcement:** see §4c, "Gate lock tests" and "Proofs before the CHECK is dropped".
  - **Replay while the gate is closed:** a same-grant replay returns the existing event. A new append is refused with `gate_closed`.
  - **Created-at window:**
    - `private.v5_created_at_ok` at the exact bounds: `now − 60 s` passes and 1 µs older fails; `now` passes and 1 µs later fails. A stamp equal to the tip's fails.
    - Skew: an Edge stamp ahead of the database clock, and one more than 60 s behind it.
    - Retries run out on `clock_window`, giving `clock_skew` (not `context_changed`).
  - **Parity and round trip:**
    - TS/SQL outer-canonical and hash parity over shared fixtures.
    - JSONB round trip for every allowed payload shape: `stableStringify` and `payloadHash` are equal before and after reading back.
    - **Duplicate-key and reserved-field fixture:**
      - an ordinary duplicate key stores only the last value;
      - duplicate and single caller-supplied `_auth_method`, `_authentication`, `_actor_role` and `_role_in_agreement` are all replaced by the server values, and no other top-level `_` key survives;
      - readback of the stored row recomputes `payloadHash` to the stored `payload_hash`, and the v5 `event_hash` to the stored one;
      - **both `performed_by` directions** on real contracts, with the persisted values: `counterparty` records `_role_in_agreement = 'receiver'`, `creator` records `'performer'`. Null is exercised only at the TS `roleInAgreement` boundary, since the column is `not null`;
      - **classification, on `private.v5_reserved_fields_status` in isolation,** with exact codes:
        - **stale proposal:** well-formed, consistent role, `p_proposed ≠ p_locked` gives `context_changed`;
        - **wrong role with current context:** `p_proposed = p_locked` but the role disagrees with it gives `reserved_fields_mismatch`;
        - **fixed-field error with stale context:** a wrong `_auth_method` and `p_proposed ≠ p_locked` gives `reserved_fields_mismatch`, not `context_changed`;
        - `p_proposed` outside `creator`/`counterparty` gives `reserved_fields_mismatch`;
      - **retry, through Edge with a stubbed RPC that answers `context_changed` once:** an event the locked role permits succeeds on the rebuilt call; an event the old role permitted but the locked role doesn't (for example `performance.asserted` after the owner becomes the receiver) is refused on the rebuilt call with the owner-path role refusal, never written;
      - **exhaustion:** `context_changed` on every attempt gives 409 `context_changed`; `clock_window` on every attempt gives 409 `clock_skew`;
      - **direct RPC calls refused by SQL, nothing stored, no ticket left:** each of the four reserved fields wrong in turn, one missing, one extra top-level `_` key, and `_authentication` with one inner value changed or one inner key added;
      - **parity:** the TS-built expected reserved object equals the SQL constant and rule over shared fixtures.
    - Floats, unsafe integers, `\u0000` and lone surrogates are refused.
  - **Revoke and expiry timing:**
    - revoke vs append, in both orders
    - an already-admitted request vs a request queued before revoke vs a fresh request after revoke or expiry
    - expiry while waiting on any lock (contract, grant or gate)
  - **Key collisions:**
    - cross-grant gives 409 with no row
    - owner→delegated and delegated→owner, in both directions, including the unique-violation and readback branches
    - guest↔delegated
  - **Refusals and rollback:**
    - wrong `prev` and explicit GENESIS
    - the deal's owner changed
    - each locked-context field wrong (terms, DoD, accepted version, actor, authority, created_at outside the window) gives a refusal
    - a test trigger that alters a returned field causes a rollback
  - **Concurrency and schema:**
    - owner, guest and v5 writers contending on one deal
    - old-schema failure: the RPC against a database without migration A refuses cleanly
- **New `tests/unit/logEventDelegated.test.js`:**
  - **Admission and flag:** admission, flag-off 503, dispatch before the 404, mixed and duplicate credentials.
  - **Body fields:** `credential_id` and `issuer_kind` in the body give a 400.
  - **Builder and payload:** the builder uses only server-derived fields, and the payload restriction holds.
- **Extended `tests/unit/eventWriteRules.test.js`:** the `credentialId` guard at all three owner sites.
- **Extended `tests/unit/guestResponse.test.js` and `tests/unit/verifyReceipt.test.js`:** one real delegated v5 row from `buildDelegatedEventV5`, which must recompute as `match`.
- **New `tests/e2e/delegated-append.spec.js`** (API level, hosted E2E after the gate opens): items 1–4 of "done" against the live function, plus recomputation of the actual written row through all four readers.
- **Re-run unchanged:** the row 1 credential suites, the row 3 v5 suites and the guest append suites.

**Review points (Codex):**
- the binding table against the actual `RETURNING` comparison, and the reserved-field check against the locked grant and contract
- that idempotency can't cross grants or kinds
- the role and state parity with the owner path
- no new client grant or RLS path
- the parity test between the SQL outer canonical and TS
- payment scopes stay claims

### 4c. Database enforcement, then opening on E2E only (about 0.5–1d, plus its own approval)

**Why the CHECK alone isn't enough.** `events_v5_writes_disabled` and the Edge flag are two independent barriers for the HTTP route only. Once the CHECK is dropped, the flag guards nothing for a direct service-role RPC call, a direct insert, or a legacy writer built on `jsonb_populate_record(null::events, …)`, which would fill the authority columns from any JSON carrying them (`20261122130000:4–11`). So the database itself must confine v5 inserts to the reviewed writer.

**Enforcement, in migration B, while the CHECK is still present**
- **One-use tickets.** `private.v5_write_tickets (txid bigint, event_id uuid, used boolean, primary key (txid, event_id))`.
  - Only `append_delegated_event` (inserts the ticket) and the two `security definer` trigger functions (mark it used, delete it) can write it.
  - `service_role`, `anon` and `authenticated` have no privilege on `private`.
  - The writer inserts one ticket for the event id it is about to insert, in the same transaction.
- **Two triggers, so the stored row is covered however triggers are ordered.**
  - **BEFORE INSERT row trigger, `zz_v5_write_ticket_check`.** It runs on rows with `hash_version = 5` or either authority column set. The name sorts it last, and it is there for early, observable refusals.
    1. It checks the ticket for `(txid_current(), new.id)`, raising its own SQLSTATE if there is none. This comes first, so ticket denial shows even while the gate is closed.
    2. It takes the gate row `for share`, raising its own SQLSTATE if the row is missing or closed.
    3. It marks the ticket used.
  - **AFTER INSERT row trigger, `v5_write_ticket_confirm`.** It sees the row as actually stored, after every BEFORE trigger, whatever their names. If that row has `hash_version = 5` or either authority column set, the trigger requires a **used** ticket for `(txid, id)` and deletes it, so one ticket is one row. Otherwise it raises, and the statement rolls back.
    - So a later-sorting BEFORE trigger that turns a legacy insert into v5 still can't store it.
    - `events_v5_authority_pair` holds on the final row as well.
  - Rows other than v5, without authority columns, pass untouched, which keeps v4 behaviour.
- **Trigger privileges (Task 230, Codex T189).** A plain trigger function runs as the inserting role, and a direct or legacy insert may run as a role with no access to `private`. That role would then see `42501` instead of the ticket SQLSTATE. So the two trigger functions themselves are the narrow privileged code:
  - `private.v5_write_ticket_check()` (BEFORE) and `private.v5_write_ticket_confirm()` (AFTER) are `security definer`, owned by the migration owner, `set search_path = ''`, and use only schema-qualified references (`private.v5_write_tickets`, `private.v5_write_gate`, `pg_catalog.txid_current()`).
  - They read only `new.id`, `new.hash_version` and the two authority columns, and take no arguments. PostgreSQL refuses to call a trigger function outside a trigger, so the definer rights can't be borrowed by a direct call.
  - `EXECUTE` is revoked from `public`, `anon`, `authenticated` and `service_role`. PostgreSQL checks it when the trigger is created, not when it fires, so the revoke doesn't stop the triggers firing for any inserting role.
  - Each raises its own SQLSTATE (`ticket_missing`, `gate_missing`, `gate_closed`, `ticket_unconfirmed`), so the intended refusal is what a caller sees.
  - Tests: a direct v5 insert as `service_role`, and each legacy writer, get the ticket SQLSTATE, not `42501`; the catalog shows both functions as `security definer` with an empty `search_path` and the restricted ACL; a direct `select private.v5_write_ticket_check()` by `service_role` fails (no privilege on `private`, and not callable outside a trigger).
- **Gate row.** `private.v5_write_gate (id boolean primary key default true check (id), open boolean not null default false)`, a singleton inserted closed by migration A (moved from B in Task 232: the resolver reads it, and its gate tests need it).
  - A delete guard and revoked privileges stop the row being removed. If it is missing anyway, every path fails closed (`gate_missing`).

**Gate lock contract**
- **Writer:** contract `for update`, then grant `for share`, then gate `for share`, held through commit.
  - The trigger's own gate read, `for share` in the same transaction, re-reads a row the writer already holds.
- **Operator close:** a single-statement `update private.v5_write_gate set open = false` in its own transaction. It locks **only** the gate row; opening is the same with `true`.
- **What the order guarantees:**
  - **A writer already holding the gate share lock** finishes, commits or aborts, and the close waits for it. That is the same rule as revoke: an admitted write may complete.
  - **A writer that reaches the gate after the close is queued or committed** re-reads the row under READ COMMITTED and refuses with `gate_closed`. After the close commits, no v5 row can commit.
  - **No deadlock:** writer contract → grant → gate; revoke contract → grant; close and open gate only. There is no cycle.
- **Answers:** `gate_closed` and `gate_missing` are a public `503 delegated_append_unavailable`, because they are operational, not authorization. A missing row also logs a loud `v5_gate_missing` line.

**Gate lock tests** (`tests/sql/delegated_append.sh`, two sessions, deterministic with advisory-lock barriers)
- **Close commits first,** then the append runs: refused with `gate_closed`, nothing stored.
- **The append holds the gate share lock first,** then the close is issued: the close waits, the append commits, then the close commits, and a later append is refused.
- **A close issued while an append waits on the contract lock:** the append gets the lock after the close commits and is refused.
- **A close queued ahead of an append on the gate row:** the append is refused after the close commits.
- **Missing gate row** (disposable DB): fails closed on the writer and the trigger.
- **Trigger ordering** (disposable DB only, never hosted E2E):
  - `events_v5_writes_disabled` is dropped first, so the old CHECK can't reject the candidate before the AFTER trigger runs.
  - A test-only BEFORE trigger named after `zz_…` rewrites a legacy insert into an otherwise constraint-valid v5 row: `hash_version = 5`, both authority columns (so `events_v5_authority_pair` passes), and the correct predecessor, so `enforce_event_created_at_follows` and the chain checks pass.
  - The insert fails with `v5_write_ticket_confirm`'s own SQLSTATE (asserted exactly, not just "an error"), and a follow-up read finds no row with that id.
  - A catalog test asserts `zz_v5_write_ticket_check` sorts last. That is an early warning; the AFTER trigger is the enforcement.

**Order on E2E**
1. **Prerequisites.**
   - read-only confirmation that `manage-entry-agent-credential` is deployed on E2E and issuance can be on
   - an approved bot fixture (deal, owner account, grants)
   - the E2E admission and redaction checks from 4a
2. **Proofs before the CHECK is dropped (the Q5(c) condition), each barrier on its own.**
   - **In the disposable local database:**
     - **Effective ACLs:** `has_function_privilege`, `has_table_privilege` and `has_schema_privilege` for `anon`, `authenticated` and `service_role`, on the resolver, the writer RPCs, the ticket and gate tables and schema `private`.
     - **Missing gate,** with the CHECK dropped and the ticket valid: refused.
     - **Closed gate,** likewise: refused.
     - **Ticket denial,** with the gate open and the CHECK dropped: refused through a direct `service_role` insert and through each legacy `jsonb_populate_record` writer (`accept_invitation`, `append_guest_event`, `reissue_guest_access`) given v5-shaped JSON.
     - **The CHECK alone,** with the gate open and a valid ticket through the writer: refused by `events_v5_writes_disabled`. This one is only isolable here, because elsewhere the closed gate stops the writer before it reaches the CHECK.
   - **On hosted E2E, after applying migrations A and B** (the CHECK still present; E2E's gate is never deleted and not opened before step 5):
     - **ACLs:** the same effective-ACL queries, read-only.
     - **Closed gate:** the writer RPC is refused with `gate_closed`.
     - **Ticket denial:** a direct `service_role` v5 insert, and `append_guest_event` with v5-shaped JSON via the bot fixture, are each refused with the ticket SQLSTATE.
     - **v4 writes** still work.
3. **Deploy `log-event` with the flag off** and prove the 503.
4. **Apply migration C, `2026112x000002_drop_v5_check.sql`**, which drops `events_v5_writes_disabled`. It is a shared migration under Q5 (c), accepted by Codex in T188. Repeat the E2E proofs from step 2: the ticket trigger and the closed gate still refuse everything.
5. **With Kenji's OK:** open the gate row **on E2E only**, as one recorded `update`. Then flag on, run `delegated-append.spec.js` and the four readers against the live v5 row.
6. **Close the flag by default** after the trial. The gate row stays open or is closed, as Kenji decides.

**Q5 changes because of this.**
- **(c), recommended:** A, B and C are shared migrations, applied to production when row 9 (or an earlier approved step) reaches them. Production's gate row stays `false`. Opening is a per-project data change, so the migration history stays identical with nothing to reconcile.
- **(a), fallback:** a one-off DDL on E2E only. It means E2E schema drift, which row 9's shared migration must deliberately reconcile.
- **Codex accepted (c) in T188,** on condition of the gate lock contract and the isolated proofs above. Production stays closed through row 4.

**Rollback order (it can only stop new writes)**
1. Set the flag off.
2. Set the gate row to `false`. The close waits for any write already holding the gate lock; after it commits, the writer and both triggers refuse every v5 insert.
3. Optionally, re-add `events_v5_writes_disabled` as `CHECK … NOT VALID`, because v5 rows already exist.
4. Verify:
   - a fresh v5 write is refused on every path
   - logged v5 rows are kept and still recompute as `match`
   - v4 writes still work

**Rollback limits (cannot be undone):**
- **v5 rows are permanent.** `events` is append-only (`DO INSTEAD NOTHING` rules), so E2E v5 rows can never be removed.
- **Readers can't be rolled back.** The v5-capable readers stay; an older reader would report v5 rows as an unsupported format.
- **This is why production opening waits for row 9.**

## Risks

- **Auth boundary mistakes** (the gateway, a resolver reachable by clients, an error or log oracle, lock order) are the expensive kind. They need Codex's independent review before anything is applied on E2E, and an Opus-tier pass on the SQL.
- **Hash/row mismatch.**
  - The outer hash is re-derived in SQL, every inner-digest input is compared under the lock, and the `RETURNING` row is compared field by field. Any difference rolls back.
  - **Residual:** the correctness of the TS inner-digest functions, which every reader shares; that is pushback 1.
- **Platform header logging** would expose the grant secret. It is checked on E2E before the writer is enabled, and it is a stop condition.
- **Live-write window:** E2E only; no production writes in this row.
- **Issuance and deploy readiness on E2E** may be missing. That is prerequisite 1, a small step of its own.

## Kenji decides

Codex's view (T187/T188) is next to mine for each question; T229's report has the table.

- **Q1 — how the AI presents its grant.** `x-trustflow-grant: <uuid>.<secret>`, with the anon key in `Authorization` as transport only, strict parsing, no URL or body form, and the CORS preflight. *Codex agrees.*
- **Q2 — which event types.** The grant's scopes ∩ the row 4 allowlist (`performance.asserted/accepted/rejected`, `payment.reported/acknowledged/disputed`) ∩ the locked role and state, in both `performed_by` directions. No `accept`, `read`, retired or server-only types. Payments stay claims. *Codex agrees.*
  - **Settled in T188:** the exclusion is the deal-acceptance scope. A properly scoped receiver may write `performance.accepted`.
- **Q3 — `actor_id`.** The issuer account UUID, derived under the lock and bound with both authority fields. Assurance is recorded as grant possession. This depends on the owner-replay guard, which is now in 4b. *Codex agrees.*
- **Q4 — nondelegated writers.** They stay v4, and only the replay guard changes. *Codex agrees.*
- **Q5 — how v5 opens on E2E only.** **(c)**: shared migrations with the ticket, gate and triggers, and opening as one data change on E2E. (a) is the fallback. *Codex accepted (c) in T188, with the gate contract and isolated proofs now in §4c.*
- **Q6 — scheduling.** Start local work on 11-24. E2E opening depends on review, issuance and gate proof, with its own OK. Keep 11-27/28 as buffer. *Codex agrees.* Schedule row 4's ownership wording (Claude writes, Codex reviews) needs an authorized edit to `docs/schedule.md`.
- **New — the created-at window for v5.** 60 s with inclusive bounds, from one sample after all locks. *Codex accepted it in T188.*
- **New — inner digests.** Computed by the trusted caller in TS, with SQL comparing the inputs. *Codex accepted this with conditions in T188, and the conditions are now in 4b.*
- **New — payload duplicate keys.** One final recorded tree: parse once (last key wins), strip caller `_` fields, add server fields, then hash, send and store that tree. *Codex accepted the parser choice in T189; the final-tree rule closes its must-fix.*

## Size versus schedule

| Piece | Schedule (rev 3) | Estimate |
|---|---|---|
| 4a admission + resolver + redaction + tests + review | 1d | 1d |
| 4b writer + binding + owner-replay guard + tests + review | 1d | 1.5–2d |
| 4c ticket + gate lock contract + two triggers + isolated proofs + staged E2E opening + rollback | (in the 2d) | 1d, plus the approval wait |
| **Row 4 total** | **2d (11-26..27)** | **3.5–4d** |

- **Why it grew from T227's 2.5–3d:** the owner-path replay change, the `RETURNING` binding and parity test, and the database enforcement that replaces "drop the CHECK".
- **Dates:** starting 11-24, row 4 finishes 11-27 or 11-28, and row 3's two-day lead absorbs it. M1 (12-04) holds unless the code review needs more than one extra cycle.
