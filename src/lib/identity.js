import { supabase } from './supabase.js'
import { captchaOptions } from './captcha.js'

const DEVICE_ID_KEY = 'tf_device_id'

export function getDeviceId() {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(DEVICE_ID_KEY, id)
  return id
}

/**
 * The actor id for a session that ALREADY exists, creating nothing.
 *
 * Used on load. Minting an anonymous user on every page view produced 360 of
 * this project's 362 production users and 1161 snapshot rows, and it is an
 * unauthenticated write surface: anyone could mint a user by loading the page.
 * Supabase's own anonymous sign-in guide names this as the abuse to prevent.
 *
 * Nothing before the email claim needs a server identity. Snapshots simply
 * stay in localStorage, which runtimeState.js already documents as the
 * designed degradation, and what is lost is cross-device restore of
 * {hasOnboarded, mode, view} for someone who has no account — four keys whose
 * only restorable view is 'home'.
 */
export async function currentActorIdentity() {
  const fallback = getDeviceId()
  if (!supabase) return { actorId: fallback, source: 'local' }
  try {
    const { data } = await supabase.auth.getSession()
    const id = data?.session?.user?.id
    return id ? { actorId: id, source: 'supabase-auth' } : { actorId: fallback, source: 'local' }
  } catch {
    return { actorId: fallback, source: 'local' }
  }
}

/**
 * Get the session, creating an anonymous one if there is none.
 *
 * Called only where a session is actually required: claiming an email, which
 * upgrades an anonymous user into a permanent account (earnerAuth.js) and so
 * needs something to upgrade. An anonymous sign-in goes to `/auth/v1/signup`,
 * which CAPTCHA protection covers, so the caller passes the token from the
 * widget it is already showing.
 */
export async function ensureActorIdentity(captchaToken = null) {
  const fallback = getDeviceId()
  if (!supabase) return { actorId: fallback, source: 'local' }

  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const currentUserId = sessionData?.session?.user?.id
    if (currentUserId) return { actorId: currentUserId, source: 'supabase-auth' }

    const { data, error } = await supabase.auth.signInAnonymously({
      options: captchaOptions(captchaToken),
    })
    if (error) {
      console.warn('[TrustFlow] anonymous auth unavailable, using local actor id:', error.message)
      return { actorId: fallback, source: 'local' }
    }

    const anonUserId = data?.user?.id
    return { actorId: anonUserId || fallback, source: anonUserId ? 'supabase-auth' : 'local' }
  } catch (err) {
    console.warn('[TrustFlow] identity bootstrap failed, using local actor id:', err?.message || String(err))
    return { actorId: fallback, source: 'local' }
  }
}
