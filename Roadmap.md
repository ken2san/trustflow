---
# TrustFlow Development Roadmap & Strategy

_Product direction and sequencing. Last revised 2026-09-26._
---

> **What this file is and is not.** This is the intent: who TrustFlow is for, why
> it exists, and what order things should happen in. It is **not** a record of
> what is built. For that, read `HANDOFF.md` (current state) and `Protocol.md`
> (the implemented protocol). Where this file describes a mechanism, assume it is
> unbuilt unless `HANDOFF.md` says otherwise.
>
> The five-step escrow / Marketplace surface that earlier versions of this file
> described as working is legacy mock state, not the product.

## 0. Mission

**Make trust the default, not the exception.**

The freelance economy runs on broken trust infrastructure. Scope disputes, ghosting, and unpaid work are not edge cases — they are the norm. TrustFlow is not a product. It is a piece of social infrastructure: a protocol that makes exploitation structurally harder and cooperation structurally easier.

This is not about profit. It is about changing how people work together.

### The deeper problem

The proof of a person's capability and integrity has always been controlled by intermediaries — academic institutions, certification bodies, employers, hiring agencies. These intermediaries profit from being the sole translators of human ability into something others will trust. The individual accumulates the track record; the institution captures the value.

This asymmetry is not accidental. It is structural, and those who benefit from it have little incentive to fix it.

TrustFlow is a protocol-level response: every completed contract, every honored deadline, every fairly resolved dispute becomes a tamper-evident, portable record that belongs to the individual — not to the platform, not to any institution. A public notary does not own what they witness. Neither does TrustFlow.

**The entry point is freelance contracts. The destination is a portable trust infrastructure that individuals carry across every context — work, credit, collaboration — without asking anyone's permission.**

---

## 1. Product Strategy

### Target User

TrustFlow has two distinct user types who arrive with fundamentally different contexts. Both must be designed for explicitly.

#### Type 1: The Initiator (primary acquisition target)

**A professional who has been burned and is actively seeking a better way.**

- Has experienced "it's not what I asked for" after delivery
- Motivated to change how they work — willing to convince their counterparty
- Already has an existing relationship with the counterparty ("Bring Your Own Client" model)
- Values audit trails and enforceable agreements over convenience
- Entry point: discovers TrustFlow, sets up a contract, sends an invite link

#### Type 2: The Invited Counterparty (retention-critical)

**Someone who receives an invite link from the Initiator — with zero prior context.**

- Has no existing motivation to use TrustFlow
- Potential objection: "Why do you need a system? Don't you trust me?"
- If the first screen they see doesn't immediately show _what they gain_, they leave
- Entry point: invite link → must land on a screen that explains value, not mechanics
- Key insight: this person also accumulates a portable Trust Passport from day one — that is the hook

**We are NOT targeting:**

- Professionals looking to browse and discover new work opportunities (Type A / Upwork model)
- This profile is the future state after the data flywheel turns; it is not the entry point

#### OPEN — is the operator always the party receiving paid work?

Both types above are written as "a professional who gets hired". The
implementation is already broader than that: `contracts.performed_by` is
`creator` or `counterparty`, the agreement-creation form asks which side
performs, and the evidence model carries the answer into the agreement snapshot.
So the creator can already be the hiring party, and the first dogfooding
transactions may well go that way.

**This is a product-positioning question, not a code gap, and it is not decided
here.** Do not silently rewrite the target user, the "Earner / Hirer" vocabulary
or the copy to match the wider capability. Whoever settles it should settle it
deliberately: either the operator is the earning side and `performed_by` is a
generality the product does not yet claim, or the product is symmetric and a good
deal of copy is wrong. Both readings have consequences beyond documentation.

### Core Value Proposition

TrustFlow converts ambiguous project briefs into structured, AI-generated Definitions of Done — creating a mutual agreement that is logged, locked, and enforceable before any money moves. Both parties are protected symmetrically.

Most contract disputes do not start from bad intent. They start from ambiguity — "done" meant different things to each side. TrustFlow eliminates that ambiguity before money moves, and holds the record of what was agreed so neither side can rewrite history.

**The platform takes responsibility for the quality of the agreement, not just its existence.** A user should not need to read legal language or understand contract law. TrustFlow's AI is the expert in the room — it detects vague terms, fills structural gaps, and flags conditions that could cause disputes. The user's only job is a final "yes, this is what I want."

