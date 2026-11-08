// Capture the OWNER's two screens as images, and refuse horizontal overflow.
//
// WHY THIS EXISTS
// guest-path-capture.spec.js photographs what a stranger is shown. Nothing
// photographed the side the account holder uses, and the contracts home was
// rewritten on 2026-11-08 — who it waits on, since when, and up to two clocks
// per contract — with no image of the result at any width. The suite asserts
// text; it has never once failed because a screen looked wrong.
//
// So this is deliberately two different things in one file, and they are not
// the same kind of check:
//
//   · the screenshots, which assert almost nothing and exist for a reviewer
//     who has not seen this repository to judge against
//     docs/visual-checklist.md. The judge is not the implementer.
//   · ONE assertion, expectNoHorizontalOverflow, which is the narrow part of
//     that judgement a machine can make alone. See tests/e2e/layoutOverflow.js.
//
// The fixtures are chosen to break a layout rather than to look good: a project
// name far longer than any card, an email address longer than the row that
// holds it, a deadline 123 days late (three digits where the design assumed
// one), an invite link hours from expiry and a counterparty credential one day
// from it. Pretty fixtures are why layout defects reach production.
//
// WRITES NOTHING. `auth/v1/**`, `rest/v1/**` and the Edge Functions are all
// fulfilled from here — including signup, which the four older stub-closed
// specs left open and which took the E2E project from 57 anonymous users to 87
// (HANDOFF.md). A capture run must be repeatable, which is exactly the case
// where that matters.
//
// Output: test-results/owner-screens/ (gitignored), one set per project width.
// `node scripts/visual-diff-list.mjs` says which of them changed since the
// previous run, so a reviewer only opens those.

import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow } from './layoutOverflow.js';

const OUT = 'test-results/owner-screens';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const hoursFromNow = h => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * A `deadline` column value: a DATE with no time of day, in the READER's zone.
 *
 * Built from local year/month/day rather than `toISOString().slice(0, 10)`,
 * which is the UTC day and is the day before for this machine's zone through
 * most of the evening. contractStatus.js counts the deadline in calendar days
 * local to the reader (the DST fix of 2026-11-08), so a fixture that means
 * "123 days late" has to be local too or the capture is off by one.
 */
function localDate(daysFromNow) {
  const at = new Date(Date.now() + daysFromNow * 86_400_000);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** An ordinary working list: what the screen looks like on a normal day. */
const ORDINARY = [
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    project_name: 'Certified translation of a birth certificate',
    dod: ['translate the document', 'return a stamped PDF'],
    amount_jpy: 20000, amount_minor: 20000, currency: 'JPY', deadline: localDate(9),
    state: 'TERMS_ACCEPTED', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: 'hana@acme.test',
    hirer_email: 'hana@acme.test',
    invite_token: null, invite_token_expires_at: null,
    invite_token_used_at: hoursFromNow(-72),
    guest_access_token_expires_at: hoursFromNow(24 * 88),
    created_at: hoursFromNow(-96),
    last_performance_type: null,
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    project_name: 'Website copy review',
    dod: ['one pass over five pages'],
    amount_jpy: 45000, amount_minor: 45000, currency: 'JPY', deadline: localDate(21),
    state: 'AWAITING_ACCEPTANCE', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: 'soon@client.test',
    hirer_email: null,
    invite_token: '33333333-3333-4333-8333-333333333333',
    invite_token_expires_at: hoursFromNow(60), invite_token_used_at: null,
    guest_access_token_expires_at: null,
    created_at: hoursFromNow(-2),
    last_performance_type: null,
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000003',
    project_name: 'Finished last month',
    dod: ['done'],
    amount_jpy: 20000, amount_minor: 20000, currency: 'JPY', deadline: localDate(-40),
    state: 'SETTLED', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: 'done@past.test',
    hirer_email: 'done@past.test',
    invite_token: null, invite_token_expires_at: null,
    invite_token_used_at: hoursFromNow(-900),
    guest_access_token_expires_at: hoursFromNow(-100),
    created_at: hoursFromNow(-1000),
    last_performance_type: 'performance.accepted',
  },
];

// Longer than any box on either screen, and with no short word to wrap on in
// the address — a long unbroken token is what actually overflows, not long text.
const LONG_NAME = 'Comprehensive certified translation and notarisation of a complete '
  + 'set of civil-status documents required for a permanent residence application';
const LONG_EMAIL = 'procurement.department.accounts-payable+trustflow'
  + '@a-very-long-client-organisation-domain-name.example';

