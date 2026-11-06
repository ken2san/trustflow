import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// There was no Vite config in this project at all until 2026-11-05, which
// meant @vitejs/plugin-react — a declared devDependency since the project was
// scaffolded — was never applied. Without it, esbuild compiles .jsx with the
// CLASSIC runtime, so every JSX file needs `React` in scope even though no
// line of it mentions React. That is why every component carried an
// `import React from 'react'` that looked unused.
//
// It became visible the hard way. ESLint's no-unused-vars reported those
// imports as unused — correct about the source text, wrong about the build —
// and removing them took the app to `ReferenceError: React is not defined`.
// knip had separately reported @vitejs/plugin-react as an unused dependency,
// which was TRUE and which I had silenced in knip.json on the assumption that
// a Vite project must obviously be using it. Two tools said the same thing
// from different directions and I overrode one of them.
//
// Adding the plugin fixes the cause rather than the symptom: the automatic JSX
// runtime needs no React import, Fast Refresh works in dev, and the dependency
// is no longer a lie.
export default defineConfig({
  plugins: [react()],
})
