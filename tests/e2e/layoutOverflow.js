// One cheap assertion that fails on horizontal overflow.
//
// WHY THIS EXISTS
// The suite has never caught a layout defect. The visual review of 2026-11-04
// (HANDOFF.md) found a real one no assertion was going to make, and the answer
// to that was screenshots plus a human-or-agent judgement. This is the small
// part of that judgement a machine can make on its own: a box whose content is
// wider than the box, or a page the reader has to scroll sideways, is wrong
// independently of taste. Everything else — contrast, wrapping, alignment,
// truncation — stays in docs/visual-checklist.md for a reviewer.
//
// Deliberately NOT a pixel diff. No new dependency, no baseline images to keep
// in the repo, and no false positive the first time a font renders differently.
//
// What it will not catch: vertical overflow, text clipped by a fixed height,
// and anything inside an element whose own `overflow-x` is not `visible` —
// `auto`/`scroll` declare that the author meant it, and `hidden`/`clip` mean
// the spill never reaches the reader. Clipped text that should have been
// readable is a judgement, and it stays on docs/visual-checklist.md.

import { expect } from '@playwright/test';

/**
 * Fail if the page, or any visible element inside it, overflows horizontally.
 *
 * `label` names the screen in the failure message, because a capture run walks
 * several screens and "overflow" with no screen name costs a rerun to locate.
 *
 * TOLERANCE is 2px: sub-pixel rounding of a scaled layout produces a
 * scrollWidth one larger than clientWidth on elements that look perfect, and a
 * check that cries wolf gets deleted rather than fixed.
 */
export async function expectNoHorizontalOverflow(page, label) {
  const findings = await page.evaluate((tolerance) => {
    const viewport = window.innerWidth;
    const out = [];

    const doc = document.documentElement;
    if (doc.scrollWidth > viewport + tolerance) {
      out.push({ what: 'the page itself', width: doc.scrollWidth, box: viewport });
    }

    for (const el of document.body.querySelectorAll('*')) {
      if (el.scrollWidth - el.clientWidth <= tolerance) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Only `visible` overflow is a defect a reader meets. `auto`/`scroll`
      // say the author meant it, and `hidden`/`clip` clip the spill — the
      // decorative background layer is a fixed `overflow-hidden` box whose
      // blobs extend past it on purpose, and flagging that reported every
      // screen in the app, including the empty one.
      if (style.overflowX !== 'visible') continue;
      // An absolutely-positioned off-screen element is how this app hides
      // things from sight but not from a screen reader; it is not a layout bug.
      if (rect.right < 0 || rect.left > viewport) continue;

      out.push({
        what: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string'
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}`,
        width: el.scrollWidth,
        box: el.clientWidth,
        text: (el.textContent ?? '').trim().slice(0, 60),
      });
    }

    return out;
  }, 2);

  expect(findings, `horizontal overflow on ${label}: ${JSON.stringify(findings, null, 2)}`)
    .toEqual([]);
}