/**
 * The same screen under stress.
 *
 * NOTE on "all three clocks at once", which the brief asked for: it is not
 * reachable, and not because of a fixture. `clocksFor` shows the invite-link
 * clock only while `invite_token_used_at` is null and the counterparty-access
 * clock only once it is set (contractStatus.js:265-267), so the two are
 * mutually exclusive by construction and the maximum is two. Both maximal
 * pairs are captured instead — deadline + invite link, and deadline + their
 * access — and the brief's item is reported rather than faked.
 */
const STRESS = [
  {
    // Lead card: three-digit lateness, a name far past the card, a long
    // address, and the counterparty one day from losing their record.
    id: 'cccccccc-0000-4000-8000-000000000001',
    project_name: LONG_NAME,
    dod: ['translate every document', 'notarise each translation', 'return one bundled PDF'],
    amount_jpy: 1234567, amount_minor: 1234567, currency: 'JPY', deadline: localDate(-123),
    state: 'TERMS_ACCEPTED', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: LONG_EMAIL, hirer_email: LONG_EMAIL,
    invite_token: null, invite_token_expires_at: null,
    invite_token_used_at: hoursFromNow(-24 * 89),
    // 20 hours: `daysLeft` is a ceiling over the instant, so this reads
    // "1 day left" — the warning state, not the expired one.
    guest_access_token_expires_at: hoursFromNow(20),
    created_at: hoursFromNow(-24 * 95),
    last_performance_type: 'performance.rejected',
  },
  {
    // The other maximal pair: a deadline inside the warning window and an
    // invite link hours from expiry, on a contract nobody has accepted.
    id: 'cccccccc-0000-4000-8000-000000000002',
    project_name: 'Deadline in two days, invite link expiring tonight',
    dod: ['a'],
    amount_jpy: 999999999, amount_minor: 999999999, currency: 'JPY', deadline: localDate(2),
    state: 'AWAITING_ACCEPTANCE', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: LONG_EMAIL, hirer_email: null,
    invite_token: '44444444-4444-4444-8444-444444444444',
    invite_token_expires_at: hoursFromNow(3), invite_token_used_at: null,
    guest_access_token_expires_at: null,
    created_at: hoursFromNow(-24 * 6),
    last_performance_type: null,
  },
  {
    // An expired invite with no deadline at all: the empty-ish end of the row,
    // where a missing stamp must render nothing rather than "since now".
    id: 'cccccccc-0000-4000-8000-000000000003',
    project_name: 'No deadline, dead invite, no client yet',
    dod: ['b'],
    amount_jpy: 0, amount_minor: 0, currency: 'JPY', deadline: null,
    state: 'AWAITING_ACCEPTANCE', performed_by: 'creator',
    earner_display_name: 'Me', invited_hirer_email: null, hirer_email: null,
    invite_token: '55555555-5555-4555-8555-555555555555',
    invite_token_expires_at: hoursFromNow(-3), invite_token_used_at: null,
    guest_access_token_expires_at: null,
    created_at: hoursFromNow(-24 * 200),
    last_performance_type: null,
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000004',
    project_name: LONG_NAME,
    dod: ['c'],
    amount_jpy: 50000, amount_minor: 50000, currency: 'JPY', deadline: localDate(-400),
    state: 'PERFORMANCE_ACCEPTED', performed_by: 'counterparty',
    earner_display_name: 'Me', invited_hirer_email: LONG_EMAIL, hirer_email: LONG_EMAIL,
    invite_token: null, invite_token_expires_at: null,
    invite_token_used_at: hoursFromNow(-4000),
    guest_access_token_expires_at: hoursFromNow(-1000),
    created_at: hoursFromNow(-4300),
    last_performance_type: 'performance.accepted',
  },
];

// ── The closed network ──────────────────────────────────────────────────────

/**
 * Serve `rows` to the list query, synthesise the events it follows up with,
 * and close every other door.
 *
 * The events stub carries the acceptance as well as the latest performance
 * statement: `accepted_at` comes from a `dod.consent_recorded` row, and
 * without one the "accepted N days ago" line this capture exists to show
 * would simply be absent. It is derived from `invite_token_used_at` so the
 * fixture cannot contradict itself.
 */
