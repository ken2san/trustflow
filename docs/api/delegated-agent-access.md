# Delegated agent access (draft, unpublished)

> **Status: E2E only. Not available in production.** This draft stays in
> `docs/` until production release is approved (schedule row 9). It is not
> served from `/llms.txt` or `/agent-protocol.md`, and those documents'
> statement that no per-agent scoped credential exists stays true for
> production until then. `tests/unit/delegatedAgentDocs.test.js` pins the
> grammar, words and types below to the server code.

An owner can let an agent act on **one deal** with a **scoped grant** instead
of handing over their account. The agent never signs in.

## Getting a grant

The deal's owner issues a grant while signed in, choosing the operations it
covers and an expiry of at most 30 days. The service shows the grant **once**,
as a single value:

```
<grant-id>.<secret>
```

- `<grant-id>` is a lowercase UUID.
- `<secret>` is 64 lowercase hex characters.
- The whole value is 101 characters.

Keep it secret and don't log it. If it is lost, the owner revokes the grant
and issues a new one. The owner can list and revoke their grants at any time.

The operations a grant can carry:

- `read`: read the deal and its receipt.
- **Event types:**
  - `performance.asserted`
  - `performance.accepted`
  - `performance.rejected`
  - `payment.reported`
  - `payment.acknowledged`
  - `payment.disputed`

Each type is further limited by the owner's role on the deal and by the
deal's state. A grant never carries acceptance, creation or grant management.

## Calling with a grant

Send exactly these two credentials, and **no `Authorization` header**:

| Header | Value |
|---|---|
| `apikey` | the project's publishable key (`sb_publishable_…`). A public project identifier, not an authority. |
| `x-trustflow-grant` | the grant value, exactly as shown |

A bearer token of any kind, a guest token, or a second grant in the same
request makes the request mixed, and it is refused. A refused delegated
request never falls back to any other kind of access.

### Read the deal

`POST /functions/v1/delegated-owner-read` with body `{"contract_id": "<deal id>"}`. Nothing else may be in the body.

### Record an event

`POST /functions/v1/log-event` with body
`{"type": "<event type>", "contract_id": "<deal id>", "payload": {…}, "idempotency_key": "<your key>"}`.

- **The payload** is a plain JSON object. Don't send `credential_id` or `issuer_kind`: the server derives authority from the grant.
- **Idempotency:** choose one key per intended event. Resending the same request with the same key and grant returns the original event (`200`, `"deduplicated": true`). It never records a second one.
- **Key collisions:** the same key used by a different writer on the same deal is refused.

## Answers

| Status | `error` | Meaning |
|---|---|---|
| 200 | — | (read) the deal's owner projection and its receipt |
| 201 | — | (record) recorded; `event` is the stored row |
| 200 | — | (record) a replay of the same key and grant; `event` is the original |
| 403 | `delegation_refused` | refused, and deliberately uniform: an unknown, wrong, expired or revoked grant, the wrong deal, an operation outside the grant, or mixed credentials all look the same |
| 403 | `wrong_party_for_event_type` | the owner's role on this deal may not record this type |
| 409 | `wrong_state_for_event_type` | the deal's state does not allow this type now |
| 409 | `idempotency_key_in_use` | the key belongs to another writer on this deal |
| 409 | `accepted_version_unsupported` | the deal's accepted terms are in a version this route cannot build on |
| 400 | `type_not_allowed` / `type_is_server_recorded` | not a type any party may record |
| 400 | `authority_is_server_derived` | the body carried `credential_id` or `issuer_kind` |
| 400 | `invalid_payload` | the payload is not a plain JSON object within the allowed domain |
| 400 | `invalid_idempotency_key` | an empty idempotency key |
| 400 | `invalid_body` | (read) the body is not exactly `{"contract_id": "<deal id>"}` |
| 503 | `delegated_append_unavailable` | recording through grants is switched off on this project |
| 503 | `delegated_read_unavailable` | reading through grants is switched off on this project |

Retry only 503s and network errors, and always with the same idempotency key.

## What a delegated record claims

The record binds the grant's id and its issuer kind (`owner_account`) inside
the event hash (`hash_version` 5), and names the owner's account as the actor.
That proves the event was sent by **someone holding that grant**. It does not
prove which agent, which human, or their intent. After a revocation commits,
nothing new is admitted under that grant.
