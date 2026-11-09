# Agent protocol notes

Two things an outside client needs that the API alone does not tell it: how to
compute the shown-terms digest an acceptance requires, and how an invitation
reaches the party who is meant to accept it.

Both are **normative**. The digest is checked by the server, so a client that
computes it differently cannot accept a non-JPY agreement at all.

Audience: anyone writing a TrustFlow client — an agent, an MCP server, a
script — without this repository. Nothing here requires reading source.

---

## 1. The shown-terms digest

### Why an acceptance carries one

`validate-invite-token` reads the invitation, and later accepts it, in two
separate requests. The server re-reads the contract at acceptance and hashes
**that** row, so what gets recorded is the deal as it stands at the moment of
acceptance — not the deal the client was shown, which may have loaded minutes
earlier. In between, the owner can edit the agreement.

So the client sends a digest of the terms **it was shown**, and the server
refuses the acceptance when its own recomputation differs:

| Response | Meaning |
| --- | --- |
| `409 terms_changed` | The agreement moved between the read and the acceptance. Re-read the invitation and decide again. |
| `409 terms_check_unsupported` | The server cannot check the version offered — or none was offered on a contract that requires one. Re-read; do not retry the same body. |

### What it is not

Not a security boundary and not proof that anything was read or displayed. The
client computes the value it sends and may send any value it likes. It protects
an honest client from an honest edit, which is the failure that actually
happens. Anything unforgeable comes from the server's own read.

The acceptance event records the outcome under `_shown_terms_check`:
`presented` (a non-empty digest arrived), `verified` (the server's own
recomputation matched it) and `version` (**as the caller named it** — not an
effective-version field). The absence of the whole object on an older event
means *not recorded*, never *not checked*.

### When it is mandatory

| Contract currency | Digest |
| --- | --- |
| `JPY` | Optional — a compatibility period for clients that predate the mechanism. |
| Anything else | **Required, at `shown_terms_version` 2 or above.** A missing digest, or version 1, is `409 terms_check_unsupported`. |

Version 1 covers `amount_jpy`, which is `NULL` on every contract that is not in
yen, so under v1 the price of a CAD agreement could change without the digest
moving — the one thing the guard exists to catch. Hence the floor.

Versions a current server can verify: **1 and 2**. Send 2.

### The algorithm (version 2)

Build this object from the invitation-read response, field for field:

| Key | Source field | If absent |
| --- | --- | --- |
| `v` | — | the literal integer `2` |
| `project_name` | `project_name` | `null` |
| `dod` | `dod`, **order preserved** | `[]` |
| `amount_minor` | `amount_minor` | fall back to `amount_jpy`, then `null` |
| `currency` | `currency` | `null` |
| `deadline` | `deadline` (`YYYY-MM-DD`) | `null` |
| `performed_by` | `performed_by` | `'creator'` |
| `earner_display_name` | `earner_display_name` | `null` |

Those eight keys and no others. Serialize it with these rules:

1. Object keys **sorted ascending** by UTF-16 code unit (JavaScript's default
   `Array.prototype.sort` on `Object.keys`).
2. No whitespace anywhere.
3. Strings, numbers and booleans as JSON writes them.
4. `null` and a missing value both serialize as `null`; a key whose value is
   `undefined` is dropped entirely.
5. Arrays keep their order. A reordered `dod` is a different agreement, and
   must produce a different digest.

Then **SHA-256** over the UTF-8 bytes of that string, as **lowercase hex**.

Send it as `shown_terms_digest`, with `shown_terms_version: 2`.

`dod` is a flat array of strings today. Rules 1–5 are the general case so that
a nested value, if one is ever added, is unambiguous.

### Reference vector

Invitation read (extra fields omitted — they are not terms and must not be
hashed; `invited_hirer_email` in particular is replaceable by the accepter and
`guest_access_token` is minted per read):

```json
{
  "project_name": "Translate a birth certificate",
  "dod": ["Translate the document", "Return a stamped PDF"],
  "amount_minor": 125050,
  "currency": "CAD",
  "deadline": "2026-12-01",
  "performed_by": "creator",
  "earner_display_name": "Acme Translations"
}
```

Exact preimage string:

```
{"amount_minor":125050,"currency":"CAD","deadline":"2026-12-01","dod":["Translate the document","Return a stamped PDF"],"earner_display_name":"Acme Translations","performed_by":"creator","project_name":"Translate a birth certificate","v":2}
```

Digest:

```
438a61235d399d7dbf60fcc98882eb89065dbc55ad53d5e7b39aef96ab1f9aeb
```

`tests/unit/shownTerms.test.js` asserts the implementation reproduces that
string and that digest, and that this file still states them, so the two cannot
drift apart silently.

CAD 125050 is **$1,250.50** — the amount is always an integer in the
currency's minor unit, and 1250.50 would be a different, wrong contract.

### Why the server does not simply hand the digest over

It could return its own digest with the invitation read, and a client could
echo it back. That would satisfy the check while attesting nothing: the point
is that the client hashes **what it holds**, so a value computed anywhere else
is a value it cannot vouch for. Computing it locally is also how a client finds
out that its own view and the server's row disagree.

---

## 2. How an invitation reaches the other side

**TrustFlow does not deliver invitations, and will not.** Creating a contract
returns an `invite_token`; nothing emails it, queues it or pushes it. The
mail-sending function was retired on 2026-11-06 and must stay retired.

There is also **no way to look up invitations addressed to you**, and that is a
decision rather than a gap: `invited_hirer_email` is an unverified string and
the accepting identity is self-claimed, so a lookup keyed on an address would
be an enumeration oracle over other people's agreements and would prove nothing
about who asked.

### The operational rule

**The creating party's agent hands the invite link or token directly to the
counterparty's agent, over whatever channel those two already use.** TrustFlow
is not in that path and has no opinion about it.

What follows from that, and is worth stating because it is easy to get wrong:

- **The token is the credential.** Anyone holding it can accept, once, as
  whatever address they type. Treat it like a password in transit; do not put
  it in a channel the counterparty does not control.
- **Delivery is unverified.** TrustFlow records that an invitation was
  accepted, by a self-claimed address, at a server-recorded time. It never
  records that it was *received*, nor that whoever accepted it is who the
  address names.
- **It expires in 72 hours** and is **single-use**: a replay answers
  `410 already_used`, an expired one `410 expired`.
- **Present both halves of a split deal before either is accepted.** Where a
  deposit and a balance run as two contracts, the promise of the total exists
  only if both invitations were handed over and both accepted. Nothing in the
  service links them; the link is text in the terms.
- **Re-issuing access is a different act.** `reissue-guest-access` replaces an
  already-accepted counterparty's credential and records `access.reissued`. It
  does not re-invite anyone.