async function openHome(page, rows) {
  await page.route('**/auth/v1/**', route => json(
    route, { error: 'capture_run_creates_no_account' }, 400));

  await page.route('**/functions/v1/**', route => json(
    route, { error: 'no_edge_function_belongs_on_this_path' }, 500));

  // Registered FIRST on purpose: Playwright matches routes in REVERSE
  // registration order, so a catch-all added last swallows the specific
  // handlers below it and the list came back empty with nothing to say why.
  await page.route('**/rest/v1/**', route => json(route, []));

  await page.route('**/rest/v1/contracts*', async (route) => {
    if (route.request().method() !== 'GET') return json(route, []);
    return json(route, rows);
  });

  await page.route('**/rest/v1/events*', async (route) => {
    if (route.request().method() !== 'GET') return json(route, []);
    const events = [];
    for (const row of rows) {
      if (row.invite_token_used_at) {
        events.push({
          id: `accepted-${row.id}`,
          contract_id: row.id,
          type: 'dod.consent_recorded',
          actor_id: `guest:${row.hirer_email ?? 'unknown'}`,
          created_at: row.invite_token_used_at,
          payload: {},
        });
      }
      if (row.last_performance_type) {
        events.push({
          id: `performance-${row.id}`,
          contract_id: row.id,
          type: row.last_performance_type,
          actor_id: 'owner-uid',
          created_at: row.created_at,
          payload: row.last_performance_type === 'performance.rejected'
            ? { reason: 'page 2 of the notarised bundle was missing' } : {},
        });
      }
    }
    return json(route, events);
  });

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto('/');
}

/**
 * One image, named so the screen and the width are both obvious.
 *
 * Viewport by default, for the reason guest-path-capture.spec.js records: a
 * full-page shot stitches a document taller than the viewport and puts the
 * fixed header somewhere in the middle, which the first blind review reported
 * as a layout defect that does not exist. A screen that genuinely runs past
 * the fold gets a second shot with `{ full: true }`, named `-full`.
 */
async function shoot(page, name, { full = false } = {}) {
  const width = test.info().project.name;
  await page.screenshot({
    path: `${OUT}/${name}-${width}${full ? '-full' : ''}.png`,
    fullPage: full,
    animations: 'disabled',
  });
}

// ── The screens ─────────────────────────────────────────────────────────────

test('capture: the contracts home on an ordinary day', async ({ page }) => {
  await openHome(page, ORDINARY);

  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 }))
    .toBeVisible({ timeout: 15_000 });
  // The lead card is rendered from the first contract that needs the owner, so
  // waiting on its action line is waiting on the state being photographed.
  await expect(page.getByText('Ready for you to deliver').first()).toBeVisible();

  await expectNoHorizontalOverflow(page, '01-contracts-home');
  await shoot(page, '01-contracts-home');
  await shoot(page, '01-contracts-home', { full: true });
});

test('capture: the contracts home under stress', async ({ page }) => {
  await openHome(page, STRESS);

  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 }))
    .toBeVisible({ timeout: 15_000 });
  // The three-digit lateness and the one-day access warning are the two
  // numbers this fixture exists to put on screen.
  await expect(page.getByText('123 days late').first()).toBeVisible();
  await expect(page.getByText('1 day left').first()).toBeVisible();

  await expectNoHorizontalOverflow(page, '02-contracts-home-stress');
  await shoot(page, '02-contracts-home-stress');
  await shoot(page, '02-contracts-home-stress', { full: true });

  // Completed is collapsed by default, so its rows — which carry the same long
  // name and address — are never photographed unless it is opened.
  await page.getByRole('button', { name: /Completed/i }).click();
  await expect(page.getByText('Completed').first()).toBeVisible();
  await expectNoHorizontalOverflow(page, '03-contracts-home-stress-completed');
  await shoot(page, '03-contracts-home-stress-completed', { full: true });
});

test('capture: the contracts home with nothing on it', async ({ page }) => {
  // The empty state is the first screen a new account ever sees, and it is the
  // one no fixture-driven review ever looks at.
  await openHome(page, []);

  await expect(page.getByText('No contracts yet.')).toBeVisible({ timeout: 15_000 });

  await expectNoHorizontalOverflow(page, '04-contracts-home-empty');
  await shoot(page, '04-contracts-home-empty');
});

test('capture: the agreement screen, owner side', async ({ page }) => {
  await openHome(page, STRESS);
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 }))
    .toBeVisible({ timeout: 15_000 });

  // "Open" belongs to the lead card, which is the long-named, 123-days-late
  // contract — the one worth photographing on this screen too.
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByText('What counts as complete')).toBeVisible({ timeout: 15_000 });

  await expectNoHorizontalOverflow(page, '05-agreement-owner');
  await shoot(page, '05-agreement-owner');
  await shoot(page, '05-agreement-owner', { full: true });
});
