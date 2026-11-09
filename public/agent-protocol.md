# TrustFlow agent protocol

Two things a client needs that the API alone does not tell it: how to compute
the shown-terms digest an acceptance requires, and how an invitation reaches
the party who is meant to accept it.

Both are **normative**. The digest is checked by the server, so a client that
computes it differently cannot accept a non-JPY agreement at all.

Audience: anyone writing a TrustFlow client — an agent, an MCP server, a
script. This is the published specification; nothing here requires access to
the source.

What TrustFlow attests, since it decides how to read everything below: that a
party **said** something, at a server-recorded time, in an order, bound to the
terms as the server held them. Not that work was delivered, not that money
moved, not who anyone really is. An acceptance is a statement by whoever held
the invitation link, under an address they typed themselves.

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

A field is replaced by its default only when it is **absent or `null`** —
JavaScript's `??`, not a falsy test. An empty string stays an empty string and
`0` stays `0`; `amount_minor: 0` must not fall back to `amount_jpy`.

Those eight keys and no others. Serialize it with these rules:

1. Object keys **sorted ascending** by UTF-16 code unit — JavaScript's default
   `Array.prototype.sort()` on `Object.keys`. For the keys above that is the
   same as byte order; it is stated this way because it is what the server
   does.
2. **No insignificant whitespace**: nothing between tokens, no indentation, no
   newline. Whitespace *inside* a string is content and is preserved exactly.
3. Arrays keep their order. A reordered `dod` is a different agreement and must
   produce a different digest.
4. `null`, and a value that is absent after the defaults above, both serialize
   as `null`. A key whose value is `undefined` is **dropped entirely** rather
   than written as `null`.
5. **Primitives exactly as ECMAScript `JSON.stringify` writes them.** This is
   the rule that bites, because JSON permits several byte sequences for one
   value and the server emits only one of them:
   - **Non-ASCII characters are emitted literally, as UTF-8. Never as `\uXXXX`
     escapes.** `翻訳` is three-byte-per-character UTF-8, not
     `\u7ffb\u8a33`. An ASCII-escaping serializer — **Python's `json.dumps`
     does this by default** — produces a different digest for the same
     agreement, and the acceptance is refused with `409 terms_changed` though
     nobody edited anything. In Python: `ensure_ascii=False`.
   - Escaped, and only these (plus the lone surrogate below): `"` as `\"`,
     `\` as `\\`, and the control characters U+0000–U+001F. Those use the short forms `\b \t \n \f \r`
     where one exists, otherwise `\u00XX` with **lowercase** hex digits.
   - **Not** escaped, though some serializers do: `/`, U+2028, U+2029, and any
     other printable character. A lone surrogate is written `\udXXX`,
     lowercase.
   - Numbers are integers here — minor units, and `v`. No exponent, no leading
     `+`, no trailing `.0`, and `-0` writes as `0`.

Then **SHA-256** over the UTF-8 bytes of that string, as **lowercase hex**.

Send it as `shown_terms_digest`, with `shown_terms_version: 2`.

`dod` is a flat array of strings today. The rules are written for the general
case so that a nested value, if one is ever added, is unambiguous.

### Reference vector

Invitation read (extra fields omitted — they are not terms and must not be
hashed; `invited_hirer_email` in particular is replaceable by the accepter, and
`guest_access_token` is not a term at all — the read returns none and
acceptance mints it):

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

CAD 125050 is **$1,250.50** — the amount is always an integer in the
currency's minor unit, and 1250.50 would be a different, wrong contract.

### Second reference vector — non-ASCII, escapes and nulls

The vector above is pure ASCII, so it cannot catch the serializer difference
rule 5 warns about. This one can, and a client that reproduces only the first
is not yet interoperable. It also exercises two `null` terms and an absent
`performed_by`.

```json
{
  "project_name": "出生証明書の翻訳",
  "dod": ["原本を翻訳する", "Return a stamped PDF — \"certified\""],
  "amount_minor": 30000,
  "currency": "JPY",
  "deadline": null,
  "earner_display_name": null
}
```

Exact preimage string:

```
{"amount_minor":30000,"currency":"JPY","deadline":null,"dod":["原本を翻訳する","Return a stamped PDF — \"certified\""],"earner_display_name":null,"performed_by":"creator","project_name":"出生証明書の翻訳","v":2}
```

Digest:

```
da90b2c392a530fd5a81ae5f5e3cbe84c71b8f60e4bfb06378f717208831ace9
```

This file is the one the implementation is tested against: its unit tests
assert that the server reproduces both preimages and both digests above, that
this document still states them, and that the field table names exactly the
keys the digest covers and the source each comes from. A field added to the
digest without being added to that table fails the build.

What that does **not** cover is prose. A rule reworded into something subtly
different would not fail a test. **Treat the two vectors as the authority when
the prose and the bytes seem to disagree**, and tell us if they do.

### Why the server does not simply hand the digest over

It could return its own digest with the invitation read, and a client could
keep it and echo it back at acceptance. **That would work**: a digest saved
from the preview is still a digest of the row as it stood at the preview, so an
edit made afterwards would still be caught. An earlier version of this section
claimed such an echo attests nothing, which was wrong.

The reasons it is not done are narrower, and worth having straight:

- A client that never computes the digest cannot notice that the terms it
  **rendered** and the row the server **read** already disagreed at preview
  time — only that nothing changed afterwards.
- It would be a change to a deployed function, where this is a document.

Neither amounts to "the echo attests nothing". If that option is ever wanted,
it is a scope decision rather than a correctness one. Note that computing
locally does not prove display either: this is not a boundary.

---

## 2. How an invitation reaches the other side

**TrustFlow does not deliver invitations, and will not.** Creating a contract
returns an `invite_token`; nothing emails it, queues it or pushes it. There is
no mail-sending endpoint, and there is not going to be one.

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
