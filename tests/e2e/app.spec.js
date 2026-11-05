import { test, expect } from '@playwright/test';

// Skip onboarding by setting localStorage before each test
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tf_onboarded', '1');
  });
});

/**
 * The marketplace is no longer in the primary navigation, but it is not
 * deleted — the command palette is the remaining way in, and these two tests
 * cover the fixture-job flow that still lives there. When that flow is
 * eventually removed, these go with it.
 */
async function openLegacyMarketplace(page) {
  await page.keyboard.press('Meta+k');
  await page.getByText('Open Marketplace (legacy)').click();
  await expect(page.getByRole('button', { name: 'View Details' }).first()).toBeVisible({ timeout: 15_000 });
}

// ── 1. App loads ─────────────────────────────────────────────────────────────

test('app loads on the contracts home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /New contract/i }).first()).toBeVisible();
});

// ── 2. Mode switching ────────────────────────────────────────────────────────

test('can switch between Earner and Hirer modes', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Switch to Hire' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: 'Switch to Work' })).toBeVisible();
});

// ── 3. Marketplace → Project Detail ──────────────────────────────────────────

test('clicking View Details navigates to project detail', async ({ page }) => {
  await page.goto('/');
  await openLegacyMarketplace(page);
  await page.getByRole('button', { name: 'View Details' }).first().click();
  await expect(page.getByRole('heading', { name: 'Project Overview' })).toBeVisible({ timeout: 5000 });
});

// ── 4. Contract flow ─────────────────────────────────────────────────────────

test('can initiate contract and reach contract view', async ({ page }) => {
  await page.goto('/');
  await openLegacyMarketplace(page);
  await page.getByRole('button', { name: 'View Details' }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Initiate Contract' }).click();
  await page.waitForTimeout(300);
  // Confirm modal appears — click Confirm
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(500);
  // Contract step tracker shows "PROTOCOL" as first step
  await expect(page.locator('text=PROTOCOL').first()).toBeVisible({ timeout: 5000 });
});

// ── 5. Trust Passport modal ──────────────────────────────────────────────────

test('Trust Passport is reachable, and no avatar claims to be the account', async ({ page }) => {
  await page.goto('/');

  // The header avatar is gone. It rendered USER_PROFILE.name[0] — a hardcoded
  // fixture, not the signed-in account — so it read "F" for everyone, on every
  // screen, beside the Sign in button. Same treatment as Command Center above:
  // the view stays, the palette reaches it, the nav does not assert an
  // identity it never knew.
  await expect(page.locator('nav .w-9.h-9.rounded-full.cursor-pointer')).toHaveCount(0);

  await page.keyboard.press('Meta+k');
  await page.getByText('View Trust Passport').click();
  await expect(page.locator('text=/Performance Metrics|Behavior Signals/i').first()).toBeVisible({ timeout: 5000 });
});

// ── 6. Wallet view ───────────────────────────────────────────────────────────

test('wallet view loads and shows the TrustPoints balance', async ({ page }) => {
  await page.goto('/');
  // The points chip in the header. Its title is level-gated in principle, but
  // wallet unlocks at level 1 and uiProfile.level defaults to 1, so it always
  // reads "Open Wallet" in practice.
  await page.locator('[title="Open Wallet"]').click();

  // The view was rebuilt as a TrustPoints passport. It previously showed
  // "Net Liquidity"; that string exists nowhere in src/ any more, so the old
  // assertion could never pass again — this was a stale test, not a product
  // regression.
  await expect(page.getByText(/TrustPoints balance/i).first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/Points History/i).first()).toBeVisible();
});

// ── 7. Command Center ────────────────────────────────────────────────────────

test('command center is still reachable, just not from the primary nav', async ({ page }) => {
  await page.goto('/');
  // Its header button is gone: it was a second dashboard competing with the
  // contracts home. The view itself is untouched and the palette still opens it.
  await expect(page.getByRole('button', { name: 'Command Center' })).toHaveCount(0);

  await page.keyboard.press('Meta+k');
  await page.getByText('Open Command Center (legacy)').click();
  await expect(page.locator('text=Active Operations').first()).toBeVisible({ timeout: 15_000 });
});

// ── 8. Cmd+K opens command palette ───────────────────────────────────────────

test('Cmd+K opens command palette', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click(); // ensure page has focus
  await page.keyboard.press('Meta+k');
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 5000 });
});
