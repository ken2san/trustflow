// Render the New contract form, and fail if it crashes or cuts a field off.
//
// WHY THIS EXISTS
// Nothing rendered this form under test. In Task 47 the "Your client will see"
// preview read a variable that had just been removed; tests and build both
// passed, and only lint stood between that and a crash the moment the preview
// appeared. The same task found the Amount box 67px wide on desktop, too narrow
// for "1000", which no assertion was going to notice either.
//
// So this opens the form, fills enough of it to make the preview render, and
// checks that Amount and Deadline are there and wide enough for their content.
//
// WRITES NOTHING. Send Invite is never clicked, and `auth/v1/**`, `rest/v1/**`
// and the Edge Functions are all fulfilled from here, so even a stray request
// cannot reach a backend. Turnstile is aborted: CaptchaChallenge renders
// nothing when it cannot load, which is the state this test wants.

import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow } from './layoutOverflow.js';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

/** A `deadline` value: a local calendar day, as the date input reads it. */
function localDate(daysFromNow) {
  const at = new Date(Date.now() + daysFromNow * 86_400_000);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/** Fail unless the input shows all of its value and sits inside the modal. */
async function expectFits(input, modal, label) {
  await input.scrollIntoViewIfNeeded();
  const fit = await input.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fit.scroll, `${label} is cut off: needs ${fit.scroll}px, has ${fit.client}px`)
    .toBeLessThanOrEqual(fit.client);

  const box = await input.boundingBox();
  const frame = await modal.boundingBox();
  expect(box.x, `${label} starts outside the form`).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width, `${label} ends outside the form`)
    .toBeLessThanOrEqual(frame.x + frame.width);
}

test('the New contract form renders with Amount and Deadline in full', async ({ page }) => {
  const crashes = [];
  page.on('pageerror', error => crashes.push(error.message));

  await page.route('**/challenges.cloudflare.com/**', route => route.abort());
  await page.route('**/auth/v1/**', route => json(
    route, { error: 'form_render_creates_no_account' }, 400));
  await page.route('**/functions/v1/**', route => json(
    route, { error: 'no_edge_function_belongs_on_this_path' }, 500));
  await page.route('**/rest/v1/**', route => json(route, []));

  await page.addInitScript(() => localStorage.setItem('tf_onboarded', '1'));
  await page.goto('/');

  await page.getByRole('button', { name: /New contract/i }).first().click();
  const sendInvite = page.getByRole('button', { name: 'Send Invite' });
  await expect(sendInvite).toBeVisible({ timeout: 15_000 });
  const modal = page.locator('div.max-w-md', { has: sendInvite });

  // The preview only renders once a name and a project name are in, and it is
  // the part that crashed, so it has to be made to appear.
  await modal.getByPlaceholder('Shown to your client').fill('Ada Example');
  await modal.getByPlaceholder(/Mobile app redesign/).fill('Form render check');

  // A render crash unmounts the whole app, so the preview simply never shows.
  // The page errors are attached so the failure says why.
  const preview = modal.getByText('Your client will see').locator('..');
  await expect(preview).toBeVisible().catch((error) => {
    throw new Error(`the preview never appeared; page errors: ${crashes.join('\n') || 'none'}`, { cause: error });
  });

  const amount = modal.getByRole('textbox', { name: 'Amount' });
  const deadline = modal.locator('input[type="date"]');
  await expect(amount).toBeVisible();
  await expect(deadline).toBeVisible();

  await modal.getByRole('combobox', { name: 'Currency' }).selectOption('CAD');
  // The longest ordinary amount: what a box sized for "1000" would clip.
  await amount.fill('1234567.89');
  await deadline.fill(localDate(14));

  await expect(preview).not.toContainText('No amount');
  await expect(preview).toContainText(`due ${localDate(14)}`);

  await expectFits(amount, modal, 'Amount');
  await expectFits(deadline, modal, 'Deadline');
  await expectNoHorizontalOverflow(page, 'the New contract form');
  expect(crashes, `the form threw: ${crashes.join('\n')}`).toEqual([]);
});
