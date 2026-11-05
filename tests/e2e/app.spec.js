import { test, expect } from '@playwright/test';

// Skip onboarding by setting localStorage before each test
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tf_onboarded', '1');
  });
});

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

// The marketplace and its project detail, the five-step contract flow, the
// Trust Passport, the wallet and the Command Center were removed with the
// legacy surface (Decisions.md, 2026-11-05). Their tests went with them —
// the helper above said they would. contract-flow.spec.js is deleted whole.
//
// What still covers the ground that mattered: contracts-home.spec.js asserts
// that opening a contract reaches the agreement and NOT the escrow flow, and
// runtimeState.test.js asserts the wallet is no longer restorable.

// ── Cmd+K opens command palette ───────────────────────────────────────────

test('Cmd+K opens command palette', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click(); // ensure page has focus
  await page.keyboard.press('Meta+k');
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 5000 });
});
