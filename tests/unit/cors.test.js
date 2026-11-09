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

  it('echoes this project\'s own Vercel preview deployments', () => {
    for (const origin of [
      'https://project-trustflow-p8zf16a6m-team-kenji.vercel.app',
      'https://project-trustflow-gtwebnfjh-team-kenji.vercel.app',
      'https://project-trustflow-67pui5q0x.vercel.app',
    ]) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('refuses everything else, including the lookalikes', () => {
    for (const origin of [
      'https://evil.example',
      // Not this project, despite the suffix.
      'https://other-project.vercel.app',
      // A prefix match would let this through; the pattern is anchored.
      'https://project-trustflow.vercel.app.evil.example',
      // And so would a loose suffix match.
      'https://evil-project-trustflow-abc-team-kenji.vercel.app',
      // http, where the real origins are https.
      'http://project-trustflow.vercel.app',
      // The wildcard itself must never come back.
      '*',
    ]) {
      expect(corsHeaders(request({ Origin: origin }))['Access-Control-Allow-Origin'],
        `${origin} must not be allowed`).toBeUndefined()
    }
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
