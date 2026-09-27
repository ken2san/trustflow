// src/lib/contracts.js
// DB-backed contract creation and invite lookup.
//
// The contract row is the canonical record; localStorage keeps only the
// in-progress form. Note what is deliberately NOT sent on insert: state,
// invite_token, invite_token_expires_at, guest_access_token, hirer_email and
// every stripe_* / settlement column are server-owned — the client no longer
// holds the INSERT privilege on them (20260923000000), so including any of
// them makes the whole insert fail with 403. The server fills them: state
// defaults to AWAITING_ACCEPTANCE, invite_token to a random UUID, and
// invite_token_expires_at to now() + 72h.

import { supabase } from './supabase.js'
import { getGuestAccessToken } from './guestSession.js'

const NOT_CONFIGURED = new Error('Supabase is not configured')

/**
 * Persist a contract and return it, including the server-issued invite_token.
 * Requires a verified (non-anonymous) Earner session — otherwise the
 * verified_earner_only_insert policy rejects the row.
 *
 * @param {object} p
 * @param {string}   p.earnerDisplayName
 * @param {string}   p.projectName
 * @param {string[]} p.dod                 completion criteria, one per entry
 * @param {number}   p.amountJpy
 * @param {string}   [p.deadline]          ISO date (YYYY-MM-DD)
 * @param {string}   p.invitedHirerEmail   address the invite is addressed to
 * @param {'creator'|'counterparty'} [p.performedBy]  which side does the work
 * @returns {Promise<{ contract: object|null, error: Error|null }>}
 */
export async function createContract({
  earnerDisplayName,
  projectName,
  dod,
  amountJpy,
  deadline,
  invitedHirerEmail,
  performedBy = 'creator',
}) {
  if (!supabase) return { contract: null, error: NOT_CONFIGURED }

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) {
    return { contract: null, error: userError ?? new Error('Not signed in') }
  }

  const { data, error } = await supabase
    .from('contracts')
    .insert({
      earner_user_id: userData.user.id,
      earner_display_name: earnerDisplayName,
      project_name: projectName,
      dod,
      // dod_hash is NOT sent. It is derived from `dod` server-side wherever it
      // is needed, and the client INSERT grant on it was revoked precisely so a
      // party cannot record a terms-hash that disagrees with its own terms.
      // Sending it made every creation fail with a 403 that no test caught,
      // because the tests wrote their own insert bodies instead of calling this
      // function — which is why there is now a test that calls this function.
      amount_jpy: amountJpy,
      currency: 'JPY',
      deadline: deadline || null,
      invited_hirer_email: invitedHirerEmail,
      // Which side does the work. Normalised here rather than trusted: a check
      // constraint would reject anything else anyway, but as an opaque database
      // error rather than the quiet default a caller expects.
      performed_by: performedBy === 'counterparty' ? 'counterparty' : 'creator',
    })
    .select()
    .single()

  return { contract: data ?? null, error: error ?? null }
}

/**
 * Every contract the signed-in user is a party to, newest first.
 *
 * No filter is applied here: `parties_read_own_contracts` already restricts
 * rows to `auth.uid() = earner_user_id OR auth.uid() = hirer_user_id`, so the
 * database decides what is visible. Adding a client-side `.eq('earner_user_id',
 * …)` would look like the security control and quietly become the thing people
 * trust — the policy is the control.
 *
 * invite_token is included because the Earner needs it to re-share a pending
 * invite; it is their own contract's token and RLS already permits reading it.
 *
 * Returns an empty list rather than throwing when Supabase is unconfigured, so
 * the home screen renders its empty state instead of failing.
 *
 * @returns {Promise<{ contracts: object[], error: Error|null }>}
 */
export async function listContracts() {
  if (!supabase) return { contracts: [], error: NOT_CONFIGURED }

  const { data, error } = await supabase
    .from('contracts')
    .select(
      'id, project_name, dod, amount_jpy, currency, deadline, state, '
      + 'earner_display_name, invited_hirer_email, hirer_email, '
      + 'invite_token, invite_token_expires_at, invite_token_used_at, created_at, performed_by',
    )
    .order('created_at', { ascending: false })

  if (error || !data?.length) return { contracts: data ?? [], error: error ?? null }

  return { contracts: await withLatestPerformance(data), error: null }
}

/**
 * Attach the most recent performance statement to each contract.
 *
 * The state column cannot express this on its own: a rejection returns the
 * agreement to TERMS_ACCEPTED, which is indistinguishable from one that was
 * never delivered at all. "They asked for a correction and I have not
 * re-delivered" and "I have not started" are very different things to see in a
 * list, and only the event log knows which is which.
 *
 * One extra query for the whole list rather than one per contract. Nothing is
 * denormalised and no semantics change — this is a read-time convenience, and
 * the state projection remains the authority on where the protocol stands.
 */
