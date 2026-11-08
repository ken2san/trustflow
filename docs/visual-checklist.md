# Visual checklist — what "this looks wrong" means here

What a reviewer checks on every captured screen. One line per item. It exists
because the test suite asserts text and has never failed because a screen was
unreadable: the real defect found on 2026-11-04 was two lines carrying the most
legally significant fact on the page, rendered at roughly invisible contrast,
and no assertion in 119 cases was ever going to catch it.

**How to use it.** Run a capture (`npm run capture:owner`, `npm run
capture:guest`), run `npm run visual:diff` to see which screens changed, open
those images, and walk this list against each. The reviewer is not the person
who wrote the screen — an author cannot see what they already know is there.

**How it grows.** Append one line per new finding, in the section it belongs
to. Only the mechanical item at the bottom is automated; everything above it is
a judgement, which is the point.

## Text and numbers

- Text overflowing its box, or running under an adjacent element.
- A long unbroken token (an email address, a URL, a hash) pushing a row wider than the card.
- A truncation that hides the part that matters — a project name cut before the word that identifies it.
- Three-digit numbers where the layout assumed one: `123 days late`, `¥999,999,999`.
- A date or amount wrapped across two lines mid-value.
- A label and its value separated far enough to be read as unrelated.

## Legibility

- The most important fact on the screen is not the least readable thing on it.
- Low-contrast body text on the dark background — `text-slate-600` and below on `#020617` is suspect.
- A success toast brighter than the record it is announcing (the 2026-11-04 finding).
- Icon-only controls with no visible label and no hover state on a touch screen.
- Text over a gradient or blur where contrast varies across the line.

## Layout

- Buttons wrapping onto two lines, or a button row breaking into a single column at desktop width.
- Misaligned rows: status dot, name, and action not sharing a baseline down a list.
- An element colliding with the fixed header (but see below — a `-full` capture puts the header mid-page by construction, and that is a stitching artefact, not a defect).
- Inconsistent padding between cards in the same section.
- A section heading orphaned at the bottom of the fold with its content below.

## States that are easy to never look at

- The empty state: does it offer the next action, or just say nothing is here?
- The error state: is the server's verbatim message labelled as technical detail rather than advice?
- The loading state: does it say what is loading?
- A screen with exactly one item, and a screen with many.
- A collapsed section (`Completed`) opened — its rows are never photographed otherwise.
- The dead-link screen a stranger meets when an invite has been deleted.

## Mobile only

- Horizontal scroll at phone width.
- A two-column row that should have stacked, or stacked content that lost its label.
- A tap target smaller than roughly 44px.
- A fixed header eating the first line of content.
- Content hidden behind the home indicator at the bottom of the viewport.

## Mechanical — already asserted, do not re-check by eye

- Horizontal overflow of the document or of any visible non-scrollable element: `tests/e2e/layoutOverflow.js` fails the capture run on it, at both widths.
