# Receipt format v2 (event-hash v5 aware)

**Status: design, not implemented.** One receipt format shared by `scripts/make-receipt.mjs` (writer) and `scripts/verify-receipt.mjs` (offline verifier). Neither changes until the additive authority columns are verified on the target (row 3, 3C-CLI). Until then `make-receipt` keeps emitting `receipt_version: 1`, which contains no v5 acts.

Sources: `docs/v5-preimage-review.md` (the frozen v5 preimage), Codex T161 (3C plan), and the shared rules in `supabase/functions/_shared/eventVerifyV5.ts`.

## Why a new receipt version
- **Version 1** carries a ten-field `canonical` block per act. It has no room for the authority pair, and the verifier assumes legacy semantics: a null predecessor becomes `GENESIS`, and every act is linked from a known start. A v5 act in a v1 envelope must not be verified under those rules.
- **Version 1** also takes `agreement.snapshot` from the contract's **current** fields. A v5 verifier needs the **accepted** snapshot (from the acceptance event) and keeps current terms as a separate comparison.

## Envelope
```json
{
  "receipt_version": 2,
  "issued_at": "…",
  "source": { "project_ref": "…", "api": "…", "issued_for_role": "owner" },
  "read": { "start": "first_event", "tail_complete": true, "pages": 1, "row_cap": 1000 },
  "agreement": {
    "contract_id": "…",
    "accepted": { "snapshot": { … }, "snapshot_version": 1, "agreement_hash": "…", "acceptance_event_id": "…" },
    "current":  { "snapshot": { … }, "agreement_hash": "…" }
  },
  "acts": [ … ],
  "how_to_verify": { … },
  "not_verifiable_here": [ … ]
}
```

### `read`
- **What it records:** what the issuer can prove about completeness. `start: "first_event"` only if the read began at the deal's first event; otherwise `"unknown"`. `tail_complete` is true only if paging reached the end below the row cap.
- **What `make-receipt` must do:** page with explicit ordering (`created_at.asc,id.asc`) and never label a capped prefix complete.

### `agreement.accepted`
- **Source:** the acceptance event's (`dod.consent_recorded`) `_agreement` snapshot and the digest it recorded.
- **Status:** `null` (with a reason) when there is no single acceptance, or when the snapshot isn't a well-formed snapshot of a supported version with valid values (the `acceptedAgreementOf` rules).
- **Drafts:** a draft-only receipt has `accepted: null`. It never synthesises an accepted snapshot.

### `agreement.current`
The contract's terms at issue time, for drift comparison only. It is never used as the historical snapshot.

## Acts
Each act has `sequence`, a `canonical` block, the stored `event_hash`, and the human-context fields v1 already carries, unchanged (`recorded_at`, `actor_role`, `authentication*`, …).

**Canonical block, per the act's own version:**

| Version | Keys (own properties, exactly these) | Rules |
|---|---|---|
| 1–4 | `id, type, contract_id, actor_id, dod_hash, created_at, prev_event_hash, payload_hash, agreement_hash, hash_version` | Unchanged from receipt v1, so legacy acts verify byte-for-byte as today. |
| 5 | the ten above plus `credential_id, issuer_kind` | **Exact projection of the stored row:** nothing synthesised as null, no inferred version, `hash_version` is the stored integer `5`. Only `agreement_hash` may be null. `domain` isn't carried (it is a format constant). The predecessor is named `prev_event_hash` only; `prev_hash` must not appear. |

`credential_id` and `issuer_kind` are nonsecret recorded inputs. A receipt never carries the grant secret, its verifier, or the invite hash.

## Verifier behaviour (`verify-receipt.mjs`)
1. **Version 1 envelope:** today's behaviour. Any act that classifies as `v5`, or carries authority values, makes the receipt fail ("v5 act in a v1 receipt"). It is never verified as legacy.
2. **Version 2 envelope, per act:**
   - **Classify first:** use `classifyStoredEvent` on the canonical block before anything else.
   - **Legacy acts:** the unchanged legacy canonical.
   - **v5 acts:** the strict v5 builder.
   - **Unsupported or invalid acts:** reported, never skipped.
3. **Separate checks:** hash, link, agreement and (where a payload is present) payload, each reported separately. This is `verifyEvidenceSlice` with:
   - `startsAtChainStart` and `tailComplete` from `read`
   - acceptance derived from the acts
   - the accepted digest taken only from `agreement.accepted`
4. **Verdict:** `RECEIPT VERIFIED` only when the slice is `verified`. An incomplete read, an unknown acceptance position or a draft-only receipt gives an explicit non-verified outcome. A proven mismatch is always reported, even beside indeterminate checks.
5. **`compare`** (two parties' receipts): the same act digests in the same order, **and** the same accepted digest.
6. **Required statements:** `not_verifiable_here` must still be present (payload text versus a projection; authority fields aren't proof of who acted; equivocation needs a comparison). A receipt that asserts its own verdict still fails.

## Tests to add with the implementation
- **Receipt formats:** v1 fixtures unchanged; a v2 legacy-only receipt.
- **Mixed and v5 receipts:** a v2 mixed v4→v5→v4 receipt, and a v5 act with each canonical input missing, or with a tampered `credential_id` or `issuer_kind`.
- **Format violations:** a `prev_hash` alias present; a v5 act in a v1 envelope.
- **Read evidence:** `read.start: "unknown"` and `tail_complete: false`.
- **Agreement:** a draft-only receipt (`accepted: null`); an accepted snapshot with a wrong value type, hashed self-consistently.
- **Executable path:** run through the executable, as `verifyReceipt.test.js` does today.
