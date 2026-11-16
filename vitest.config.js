import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The automatic JSX runtime, as the app build uses (vite.config.js's react
  // plugin). Without it, a view that does not import React — GuestEvidenceView —
  // throws "React is not defined" the first time a test renders it.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
})
