import { describe, it, expect } from 'vitest'
import {
  assuranceFromClaims, bearerAssurance, assuranceMeaning, stepUpRequired,
  claimsFromVerifiedJwt, assuranceForRecord, legacyAuthMethod,
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
    for (const a of [assuranceFromClaims(REAL_CLAIMS, NOW), bearerAssurance('guest_access_token'),
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
    const a = bearerAssurance('guest_access_token')
    expect(a.assurance).toBe('bearer_capability')
    expect(a.method).toBeNull()
    expect(a.authenticated_at).toBeNull()
  })

  it('says plainly that no credential of the actor was ever tested', () => {
    const { proves, does_not_prove } = assuranceMeaning(bearerAssurance('guest_access_token'))
    expect(does_not_prove.join(' ')).toMatch(/no credential of the actor's own was tested/)
    expect(does_not_prove.join(' ')).toMatch(/transferable/)
    // What it DOES prove is the owner-issued capability and the binding.
    expect(proves.join(' ')).toMatch(/agreement_hash/)
  })
})

describe('the limits travel with the data, for a machine reader', () => {
  it('never claims identity, performance or payment, under any assurance', () => {
    for (const a of [bearerAssurance('guest_access_token'), assuranceFromClaims(REAL_CLAIMS, NOW)]) {
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
    expect(stepUpRequired('payment.reported', bearerAssurance('guest_access_token'),
      { actsRequiringFreshAuth: ['payment.reported'] })).toBe(true)
  })

  it('the window is a named policy candidate, not a hidden comparison', () => {
    expect(RECENT_AUTHENTICATION_WINDOW_SECONDS).toBe(300)
  })
})

// ── the trust boundary ───────────────────────────────────────────────────────
// These claims become permanent hashed evidence, so the one thing that must be
// impossible is a caller choosing them. claimsFromVerifiedJwt decodes and does
// not verify, so the guard is the subject check: it can only return claims for
// the identity the auth server already confirmed.

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwtOf = (claims) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.signature-not-checked-here`

describe('claimsFromVerifiedJwt', () => {
  const USER = '11111111-1111-4111-8111-111111111111'

  it('reads the claims of the token whose subject was verified', () => {
    const claims = claimsFromVerifiedJwt(
      jwtOf({ sub: USER, aal: 'aal1', amr: [{ method: 'otp', timestamp: 1791731476 }] }), USER)

    expect(claims.aal).toBe('aal1')
    expect(claims.amr[0].method).toBe('otp')
  })

  it('refuses a token for anyone other than the verified user', () => {
    // The whole substitution attack: a second token, from a body or a header,
    // carrying a stronger aal than the session actually had.
    const someoneElse = jwtOf({ sub: 'attacker', aal: 'aal2', amr: [{ method: 'totp' }] })
    expect(claimsFromVerifiedJwt(someoneElse, USER)).toBeNull()
  })

  it('refuses a token with no subject at all', () => {
    expect(claimsFromVerifiedJwt(jwtOf({ aal: 'aal2' }), USER)).toBeNull()
  })

  it('returns null rather than a partial object for anything malformed', () => {
    for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.b.c.d',
      'header.!!!not-base64!!!.sig']) {
      expect(claimsFromVerifiedJwt(bad, USER)).toBeNull()
    }
  })

  it('needs a verified user id, so it cannot be called before verification', () => {
    expect(claimsFromVerifiedJwt(jwtOf({ sub: USER, aal: 'aal1' }), '')).toBeNull()
    expect(claimsFromVerifiedJwt(jwtOf({ sub: USER, aal: 'aal1' }), null)).toBeNull()
  })

  it('does not invent claims the token did not carry', () => {
    const claims = claimsFromVerifiedJwt(jwtOf({ sub: USER }), USER)
    expect(claims.aal).toBeNull()
    expect(claims.amr).toBeNull()
    expect(assuranceFromClaims(claims).method).toBeNull()
  })

  it('carries an anonymous session through as anonymous', () => {
    const claims = claimsFromVerifiedJwt(jwtOf({ sub: USER, is_anonymous: true }), USER)
    expect(assuranceFromClaims(claims).assurance).toBe('anonymous')
  })
})

describe('what reaches the permanent record', () => {
  const a = assuranceFromClaims(
    { aal: 'aal1', amr: [{ method: 'otp', timestamp: 1791731476 }], session_id: 'sess-abc' },
    new Date(1791731776 * 1000))

  it('keeps the relative age and drops the absolute instant', () => {
    const record = assuranceForRecord(a)
    expect(record.seconds_since_authentication).toBe(300)
    expect(record).not.toHaveProperty('authenticated_at')
    // The assurance object itself still holds it — the subtraction is at the
    // record boundary, where permanence begins.
    expect(a.authenticated_at).toBe(new Date(1791731476 * 1000).toISOString())
  })

  it('drops the session handle entirely', () => {
    expect(JSON.stringify(assuranceForRecord(a))).not.toContain('sess-abc')
    expect(assuranceForRecord(a)).not.toHaveProperty('session_id')
  })

  it('records the window alongside the boolean it produced', () => {
    const record = assuranceForRecord(a)
    expect(record.recent_authentication).toBe(true)
    expect(record.recent_authentication_window_seconds).toBe(300)
  })

  it('never records act-binding as satisfied', () => {
    for (const assurance of [a, bearerAssurance('invite_token'),
      bearerAssurance('guest_access_token'), assuranceFromClaims(null)]) {
      expect(assuranceForRecord(assurance).act_bound_authentication).toBe(false)
      expect(assuranceForRecord(assurance).act_binding_mechanism).toBeNull()
    }
  })
})

describe('legacyAuthMethod', () => {
  it('keeps both values stored rows already use', () => {
    expect(legacyAuthMethod(bearerAssurance('invite_token'))).toBe('invite_capability')
    expect(legacyAuthMethod(bearerAssurance('guest_access_token'))).toBe('invite_capability')
    expect(legacyAuthMethod(assuranceFromClaims({ aal: 'aal1' }))).toBe('account_session')
  })

  it('does not quietly call an anonymous session an account session', () => {
    expect(legacyAuthMethod(assuranceFromClaims({ is_anonymous: true }))).toBe('anonymous')
  })
})

describe('the credential a bearer presented', () => {
  it('distinguishes consuming an invitation from reusing its product', () => {
    expect(bearerAssurance('invite_token').credential).toBe('invite_token')
    expect(bearerAssurance('guest_access_token').credential).toBe('guest_access_token')
  })

  it('says so in what each one proves', () => {
    const invite = assuranceMeaning(bearerAssurance('invite_token')).proves.join(' ')
    const reuse = assuranceMeaning(bearerAssurance('guest_access_token')).proves.join(' ')
    expect(invite).toContain('single-use')
    expect(reuse).toContain('reusable')
  })

  it('neither claims any authentication event', () => {
    for (const c of ['invite_token', 'guest_access_token']) {
      const { does_not_prove } = assuranceMeaning(bearerAssurance(c))
      expect(does_not_prove.join(' ')).toContain('no credential of the actor\'s own was tested')
    }
  })
})