**Not competing on:** Price, talent discovery, or ease of onboarding light users.
**Competing on:** Making fair outcomes the structural default for both sides.

> The AI in the two paragraphs above does not exist. There is no Gemini or other
> model integration anywhere in the code; completion criteria are whatever the
> creator types. What the product does deliver from this section is the second
> paragraph's back half: the agreed deal is bound at acceptance and neither side
> can rewrite it afterwards.

### Design Principles

> Several of these describe capability that does not exist yet — there is no AI
> in the code, no trust ladder enforcement on the DB-backed flow, and no rating
> mechanism. They are stated as intent, not as behaviour.

1. **Symmetric protection** — Both Earner and Hirer carry stakes and responsibilities equally
2. **Behavior over credentials** — What you do matters more than what you claim
3. **Transparency as prevention** — Make problems visible before they escalate
4. **Friction as a feature** — A little friction at the start prevents enormous friction later
5. **Trust as a portable asset** — Every completed contract builds a verifiable record that belongs to the user, not the platform. This is the answer to "why should I join?" — participation compounds in the user's favor, permanently
6. **Agreement quality is the platform's responsibility** — Users are not contract lawyers. TrustFlow's AI must ensure the DoD is unambiguous, complete, and dispute-resistant before either party signs. Asking users to "read carefully" is a failure of design.
7. **Invisible enforcement** — The protection mechanisms must work without the user understanding them. A surgeon does not explain anesthesia to the patient before operating. TrustFlow's mutual stakes, append-only logs, blind ratings, and DoD hashes operate silently in the background. The user's only awareness should be: "if I act in good faith, I am protected; if I don't, I will pay for it." The system is the expert — not the user.
8. **Market self-cleansing through information symmetry** — TrustFlow is not a neutral venue. The root cause of most freelance market dysfunction is information asymmetry: Hirers cannot verify whether an Earner will deliver; Earners cannot verify whether a Hirer will pay. Both sides exploit that opacity — Hirers through 中抜き (intermediary margin extraction), non-payment, and deliberate delay; Earners through inflated quotes, low-quality delivery, and overpromising. These are not edge cases; they are the structural norm TrustFlow exists to dismantle. Every completed contract, every dispute outcome, and every DoD acceptance reduces that opacity permanently. Bad-faith actors on either side accumulate negative trust signals that progressively restrict their access — reduced Earner visibility for Hirers, reduced recommendation ranking for Earners. This is not punitive enforcement; it is structural consequence. A Hirer who cannot find willing Earners, and an Earner who cannot win good projects, both face the same choice: reform or exit. The marketplace curates itself by making the cost of information asymmetry exploitation accumulate faster than its benefit.

### Contract State Machine

**Implemented** (`Protocol.md` §3 is authoritative; `derive_contract_state()` is
the single definition):

```
DRAFTING ──▶ AWAITING_ACCEPTANCE ──▶ TERMS_ACCEPTED ──▶ AWAITING_CONFIRMATION ──▶ PERFORMANCE_ACCEPTED
                                          ▲                      │                     (terminal)
                                          └──── performance.rejected
```

`SETTLED`, `DELIVERED` and `CANCELLED` are not reachable. Money moves outside
TrustFlow today, so nothing settles, and whether an accepted agreement can be
voided at all is undecided (`Decisions.md`).

**The reasoning that produced this shape, which still holds:** if the platform
takes responsibility for the quality of the agreement, most of the machinery of a
typical contract system stops being necessary. Ambiguous criteria produce
subjective disputes; subjective disputes need negotiation loops; negotiation
loops need pause states, renegotiation flows and admin overrides. A clear
agreement needs none of them.

So these are deliberately **not** in the product, and a future session should not
add them back as if they were missing features:

| Mechanism | Why it would exist | Why it does not |
|---|---|---|
| Renegotiation flow | criteria were vague; parties disagree mid-contract | re-scoping is a new agreement |
| Pause / Resume | parties are blocked with no clear next action | clear criteria always define the next action |
| Unlimited rejection loops | subjective "done" allows endless dispute | rejection is recorded as disagreement, not adjudicated |
| Forced-dispute-after-N-rejections | escalation heuristic for unresolvable loops | there is no verdict mechanism to escalate into |
| Admin intervention button | human override for inescapable states | no state is inescapable |

