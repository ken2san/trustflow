import { describe, it, expect } from 'vitest'
import {
  assuranceFromClaims, bearerAssurance, assuranceMeaning, stepUpRequired,
  RECENT_AUTHENTICATION_WINDOW_SECONDS,
} from '../../supabase/functions/_shared/authAssurance.ts'

// Taken verbatim from a live Supabase JWT on 2026-10-11, which is the point:
// these claims exist on every request today and are discarded.
const AUTH_TS = 1791731476
const NOW = new Date((AUTH_TS + 11) * 1000)
const REAL_CLAIMS = {
  aal: 'aal1',
  amr: [{ method: 'password', timestamp: AUTH_TS }],
  is_anonymous: false,
  session_id: 'f0e4c2f7-0000-0000-0000-000000000000',
}

describe('assurance is read from the session, not inferred from the role', () => {
  it('records the method the JWT actually reports', () => {
    const a = assuranceFromClaims(REAL_CLAIMS, NOW)
    expect(a.method).toBe('password')
    expect(a.aal).toBe('aal1')
    expect(a.assurance).toBe('account_session')
  })

  it('distinguishes an emailed OTP from a password — the thing today cannot', () => {
    // Both produce _auth_method: 'account_session' in the current code, so a
    // script and a person are indistinguishable in the record.
    const otp = assuranceFromClaims({ ...REAL_CLAIMS, amr: [{ method: 'otp', timestamp: AUTH_TS }] }, NOW)
    const pwd = assuranceFromClaims(REAL_CLAIMS, NOW)
    expect(otp.method).not.toBe(pwd.method)
  })

  it('records when the credential was presented, not when the event was written', () => {
    const a = assuranceFromClaims(REAL_CLAIMS, NOW)
    expect(a.authenticated_at).toBe(new Date(AUTH_TS * 1000).toISOString())
    expect(a.seconds_since_authentication).toBe(11)
  })

  it('separates a recent login from one three weeks old', () => {
    const fresh = assuranceFromClaims(REAL_CLAIMS, NOW)
    const stale = assuranceFromClaims(REAL_CLAIMS, new Date((AUTH_TS + 21 * 86400) * 1000))
    expect(fresh.recent_authentication).toBe(true)
    expect(stale.recent_authentication).toBe(false)
    expect(stale.seconds_since_authentication).toBe(21 * 86400)
  })

  // The correction that matters most in this file. Recency is not binding, and
  // an earlier version of this module reported it as though it were.
  it('never infers act-binding from recency, however recent', () => {
    for (const now of [NOW, new Date((AUTH_TS + 1) * 1000), new Date(AUTH_TS * 1000)]) {
      const a = assuranceFromClaims(REAL_CLAIMS, now)
      expect(a.recent_authentication).toBe(true)
      // A one-second-old login is still not evidence of intent for this act.
      expect(a.act_bound_authentication).toBe(false)
      expect(a.act_binding_mechanism).toBeNull()
    }
  })

  it('records act-binding as an answered question, not an absent field', () => {
    // A reader must be able to see that it was asked, so `false` is recorded
    // rather than the key being omitted.
    for (const a of [assuranceFromClaims(REAL_CLAIMS, NOW), bearerAssurance(),
                     assuranceFromClaims(null, NOW)]) {
      expect(Object.hasOwn(a, 'act_bound_authentication')).toBe(true)
      expect(a.act_bound_authentication).toBe(false)
    }
  })

  it('takes the most recent factor, so a later factor is the one reported', () => {
    const a = assuranceFromClaims({
      ...REAL_CLAIMS,
      amr: [{ method: 'password', timestamp: AUTH_TS }, { method: 'otp', timestamp: AUTH_TS + 50 }],
    }, new Date((AUTH_TS + 60) * 1000))
    expect(a.method).toBe('otp')
    expect(a.seconds_since_authentication).toBe(10)
  })

  it('reports an absent claim as null rather than inventing one', () => {
    const a = assuranceFromClaims({ aal: null, amr: null, is_anonymous: false }, NOW)
    expect(a.method).toBeNull()
    expect(a.aal).toBeNull()
    expect(a.authenticated_at).toBeNull()
    expect(a.seconds_since_authentication).toBeNull()
    expect(a.recent_authentication).toBe(false)
  })

  it('flags an anonymous session as such', () => {
    expect(assuranceFromClaims({ ...REAL_CLAIMS, is_anonymous: true }, NOW).assurance).toBe('anonymous')
  })
})

