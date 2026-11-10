import { defineConfig, devices } from '@playwright/test';
import { SUPABASE_URL, SUPABASE_KEY } from './tests/e2e/liveEnv.js';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  // 'list' prints the run; noSilentSkip decides whether an empty one counts as a
  // pass. Playwright exits 0 when every test is skipped, which is precisely the
  // failure this project already shipped a production bug through.
  reporter: [['list'], ['./tests/reporters/noSilentSkip.js']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    // Skip onboarding via localStorage mock
    storageState: { cookies: [], origins: [] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 15_000,
    // The app under test must reach the same Supabase project the tests do.
    // Vite would otherwise take these from .env, which is a different file from
    // the .env.e2e the tests read — so a separate E2E project would redirect the
    // API-level suites and leave the browser-driven ones writing to production.
    // reuseExistingServer means this can still be bypassed by a server that was
    // already up, which is what tests/e2e/00-backend-guard.spec.js checks.
    env: {
      ...process.env,
      VITE_SUPABASE_URL: SUPABASE_URL ?? '',
      VITE_SUPABASE_ANON_KEY: SUPABASE_KEY ?? '',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile-ui',
      // Only these four UI-focused suites plus the accessibility checks run at
      // phone width. `grep` narrows mixed files to cases whose network calls
      // are stubbed, so the mobile project cannot duplicate the live API tests.
      testMatch: [
        '**/contracts-home.spec.js',
        '**/agreement-record-ui.spec.js',
        '**/agreement-export.spec.js',
        '**/earner-signin.spec.js',
        '**/visual-accessibility.spec.js',
        // The capture spec belongs here for the reason the project exists: the
        // review it feeds is about whether a screen can be read, and a phone is
        // where a counterparty most likely reads it. It stubs every call
        // including auth, so it cannot write at either width.
        '**/guest-path-capture.spec.js',
        // Same reason, from the owner's side: the contracts home is a list of
        // rows whose content can be far wider than a phone, and the overflow
        // assertion it carries only means something at a width where a layout
        // can actually run out of room.
        '**/owner-screens-capture.spec.js',
        // The New contract form stacked Amount and Deadline because the
        // desktop modal cut Amount off; phone width is the other half of that
        // check. Every call is stubbed, so it writes nothing at either width.
        '**/new-contract-form.spec.js',
      ],
      // A denylist, not an allowlist. Codex's first version listed every
      // included test title in one regex, which fails silently in the worst
      // direction: add a test and it is simply not covered at phone width,
      // with nothing to notice. Naming the five live-session cases instead
      // means a newly added test is covered by default, and if it turns out
      // to need a real account it fails loudly rather than vanishing.
      grepInvert: /listContracts scoping|a returning Earner with a restored session|signing out clears the list|sign-in cannot create an account/,
      use: { ...devices['Pixel 7'] },
    },
  ],
});