A rejection *is* possible, and the implemented model treats it as recorded
disagreement that returns the protocol to `TERMS_ACCEPTED`. It does not decide
who is right; TrustFlow cannot observe the work.

**Dispute resolution and arbitration are unbuilt and undesigned.** Earlier
versions of this file described AI arbitration against the DoD hash with a human
arbiter as fallback. Nothing of that exists, and the evidence model's stance —
that a party's assertion is not a fact — is not obviously compatible with a
platform verdict. Treat it as an open product question, not a scheduled feature.

### What We Are NOT Building (Scope Boundaries)

- A general-purpose freelance marketplace (Upwork, Lancers)
- A payment processor or wallet (regulated territory)
- A tool for one-off, low-stakes transactions

### Go-To-Market Strategy: BYOC First

TrustFlow's matching engine is only as good as the trust data behind it. That data comes from completed contracts — which means matching must come _after_ the data flywheel has started turning.

**The flywheel (trust accumulation):**

```
BYOC (bring existing relationships)
  → contracts complete
  → behavior data accumulates
  → matching recommendations gain meaning
  → new relationships form via matching
  → more contracts → more data
```

**The counter-flywheel (bilateral market self-cleansing):**

```
Hirer bad-faith (non-payment, delay, dispute loss, 中抜き)
  → TrustPoints penalty → Trust Ladder demotion
  → contract limits reduced, visibility in Earner recommendations suppressed
  → cannot find willing Earners → reforms or exits

Earner bad-faith (poor quality, price gouging, overdelivery promises)
  → dispute loss, low DoD acceptance rate → TrustPoints penalty
  → recommendation rank drops, Hirers no longer matched to them
  → cannot win quality projects → reforms or exits

Both sides:
  → information asymmetry shrinks with each completed contract
  → platform quality floor rises without active policing
```

These two flywheels are the same mechanism viewed from opposite directions. The platform does not police behavior — it makes opacity itself the liability. Bad actors depend on information asymmetry to exploit others; TrustFlow systematically eliminates that asymmetry, removing the structural condition that makes exploitation possible.

**Implication for the product:**

- Early users will find their own counterparties elsewhere and bring them to TrustFlow to use the protocol
- This is not a weakness — it is the correct entry point for a trust-infrastructure product
- The marketplace UI still in the repository is not a matching engine and never was — it is part of the legacy mock surface, reachable only through command-palette entries labelled "(legacy)". Treat it as a sketch of a destination, not as a feature with data behind it
- "Zero matches" is not a failure state; it is a signal to go deeper into BYOC and build trust history first

**Implication for UI design:**

- BYOC flow and contract protocol are the highest-priority surfaces
- Matching UI should not mimic keyword-search marketplaces (Upwork model)
- When matching does surface candidates, the UI should speak as a trusted introducer: "Based on your history, here is why this person is the right fit" — not a ranked list for the user to filter

---

## 2. Where the product actually is

Not repeated here, deliberately — it went stale every time. `HANDOFF.md` holds
current state, live test status and the next priorities; `Protocol.md` holds what
the protocol does; `Decisions.md` holds why.

The short version as of 2026-09-26: the DB-backed evidence core works
end-to-end — create, invite, atomic acceptance, hash-chained events written
through the server, agreement snapshot bound at acceptance, two different exports — and
almost nothing else in this file is built. Payment is not wired. There is no AI,
no timestamping authority, no rating, no matching, no trust ladder on the real
flow.

---

## 3. Feature Vision (unbuilt)

Everything in this section is intent. None of it is implemented on the DB-backed
flow; several items existed only as mock behaviour on the legacy surface and were
never real. Kept because the ordering still expresses what matters.

### Trust infrastructure — without these the product stays a one-operator tool

| # | Feature | Purpose |
|---|---|---|
| 1 | **Auto-release timer** | A window after performance is asserted with no answer. Requires money in the loop; currently meaningless. |
| 2 | **Mutual stake** | Both sides carry a cost for abandonment. Requires money in the loop. |
| 3 | **Milestone / partial performance** | Most real work is not one delivery. See `Decisions.md` on multi-step performance — the open question is whether the existing event model already covers it. |
| 4 | **Dispute path** | Undesigned; see the state-machine section above. |