describe('the guest holds a capability, not an authentication', () => {
  it('has no method, no level and no authentication instant', () => {
    const a = bearerAssurance()
    expect(a.assurance).toBe('bearer_capability')
    expect(a.method).toBeNull()
    expect(a.authenticated_at).toBeNull()
  })

  it('says plainly that no credential of the actor was ever tested', () => {
    const { proves, does_not_prove } = assuranceMeaning(bearerAssurance())
    expect(does_not_prove.join(' ')).toMatch(/no credential of the actor's own was tested/)
    expect(does_not_prove.join(' ')).toMatch(/transferable/)
    // What it DOES prove is the owner-issued capability and the binding.
    expect(proves.join(' ')).toMatch(/agreement_hash/)
  })
})

describe('the limits travel with the data, for a machine reader', () => {
  it('never claims identity, performance or payment, under any assurance', () => {
    for (const a of [bearerAssurance(), assuranceFromClaims(REAL_CLAIMS, NOW)]) {
      const text = assuranceMeaning(a).does_not_prove.join(' ')
      expect(text).toMatch(/identity of the person/)
      expect(text).toMatch(/actually performed/)
      expect(text).toMatch(/payment actually moved/)
    }
  })

  it('states that recency is not intent, even for a login one second old', () => {
    const text = assuranceMeaning(assuranceFromClaims(REAL_CLAIMS, new Date((AUTH_TS + 1) * 1000)))
      .does_not_prove.join(' ')
    expect(text).toMatch(/IN ORDER TO perform this act/)
    expect(text).toMatch(/recency and not intent/)
  })

  it('describes a recent login as a time fact, not as participation in the act', () => {
    const proves = assuranceMeaning(assuranceFromClaims(REAL_CLAIMS, NOW)).proves.join(' ')
    expect(proves).toMatch(/within 300 seconds of this record being written/)
    // The wording an earlier version used, which claimed too much.
    expect(proves).not.toMatch(/as part of this act/)
  })

  it('names the NIST limit for an emailed OTP, and not for a password', () => {
    const otp = assuranceMeaning(assuranceFromClaims(
      { ...REAL_CLAIMS, amr: [{ method: 'otp', timestamp: AUTH_TS }] }, NOW))
    expect(otp.does_not_prove.join(' ')).toMatch(/800-63B-4/)
    expect(assuranceMeaning(assuranceFromClaims(REAL_CLAIMS, NOW))
      .does_not_prove.join(' ')).not.toMatch(/800-63B-4/)
  })

  it('an anonymous session proves nothing', () => {
    expect(assuranceMeaning(assuranceFromClaims({ ...REAL_CLAIMS, is_anonymous: true }, NOW)).proves)
      .toEqual([])
  })
})

describe('step-up is a shape, not a threshold', () => {
  it('is never required unless an act is named by policy', () => {
    const stale = assuranceFromClaims(REAL_CLAIMS, new Date((AUTH_TS + 99999) * 1000))
    expect(stepUpRequired('performance.accepted', stale)).toBe(false)
  })

  it('is required for a named act when the credential is stale', () => {
    const stale = assuranceFromClaims(REAL_CLAIMS, new Date((AUTH_TS + 99999) * 1000))
    expect(stepUpRequired('performance.accepted', stale,
      { actsRequiringFreshAuth: ['performance.accepted'] })).toBe(true)
  })

  it('is satisfied by a recent login only — which is all it can check', () => {
    const fresh = assuranceFromClaims(REAL_CLAIMS, NOW)
    expect(stepUpRequired('performance.accepted', fresh,
      { actsRequiringFreshAuth: ['performance.accepted'] })).toBe(false)
    // And satisfying it still does not make the authentication act-bound.
    expect(fresh.act_bound_authentication).toBe(false)
  })

  it('cannot be satisfied by a bearer capability, which has no freshness', () => {
    expect(stepUpRequired('payment.reported', bearerAssurance(),
      { actsRequiringFreshAuth: ['payment.reported'] })).toBe(true)
  })

  it('the window is a named policy candidate, not a hidden comparison', () => {
    expect(RECENT_AUTHENTICATION_WINDOW_SECONDS).toBe(300)
  })
})
