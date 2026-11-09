# Agent protocol — where it lives, and what pins it

The specification moved. It is **published**, because a client that cannot read
this repository is exactly who it is for:

- served at **`/agent-protocol.md`**, linked from `/llms.txt`
- source of truth: **`public/agent-protocol.md`**

It was in this directory until Task 16 and is not duplicated here. Two copies
of a normative spec is two specs, and the one outside clients read would have
been the one nothing tested.

## What keeps it honest

`tests/unit/shownTerms.test.js` reads `public/agent-protocol.md` directly and
asserts:

- the implementation reproduces both published preimages and both digests —
  the ASCII vector and the non-ASCII one;
- the document still states them;
- the normative field table names **exactly** the keys the digest covers, with
  `toEqual`, and the source column names the field each key comes from;
- the version floor in the prose is the floor the server enforces, parsed out
  of the sentence that states it.

So a field added to `BUILDERS[2]` in `supabase/functions/_shared/shownTerms.ts`
without a table row fails the build, and so does editing a vector.

`scripts/agents/published-digest.mjs` is the other half: an implementation
written from the published prose, importing none of this project's crypto, held
against both vectors and against the server's own helper. If those disagree,
the document is wrong — which is the only reason to keep a second
implementation alive.

## What is deliberately not published

The repo-facing notes that were in the old version of this file: which test
pins what, the review history, and the reasoning about internal paths. The
published document carries the protocol, not the project's workings.

`public/llms.txt` is the index an agent is expected to find first. `robots.txt`
has allowed `/llms.txt` since Task 6, which is why it was the path chosen.