### Verifiable trust — what would make participation worth something

| # | Feature | Purpose |
|---|---|---|
| 5 | **Blind simultaneous rating** | Both submit before either sees the other's. Removes retaliation fear. |
| 6 | **Behaviour signals** | Legible facts (response time, on-time rate, cancellation rate) instead of an opaque score. |
| 7 | **Progressive limits** | Contract ceiling rises with track record, no KYC to start. |
| 8 | **Portable record** | The counterparty's record belongs to them, not to the platform. The guest export is the first, minimal instance of this. |

### Structural prevention

| # | Feature | Purpose |
|---|---|---|
| 9 | **Deadline handling** | Deadlines are stored and bound into the snapshot; nothing acts on them. |
| 10 | **Staged performance** | Preview → accept → full. Neither side fully exposed. |
| 11 | **Vouching** | Transitive trust as a cold-start answer without eKYC. |
| 12 | **Re-contract from a prior agreement** | Retention is the proof the thing works. |

### Later

- Multi-party / team agreements
- eKYC, if and when regulation requires it
- The counterparty's record as a W3C Verifiable Credential — the endpoint of
  "the platform does not own what it witnesses"

---

## 4. Sequencing

Only two things here are decided; everything else is direction.

1. **Withdraw before acceptance** — decided 2026-09-25, not implemented. Needs
   `derive_contract_state()` to project the withdrawal. Voiding an *accepted*
   agreement is a separate, undecided question.
2. **Real transactions before generalisation.** The method, from `Decisions.md`:
   real transaction → real friction → inspect the existing model → decide whether
   the friction is specific or general → make the smallest justified
   generalisation. The certified-translation job is the first concrete case.

Then, in rough order of what a second real transaction would demand: payment
wired end-to-end (Stripe Connect is decided, not built), then whichever of
performance-across-steps, ratings or limits the friction actually asks for.

**Not scheduled, and not to be picked up on inference alone:** AI scoping,
arbitration, matching, a trust ladder on the real flow, on-chain anchoring,
external timestamping (`timestamp-event` was deleted as an unauthenticated public
endpoint).

---

## 5. Record integrity — the part that is the product

This was Phase 4 of an earlier plan and is the one area where the ambition was
actually delivered, so it is worth stating what the trust model rests on **now**:

- Append-only `events` (`DO INSTEAD NOTHING` rules — a `DELETE` succeeds and
  deletes nothing), RLS, server-side hashing in the Edge Functions.
- A hash chain per contract with `prev_event_hash` and a `GENESIS` sentinel.
- Canonical v4: the hash binds the agreement snapshot, so an acceptance proves
  the whole deal, not only the completion criteria.
- Acceptance and its evidence commit in one transaction.
- Exports built from raw rows, re-verifiable by the owner.

**What it does not rest on:** any external notary. There is no RFC 3161
timestamping and no blockchain anchor. The earlier plan's threat model claimed
protection against a malicious DB admin and against the operator themselves
through TSA and on-chain anchoring; neither exists, so **today the operator is
inside the trust boundary**. That is the honest statement, and closing it is a
real decision rather than a task — an external anchor is cheap, but it changes
what TrustFlow can be asked to prove.

---

## 6. Risk register

| Risk | Impact | Intended mitigation | Status |
|---|---|---|---|
| Counterparty never answers a performance assertion | protocol stalls | auto-release window | unbuilt; needs money in the loop |
| Performer abandons | receiver loses time | mutual stake | unbuilt |
| "Not what I envisioned" | unresolvable disagreement | clear criteria; staged performance | partial — criteria are bound at acceptance |
| Retaliatory ratings | scores become dishonest | blind simultaneous rating | unbuilt |
| No reputation to start with | nobody can be evaluated | progressive limits; vouching | unbuilt |
| Holding other people's money | regulatory liability | TrustFlow never holds funds; Stripe is the licensed rail | decided, unbuilt |
| Operator inside the trust boundary | evidence provable only as far as TrustFlow is trusted | external notarisation | **open, see §5** |
| Self-asserted counterparty identity | actor attribution is weaker than it looks | verification at acceptance | open, see `Decisions.md` |
