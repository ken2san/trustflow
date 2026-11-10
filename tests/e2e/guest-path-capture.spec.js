// Capture the counterparty's path as images, at the boundaries that matter.
//
// WHY THIS EXISTS
// The visual review of 2026-11-04 (HANDOFF.md) found a real defect an assertion
// was never going to catch: the two lines carrying the most legally significant
// fact on the guest's record were rendered at roughly invisible contrast. The
// method worked, and it was left unrepeatable — frames were pulled out of
// Playwright traces by hand, and the last frame of a trace is not reliably the
// state the test asserted. That write-up named the fix: "the tests need
// explicit screenshots". This is that.
//
// It asserts almost nothing. Its output is the five screens a stranger reads,
// in both widths, for a reviewer who has not seen this repository to judge
// blind. A test that asserted what those screens should say would be written by
// the same person who wrote them, which is the blindness being worked around.
// The one thing it does assert is that the state it is about to photograph is
// actually on screen: a screenshot taken before a render is worth nothing, and
// mid-animation frames are what made hand-picked trace frames unreliable.
//
// WRITES NOTHING. Every Edge Function, every REST call and — unlike the other
// stub-closed specs — `auth/v1/signup` are fulfilled from here, so a capture
// run adds no anonymous user and no contract to the E2E project. HANDOFF.md
// records that the four stub-closed spec files still took `auth.users` from 57
// to 87 rows, one per test, because nothing stubbed signup. Repeatable capture
// is the case where that actually matters.
//
// Output: test-results/guest-path/ (gitignored), one set per project width.

import { test, expect } from '@playwright/test';

// The deal on screen. Deliberately an ordinary small job rather than a demo
// one, because a reviewer reads the numbers as well as the layout.
const ACCEPTED = {
  snapshot_version: 1,
  project_name: 'Certified translation of a birth certificate',
  dod: ['translate the document', 'return a stamped PDF'],
  amount: 20000,
  currency: 'JPY',
  deadline: '2026-11-30',
  performed_by: 'creator',
  offered_by: 'Acme Translations',
};

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INVITE_TOKEN = '22222222-2222-4222-8222-222222222222';

// The invitation goes to one address and someone else accepts it. That is the
// distinction the product exists to record, so it is the one a reviewer should
// be shown rather than a tidy case where both match.
const INVITED = 'invited@example.test';
const CLAIMED = 'someone.else@example.test';

const OUT = 'test-results/guest-path';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

/**
 * Close every door to the network, then open the invitation.
 *
 * The stubs are a copy of agreement-record-ui.spec.js's, not an import: that
 * file's helper carries drift-override machinery this does not need, and its
 * assertions are its own. Converging the two is worth doing and is not this
 * change — reported rather than done (AGENTS.md, Scope Policy).
 */
