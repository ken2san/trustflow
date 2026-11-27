// Minimal offline Playwright config for Row 6 browser regression checks.
//
// Runs two local Vite servers against a dummy unroutable Supabase origin
// (`http://127.0.0.1:54399`): all auth, REST, and Edge Function calls are
// intercepted in-browser via `page.route` / `context.route`, and any
// unmocked request is aborted. Zero hosted requests, zero `.env.e2e` reads.
//
// Run:
//   npx playwright test --config tests/browser/playwright.row6.config.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFLINE_SUPABASE_URL = 'http://127.0.0.1:54399';
const OFFLINE_SUPABASE_ANON_KEY = 'offline-row6-anon-key';

const sharedViteEnv = {
  ...process.env,
  VITE_SUPABASE_URL: OFFLINE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: OFFLINE_SUPABASE_ANON_KEY,
  // Explicitly pin to '' so process env overrides any local `.env*` setting.
  VITE_OWNER_CREDENTIALS_UI: '',
};

export default defineConfig({
  testDir: '.',
  testMatch: ['row6-credentials.spec.js'],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['../reporters/noSilentSkip.js']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'on-first-retry',
    storageState: { cookies: [], origins: [] },
  },
  webServer: [
    {
      command: 'npx vite --host 127.0.0.1 --port 4176 --strictPort',
      cwd: REPO_ROOT,
      url: 'http://127.0.0.1:4176',
      reuseExistingServer: false,
      timeout: 20_000,
      env: sharedViteEnv,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 4177 --strictPort',
      cwd: REPO_ROOT,
      url: 'http://127.0.0.1:4177',
      reuseExistingServer: false,
      timeout: 20_000,
      env: {
        ...sharedViteEnv,
        VITE_OWNER_CREDENTIALS_UI: 'on',
      },
    },
  ],
  projects: [
    {
      name: 'row6-flag-off',
      use: { baseURL: 'http://127.0.0.1:4176' },
      grep: /@flag-off/,
    },
    {
      name: 'row6-flag-on',
      use: { baseURL: 'http://127.0.0.1:4177' },
      grep: /@flag-on/,
    },
  ],
});