async function withLatestPerformance(contracts) {
  const { data: events } = await supabase
    .from('events')
    .select('contract_id, type, created_at')
    .in('contract_id', contracts.map(c => c.id))
    .in('type', ['performance.asserted', 'performance.accepted', 'performance.rejected'])
    .order('created_at', { ascending: false })

  const latest = new Map()
  for (const event of events ?? []) {
    // Ordered newest-first, so the first one seen for a contract is its latest.
    if (!latest.has(event.contract_id)) latest.set(event.contract_id, event)
  }

  return contracts.map(contract => ({
    ...contract,
    last_performance_type: latest.get(contract.id)?.type ?? null,
    last_performance_at: latest.get(contract.id)?.created_at ?? null,
  }))
}

/** Build the invite URL for a server-issued token. */
export function inviteUrlFor(inviteToken) {
  return `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(inviteToken)}`
}

/**
 * Read the contract behind an invite token, without consuming it.
 * Values come from the contract row via the Edge Function — the URL only
 * identifies the contract, it never carries the terms.
 *
 * @returns {Promise<{ invite: object|null, reason: string|null }>}
 *          reason is 'not_found' | 'expired' | 'already_used' | 'error'
 */
export async function fetchInvite(inviteToken) {
  if (!supabase) return { invite: null, reason: 'error' }

  const { data, error } = await supabase.functions.invoke('validate-invite-token', {
    body: { invite_token: inviteToken },
  })

  if (error || data?.error) {
    return { invite: null, reason: data?.error ?? 'error' }
  }
  return { invite: data, reason: null }
}

/**
 * Read the evidence trail for the contract this browser holds a guest
 * credential for.
 *
 * The contract is not named in the request: the server resolves it from the
 * guest_access_token alone, so there is no contract id for a caller to swap.
 * The contractId argument only selects which stored credential to send.
 *
 * The response is a shaped view, not raw rows — payloads are allowlisted per
 * event type and hash-chain verification is reported per event. See
 * supabase/functions/guest-contract-events.
 *
 * @returns {Promise<{ evidence: object|null, reason: string|null }>}
 *          reason is 'no_credential' | 'invalid_guest_token'
 *                  | 'guest_token_expired' | 'error'
 */
export async function fetchGuestEvidence(contractId) {
  if (!supabase) return { evidence: null, reason: 'error' }

  const guestToken = getGuestAccessToken(contractId)
  if (!guestToken) return { evidence: null, reason: 'no_credential' }

  const { data, error } = await supabase.functions.invoke('guest-contract-events', {
    headers: { 'x-guest-access-token': guestToken },
  })

  if (error || data?.error) {
    return { evidence: null, reason: data?.error ?? 'error' }
  }
  return { evidence: data, reason: null }
}

/**
 * Accept the invitation.
 *
 * One server-side operation: it consumes the one-time token, records the
 * accepting identity, moves the contract to TERMS_ACCEPTED, issues the guest
 * access token for this Hirer's later actions, and appends the acceptance
 * evidence event carrying the agreed terms. All of it commits together or none
 * of it does, so a caller that gets a result has both the acceptance and the
 * record of what was accepted.
 */
export async function acceptInvite(inviteToken, hirerEmail, counterpartyName) {
  if (!supabase) return { accepted: null, reason: 'error' }

  // One call. The function consumes the invitation and writes the acceptance
  // evidence in the same transaction, so there is no second request whose
  // failure could leave an accepted agreement without a record of it.
  const { data, error } = await supabase.functions.invoke('validate-invite-token', {
    body: {
      invite_token: inviteToken,
      accept: true,
      hirer_email: hirerEmail,
      counterparty_name: counterpartyName ?? null,
    },
  })

  if (error || data?.error) {
    return { accepted: null, reason: data?.error ?? 'error' }
  }
  return { accepted: data, reason: null }
}

/**
 * Remove a contract that was created but never accepted — a draft nobody has
 * responded to yet, such as one left over from closing "New contract" without
 * copying the invite link.
 *
 * Safe to expose as a plain delete: `owner_delete_unaccepted_draft` is what
 * actually enforces this, restricted to the caller's own contracts still at
 * AWAITING_ACCEPTANCE with an unused invite token. A contract in that state
 * has zero rows in `events` — the acceptance event is the first thing ever
 * written for a contract — so this never touches anything that is evidence of
 * a real transaction. Deleting anything else fails silently (RLS rows out of
 * scope simply do not match; `count` on the response is how a caller tells a
 * refused delete from one that already had nothing to remove).
 */
export async function deleteDraftContract(contractId) {
  if (!supabase) return { deleted: false, error: NOT_CONFIGURED }

  const { error, count } = await supabase
    .from('contracts')
    .delete({ count: 'exact' })
    .eq('id', contractId)

  if (error) return { deleted: false, error }
  return { deleted: (count ?? 0) > 0, error: null }
}
