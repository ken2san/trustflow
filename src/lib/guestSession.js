// src/lib/guestSession.js
// The guest Hirer's credential for one contract.
//
// A guest Hirer has no auth.users row, so they cannot present a JWT. When they
// accept an invite, validate-invite-token issues a guest_access_token (90-day
// TTL) bound to that contract. That token is how the log-event function knows a
// request is genuinely from the party who accepted — it is the guest half of
// server-side identity derivation.
//
// Kept per contract rather than globally: the token authorizes actions on one
// contract only, and a browser may hold invites to several.

const KEY_PREFIX = 'tf_guest_access_token:'

export function storeGuestAccessToken(contractId, token) {
  if (!contractId || !token) return
  try {
    localStorage.setItem(KEY_PREFIX + contractId, token)
  } catch {
    // Private mode / quota — the guest simply loses the ability to record
    // further events on this contract. Non-fatal.
  }
}

/**
 * Every agreement this browser holds a credential for.
 *
 * WHY THIS EXISTS
 * The credential was being stored and then only ever read by callers that
 * already knew which contract they wanted — so a guest who navigated away
 * after accepting had no route back. Their token sat in this browser for its
 * full 90 days, unusable, while the invitation link told them their record
 * was "reachable from the access link you were given when you accepted",
 * which was never given: acceptance shows a screen, not a link.
 *
 * Found by a blind counterparty that was asked to accept and then look for
 * its own record (2026-11-06). It is the failure persona 7 was written for —
 * losing access to your own evidence — and it needed no new mechanism, only
 * the ability to ask what is already here.
 *
 * Returns ids only. Whether an id still resolves is the server's answer, and
 * a token can be superseded by a re-issue at any time, so a caller must treat
 * every entry as a candidate rather than a promise.
 */
export function listGuestAgreementIds() {
  const ids = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(KEY_PREFIX)) ids.push(key.slice(KEY_PREFIX.length))
    }
  } catch {
    // Private mode or blocked storage: the same non-fatal degradation as
    // storing, and the caller simply offers nothing.
  }
  return ids
}

export function getGuestAccessToken(contractId) {
  if (!contractId) return null
  try {
    return localStorage.getItem(KEY_PREFIX + contractId)
  } catch {
    return null
  }
}