async function openInvitation(page) {
  // No account is created for a guest, and this spec does not want one for the
  // app shell either: ensureActorIdentity falls back to a local device id when
  // signInAnonymously fails, which is all the snapshot code needs.
  await page.route('**/auth/v1/**', route => json(
    route, { error: 'capture_run_creates_no_account' }, 400));

  // Nothing on this path reads the database directly, but an unstubbed REST
  // call would still reach the live project — including the runtime snapshot
  // insert the app makes on a debounce.
  await page.route('**/rest/v1/**', route => json(route, []));

  await page.route('**/functions/v1/validate-invite-token', route => json(route, {
    contract_id: CONTRACT_ID,
    project_name: ACCEPTED.project_name,
    dod: ACCEPTED.dod,
    amount_jpy: ACCEPTED.amount,
    currency: ACCEPTED.currency,
    deadline: ACCEPTED.deadline,
    earner_display_name: ACCEPTED.offered_by,
    invited_hirer_email: INVITED,
    performed_by: ACCEPTED.performed_by,
    guest_access_token: 'stub-guest-token',
  }));

  // Acceptance writes its own evidence server-side; a client that regressed to
  // calling this would fail loudly rather than quietly produce a nicer photo.
  await page.route('**/functions/v1/log-event', route => json(
    route, { error: 'log_event_should_not_be_called_on_acceptance' }, 500));

  await page.route('**/functions/v1/guest-contract-events', route => json(route, {
    accepted_agreement: ACCEPTED,
    acceptance_identity: {
      invited_recipient: INVITED,
      claimed_identity: CLAIMED,
      claimed_identity_verified: false,
      authentication: 'invite_capability',
    },
    terms_changed_since_acceptance: [],
    contract: {
      id: CONTRACT_ID,
      project_name: ACCEPTED.project_name,
      dod: ACCEPTED.dod,
      amount_jpy: ACCEPTED.amount,
      currency: ACCEPTED.currency,
      deadline: ACCEPTED.deadline,
      state: 'TERMS_ACCEPTED',
      performed_by: ACCEPTED.performed_by,
      viewer_role: 'receiver',
      earner_display_name: ACCEPTED.offered_by,
      hirer_email: CLAIMED,
    },
    events: [{
      id: '44444444-4444-4444-8444-444444444444',
      type: 'dod.consent_recorded',
      created_at: '2026-09-24T12:00:00.000Z',
      actor: { id: null, role: 'guest_hirer', label: 'You' },
      dod_hash: 'terms-hash',
      payload: { counterparty_name: 'Guest' },
      integrity: {
        trust_model: 'server_attested',
        event_hash: 'abc', prev_event_hash: 'GENESIS',
        hash_valid: true, chain_linked: true, substance_valid: true,
        binds_whole_agreement: true,
      },
    }],
    chain: {
      event_count: 1, server_attested: 1, client_asserted: 0,
      verified: true, truncated: false, payload_covered_by_hash: true,
    },
  }));

  // The onboarding overlay is its own screen and is not what this captures.
  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${INVITE_TOKEN}`);
}

/**
 * One image, named so the order and the width are both obvious.
 *
 * Viewport, not full page. The first run captured `fullPage: true` and the
 * reviewer reported the header bar rendering in the middle of the page and
 * covering the heading, as a layout defect — it is not one. A full-page
 * capture stitches a document taller than the viewport, and the app's fixed
 * header lands wherever it was when the shot was taken. The image a reviewer
 * judges has to be the image a person sees. Where a screen genuinely runs
 * past the fold, take a second shot with `{ full: true }` and say so in the
 * name, so the stitching artefact is never mistaken for the product again.
 */
async function shoot(page, name, { full = false } = {}) {
  const width = test.info().project.name;
  const suffix = full ? '-full' : '';
  // `animations: 'disabled'` fast-forwards CSS animations and transitions to
  // their end state. Without it every shot catches the app's fade-in mid
  // flight and the whole screen reads as washed out — which the first blind
  // review duly reported as a contrast problem across screen 01.
  await page.screenshot({
    path: `${OUT}/${name}-${width}${suffix}.png`,
    fullPage: full,
    animations: 'disabled',
  });
}

// Phone width gets three times the total budget; every `expect` timeout stays
// as it is, so a stuck render still fails at the step where it sticks. Each
// screenshot at Pixel 7's 2.625x scale re-rasterises NeuralBackground's two
// `blur-[120px]` layers in software, which headless Chromium does without a
// GPU. Measured 2026-11-10 (.ada/claude-report-49.md): the long test takes
// 12.0 s alone (desktop 4.8 s) and 42.9-47.5 s with 7 copies in parallel,
// the full suite's default worker count here, so 30 s failed intermittently
// under full-suite load. Turning the blur off brought it back to 15-16 s.
// Capturing at CSS scale or with the blur removed would also fix it, but the
// image a reviewer judges would then not be the image a person sees.
test.beforeEach(() => {
  test.slow(test.info().project.name === 'chromium-mobile-ui',
    'software-rendered 120px blurs at phone device scale; see comment above');
});

test('capture: what the counterparty is shown, start to record', async ({ page }) => {
  // Animations finish before each shot or the image shows a half-faded card;
  // `animations: 'disabled'` is per-screenshot in Playwright, so the explicit
  // visibility assertions below are what actually make the state definite.
  await openInvitation(page);

  // 1. The first screen: the terms, and three cards making claims about what
  //    this product does. Those claims are the thing most worth reading blind.
  await expect(page.getByText(ACCEPTED.project_name).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Who does the work')).toBeVisible();
  const details = page.locator('details').filter({ hasText: 'Details: what you get by joining' });
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(details.getByText(/Accepting writes down these exact terms/)).toBeVisible();
  await details.locator('summary').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, '01-invitation');

  // 2. Identity and consent — the only point at which the guest types anything
  //    that ends up inside the hashed record.
  await page.getByRole('button', { name: 'Review Agreement' }).click();
  await expect(page.getByPlaceholder('Your name or handle')).toBeVisible();
  await shoot(page, '02-identify');

  // 3. The same screen with the form filled and consent given: what a person
  //    sees at the moment they commit.
  await page.getByPlaceholder('Your name or handle').fill('Guest');
  // Type the address the record will later show as claimed. The first run left
  // the prefilled invited address in the field while the stubbed record
  // reported a different one, and the reviewer read that contradiction as a
  // product defect. A fixture that disagrees with itself spends the reviewer's
  // attention on the fixture.
  await page.getByRole('textbox', { name: /email/i }).or(page.locator('input[type="email"]'))
    .first().fill(CLAIMED);
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: /I Agree/ })).toBeEnabled();
  await shoot(page, '03-about-to-agree');

  // 4. Immediately after accepting. This is the screen whose green "recorded"
  //    toast was the brightest thing on the page while the identity block was
  //    the dimmest, which is the 2026-11-04 finding.
  await page.getByRole('button', { name: /I Agree/ }).click();
  await expect(page.getByRole('button', { name: 'View the full verification detail' }))
    .toBeVisible({ timeout: 15_000 });
  await shoot(page, '04-accepted');

  // 5. The record of agreement itself, full height.
  await page.getByRole('button', { name: 'View the full verification detail' }).click();
  await expect(page.getByRole('heading', { name: 'Record of agreement' }))
    .toBeVisible({ timeout: 15_000 });
  // The acceptance-identity block is the part worth photographing properly: it
  // is where the invited address and the claimed one appear side by side.
  await expect(page.getByText(INVITED).first()).toBeVisible();
  await expect(page.getByText(CLAIMED).first()).toBeVisible();
  await shoot(page, '05-record');
  // This one does run past the fold, and the part below it — the footnote
  // about what a hash does and does not cover — is the honest half.
  await shoot(page, '05-record', { full: true });
});

test('capture: the terms changed while the guest was reading', async ({ page }) => {
  // The screen behind the guard added on 2026-11-05: the client re-reads the
  // invitation immediately before accepting, and refuses when the terms moved.
  // Captured because it is a screen a stranger meets at the worst moment —
  // having decided to accept — and nothing else photographs it.
  await page.route('**/auth/v1/**', route => json(
    route, { error: 'capture_run_creates_no_account' }, 400));
  await page.route('**/rest/v1/**', route => json(route, []));

  // Driven by a flag the test flips, not by a call count: the number of reads
  // the app makes before the guest clicks is not this test's business, and
  // counting them made the fixture — not the product — decide the outcome.
  let ownerHasEdited = false;
  await page.route('**/functions/v1/validate-invite-token', route => {
    return json(route, {
      contract_id: CONTRACT_ID,
      project_name: ACCEPTED.project_name,
      dod: ACCEPTED.dod,
      // The owner raises the price while the guest is reading.
      amount_jpy: ownerHasEdited ? ACCEPTED.amount * 2 : ACCEPTED.amount,
      currency: ACCEPTED.currency,
      deadline: ACCEPTED.deadline,
      earner_display_name: ACCEPTED.offered_by,
      invited_hirer_email: INVITED,
      performed_by: ACCEPTED.performed_by,
      guest_access_token: 'stub-guest-token',
    });
  });

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${INVITE_TOKEN}`);
  await expect(page.getByText(ACCEPTED.project_name).first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Review Agreement' }).click();
  await page.getByPlaceholder('Your name or handle').fill('Guest');
  await page.getByRole('checkbox').check();

  ownerHasEdited = true;
  await page.getByRole('button', { name: /I Agree/ }).click();

  await expect(page.getByText(/terms changed/i)).toBeVisible({ timeout: 15_000 });
  await shoot(page, '07-terms-changed');
});

test('capture: the invitation a guest cannot use', async ({ page }) => {
  // A stranger meeting a dead link is a first impression too, and it is the
  // state the owner's "delete an unaccepted draft" feature produces for them.
  await page.route('**/auth/v1/**', route => json(
    route, { error: 'capture_run_creates_no_account' }, 400));
  await page.route('**/rest/v1/**', route => json(route, []));
  await page.route('**/functions/v1/validate-invite-token', route => json(
    route, { error: 'invite_not_found' }, 404));

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto(`/?token=${INVITE_TOKEN}`);

  await expect(page.locator('body')).toContainText(/invit|link|expired|not found/i, { timeout: 15_000 });
  await shoot(page, '06-dead-link');
});
