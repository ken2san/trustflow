import { describe, it, expect, vi, beforeEach } from 'vitest'

// WHY THIS FILE EXISTS
// On 2026-11-06 CAPTCHA protection was switched on in the production
// dashboard on the strength of a recommendation that called it a settings
// change costing no code. Every auth endpoint then answered 400
// captcha_failed, because the app sent no token, and sign-in was dead for the
// only account that exists. `tests/unit/earnerAuth.test.js` stayed green
// throughout: it mocks the auth surface wholesale, so a missing option in a
// call it stubs is invisible to it.
//
// So these cases assert the two things that outage turned out to depend on —
// that the token actually travels on the two protected calls, and that an
// anonymous user is not minted by merely loading the page.

const auth = {
  signInWithOtp: vi.fn(),
  signInAnonymously: vi.fn(),
  getSession: vi.fn(),
}
vi.mock('../../src/lib/supabase.js', () => ({ supabase: { auth } }))

const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
}

const { captchaOptions, captchaConfigured, captchaIsTestKey } = await import('../../src/lib/captcha.js')
const { currentActorIdentity, ensureActorIdentity } = await import('../../src/lib/identity.js')
const { requestSignInCode } = await import('../../src/lib/earnerAuth.js')

beforeEach(() => {
  store.clear()
  for (const fn of Object.values(auth)) fn.mockReset()
  auth.getSession.mockResolvedValue({ data: { session: null } })
})

describe('the options a protected project requires', () => {
  it('omits the field entirely when there is no token', () => {
    // Not `{ captchaToken: undefined }`. Some serializations carry that as an
    // explicit null, and the only honest request is one that does not mention
    // a challenge it cannot answer.
    expect(captchaOptions(null)).toEqual({})
    expect(captchaOptions(undefined)).toEqual({})
    expect(captchaOptions('')).toEqual({})
  })

  it('sends the token when there is one', () => {
    expect(captchaOptions('tok-123')).toEqual({ captchaToken: 'tok-123' })
  })
})

describe('a build with no site key', () => {
  it('reports that it has no challenge, rather than inventing one', () => {
    // The first version of captcha.js defaulted to Cloudflare's
    // always-passes test key. An unset variable would then have put a widget
    // and the words "test challenge key" on the live site, and sent a token
    // Supabase's secret cannot verify. Unset means one thing only.
    expect(captchaConfigured()).toBe(false)
    expect(captchaIsTestKey()).toBe(false)
  })
})

describe('loading the page', () => {
  it('never mints an anonymous user', async () => {
    // The whole exposure: 360 of production's 362 users were minted by page
    // views, each one an unauthenticated write into auth.users.
    const identity = await currentActorIdentity()
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
    expect(identity.source).toBe('local')
  })

  it('uses a session that already exists', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-9' } } } })
    expect(await currentActorIdentity()).toEqual({ actorId: 'user-9', source: 'supabase-auth' })
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('falls back to a device id rather than throwing into the caller', async () => {
    auth.getSession.mockRejectedValue(new Error('offline'))
    const identity = await currentActorIdentity()
    expect(identity.source).toBe('local')
    expect(identity.actorId).toBeTruthy()
  })
})

describe('claiming an email', () => {
  it('creates the session the upgrade needs, and passes the challenge', async () => {
    // `updateUser({ email })` promotes the CURRENT session, so one has to
    // exist; an anonymous sign-in is a /auth/v1/signup, which is protected.
    auth.signInAnonymously.mockResolvedValue({ data: { user: { id: 'anon-1' } }, error: null })
    const identity = await ensureActorIdentity('tok-abc')

    expect(auth.signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: 'tok-abc' } })
    expect(identity).toEqual({ actorId: 'anon-1', source: 'supabase-auth' })
  })

  it('does not create a second session when one is already live', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-9' } } } })
    await ensureActorIdentity('tok-abc')
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('reports local rather than throwing when the challenge is refused', async () => {
    auth.signInAnonymously.mockResolvedValue({
      data: null, error: { message: 'captcha protection: request disallowed' },
    })
    const identity = await ensureActorIdentity(null)
    // The caller checks `source` and says "complete the challenge"; an
    // exception here would surface as an unhandled failure mid-form.
    expect(identity.source).toBe('local')
  })
})

describe('signing back in', () => {
  it('carries the token to the OTP endpoint', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: null })
    await requestSignInCode('someone@example.test', 'tok-xyz')

    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'someone@example.test',
      options: { shouldCreateUser: false, captchaToken: 'tok-xyz' },
    })
  })

  it('still asks for no challenge when the deployment is unprotected', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: null })
    await requestSignInCode('someone@example.test')

    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'someone@example.test',
      options: { shouldCreateUser: false },
    })
  })

  it('names a failed challenge as itself, not as a mail problem', async () => {
    // The outage presented as "Could not send the code", which is why the
    // operator went looking at the mail quota instead of the frontend.
    auth.signInWithOtp.mockResolvedValue({ error: { code: 'captcha_failed' } })
    expect(await requestSignInCode('someone@example.test'))
      .toEqual({ ok: false, reason: 'captcha_failed' })
  })

  it('keeps shouldCreateUser false, so sign-in cannot mint an account', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: null })
    await requestSignInCode('stranger@example.test', 'tok')
    expect(auth.signInWithOtp.mock.calls.at(-1)[0].options.shouldCreateUser).toBe(false)
  })
})
