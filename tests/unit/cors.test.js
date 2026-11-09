import { describe, it, expect } from 'vitest'
import { ALLOW_HEADERS, corsHeaders } from '../../supabase/functions/_shared/cors.ts'

// The four live functions answered every origin with `Access-Control-Allow-
// Origin: *`. These pin the replacement, and the case that matters most is the
// one that is easy to break by accident: a caller with NO Origin header — every
// server-side client, including this project's own harnesses and anything
// written against /agent-protocol.md — must be completely unaffected.

const request = (headers = {}) => new Request('https://fn.example/x', { headers })

describe('CORS for the live Edge Functions', () => {
  it('leaves a caller that sends no Origin entirely alone', () => {
    const headers = corsHeaders(request())
    // No allowance, because CORS is not in play at all for a non-browser
    // caller. The function still runs and still answers — that is the point.
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers['Access-Control-Allow-Headers']).toBe(ALLOW_HEADERS)
  })

  it('echoes the production web app origin', () => {
    const headers = corsHeaders(request({ Origin: 'https://project-trustflow.vercel.app' }))
    expect(headers['Access-Control-Allow-Origin']).toBe('https://project-trustflow.vercel.app')
  })

  it('echoes the dev server and the Playwright baseURL', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  // Every one of these was read back from the Vercel API for this project
  // (`list_aliases`, 2026-11-09). They are in the list because they were
  // verified to belong to it, not because they match its name.
  it('echoes the verified aliases of this project, branch alias included', () => {
    for (const origin of [
      'https://project-trustflow-team-kenji.vercel.app',
      // The one the first version of this module REJECTED: Vercel's branch
      // alias is <project>-git-<branch>-<scope>, and `git-main` contains a
      // hyphen the old `[a-z0-9]+` could not match. Codex's finding 1.
      'https://project-trustflow-git-main-team-kenji.vercel.app',
      'https://trustflow-team-kenji.vercel.app',
      'https://trustflow-git-main-team-kenji.vercel.app',
    ]) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin'],
        `${origin} is a verified alias of this project`).toBe(origin)
    }
  })

  // Codex's finding 2, and the reason there is no pattern any more. The old
  // matcher made the team suffix optional, so it accepted anything shaped like
  // this project's name — which is also the shape of the ROOT alias of a
  // DIFFERENT project. `<name>.vercel.app` is claimed globally, first come
  // first served, so a name prefix is not ownership. Requiring the team suffix
  // would not have fixed it either: anyone can create a project called
  // `project-trustflow-x-team-kenji` in their own account.
  it('refuses hostnames that merely look like this project', () => {
    for (const origin of [
      // The exact probe from the review.
      'https://project-trustflow-attacker.vercel.app',
      // Same shape, with the team slug glued into the project name.
      'https://project-trustflow-x-team-kenji-attacker.vercel.app',
      // A per-commit preview URL. Unpredictable by design, so it is not
      // matched by shape — it goes through TF_ALLOWED_ORIGINS or not at all.
      'https://project-trustflow-p8zf16a6m-team-kenji.vercel.app',
      // A branch alias for a branch nobody verified.
      'https://project-trustflow-git-evil-team-kenji.vercel.app',
    ]) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin'],
        `${origin} must not be allowed on name resemblance alone`).toBeUndefined()
    }
  })

  it('refuses everything else, including the lookalikes', () => {
    for (const origin of [
      'https://evil.example',
      'https://other-project.vercel.app',
      // A substring match would let these through.
      'https://project-trustflow.vercel.app.evil.example',
      'https://evil-project-trustflow-abc-team-kenji.vercel.app',
      // http, where the real origin is https.
      'http://project-trustflow.vercel.app',
      // An opaque origin, from a sandboxed iframe or a file:// page.
      'null',
      // The wildcard itself must never come back.
      '*',
    ]) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin'],
        `${origin} must not be allowed`).toBeUndefined()
    }
  })

  describe('the explicit opt-in for unpredictable preview URLs', () => {
    const PREVIEW = 'https://project-trustflow-p8zf16a6m-team-kenji.vercel.app'

    it('admits exactly what TF_ALLOWED_ORIGINS names, and nothing adjacent', () => {
      const before = process.env.TF_ALLOWED_ORIGINS
      try {
        process.env.TF_ALLOWED_ORIGINS = ` ${PREVIEW} , https://another.example `
        expect(corsHeaders(request({ Origin: PREVIEW }))['Access-Control-Allow-Origin']).toBe(PREVIEW)
        expect(corsHeaders(request({ Origin: 'https://another.example' }))['Access-Control-Allow-Origin'])
          .toBe('https://another.example')
        // Naming one preview must not admit its namespace.
        expect(corsHeaders(request({ Origin: 'https://project-trustflow-other-team-kenji.vercel.app' }))['Access-Control-Allow-Origin'])
          .toBeUndefined()
      } finally {
        if (before === undefined) delete process.env.TF_ALLOWED_ORIGINS
        else process.env.TF_ALLOWED_ORIGINS = before
      }
    })

    it('allows nothing extra when unset or empty', () => {
      const before = process.env.TF_ALLOWED_ORIGINS
      try {
        for (const value of ['', '   ', ',,', undefined]) {
          if (value === undefined) delete process.env.TF_ALLOWED_ORIGINS
          else process.env.TF_ALLOWED_ORIGINS = value
          expect(corsHeaders(request({ Origin: PREVIEW }))['Access-Control-Allow-Origin']).toBeUndefined()
          // And an empty entry must never become a match-anything hole.
          expect(corsHeaders(request({ Origin: '' }))['Access-Control-Allow-Origin']).toBeUndefined()
        }
      } finally {
        if (before === undefined) delete process.env.TF_ALLOWED_ORIGINS
        else process.env.TF_ALLOWED_ORIGINS = before
      }
    })
  })

  it('never answers with a wildcard, whatever was asked', () => {
    for (const origin of [undefined, 'https://project-trustflow.vercel.app', 'https://evil.example']) {
      const headers = corsHeaders(request(origin ? { Origin: origin } : {}))
      expect(headers['Access-Control-Allow-Origin']).not.toBe('*')
    }
  })

  it('varies by origin, so a cache cannot lend one origin\'s allowance to another', () => {
    expect(corsHeaders(request()).Vary).toBe('Origin')
    expect(corsHeaders(request({ Origin: 'https://project-trustflow.vercel.app' })).Vary).toBe('Origin')
  })

  it('advertises the guest token header, for every function', () => {
    // One union list for all four. A function that reads a header it forgot to
    // advertise fails the preflight in a browser and nowhere else, which is a
    // bug this project has already shipped once.
    expect(ALLOW_HEADERS).toContain('x-guest-access-token')
    expect(ALLOW_HEADERS).toContain('authorization')
    expect(ALLOW_HEADERS).toContain('apikey')
    expect(ALLOW_HEADERS).toContain('content-type')
  })
})
