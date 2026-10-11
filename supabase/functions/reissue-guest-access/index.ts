// supabase/functions/reissue-guest-access/index.ts
//
// Give the counterparty a working credential again, on the owner's authority.
//
// THE PROBLEM THIS SOLVES
// A guest Hirer's guest_access_token exists in one place only: the localStorage
// of the browser they accepted in. The invite token is single-use and spent,
// send-acceptance-email is deleted, and no URL reopens the guest view. Clear
// the browser, change device, or accept in a private window, and the
// counterparty can never confirm delivery or report payment again — while the
// owner's side waits on a review that cannot arrive. The chain is untouched by
// any of this. What was lost is a cache.
//
// WHY THE OWNER AND NOT THE EMAIL
// Letting a signed-in account whose email matches contracts.hirer_email act as
// the guest was considered and rejected: that address is typed by the guest at
// acceptance and recorded as unverified, so it would move authorisation from a
// secret the owner handed over to a string the counterparty chose, and would
// admit a mistyped address, a shared mailbox, or anyone the guest named. Here
// the authority is the owner's, exactly as it was for the original invite, and
// no new principal is created — an owner can already mint guest access by
// accepting their own invite.
//
// A SIDE EFFECT WORTH NAMING
// The new token overwrites the old, so this is also the first way to revoke a
// guest credential that has leaked. There was none before.
//
// Deploy:
//   npx supabase functions deploy reissue-guest-access

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GENESIS_HASH } from '../_shared/eventCanonical.ts'
import { buildEventRecord } from '../_shared/eventRecord.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// Recorded so the chain shows that the credential changed hands, and when.
// Without it a reissue is invisible, and a reader cannot tell whether the
// guest events after it came from the same person as the ones before — which
// is precisely the kind of gap this product exists to close. It is in
// log-event's SERVER_RECORDED_TYPES, so no party can assert it themselves.
const REISSUE_TYPE = 'access.reissued'

// Matches what validate-invite-token issues at acceptance. The clock restarts:
// a counterparty who needed a new credential needs the same window the first
// one had, not whatever was left of it.
const GUEST_ACCESS_TOKEN_TTL_DAYS = 90

const MAX_CHAIN_RETRIES = 5

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATUS_RESPONSES: Record<string, { error: string, status: number }> = {
  not_found:    { error: 'contract_not_found', status: 404 },
  not_owner:    { error: 'not_the_owner',      status: 403 },
  // Before acceptance there is no counterparty to issue to, and the invite
  // token is still live and still the right thing to re-share. Minting a guest
  // credential here would be a way into the agreement that skips accepting it.
  not_accepted: { error: 'not_accepted',       status: 409 },
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json({ error: 'invalid_body' }, 400)

    const { contract_id } = body as Record<string, unknown>
    if (typeof contract_id !== 'string' || !UUID_RE.test(contract_id)) {
      return json({ error: 'contract_not_found' }, 404)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Who is asking. Only an account session can reissue; there is no guest
    // path here on purpose, since a guest who still holds a working token does
    // not need one and a guest who does not cannot prove anything.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'not_the_owner' }, 403)
    const { data: userData, error: userError } = await admin.auth.getUser(
      authHeader.slice('Bearer '.length))
    if (userError || !userData?.user || userData.user.is_anonymous) {
      return json({ error: 'not_the_owner' }, 403)
    }
    const earnerUserId = userData.user.id

    const { data: contract, error: contractError } = await admin
      .from('contracts')
      .select('id, project_name, dod, amount_jpy, currency, deadline, performed_by, '
        + 'earner_display_name, earner_user_id, invited_hirer_email, hirer_email, '
        + 'invite_token_used_at')
      .eq('id', contract_id)
      .maybeSingle()

    if (contractError) return json({ error: 'lookup_failed' }, 500)
    if (!contract) return json({ error: 'contract_not_found' }, 404)
    // Checked here for a clear answer, and again inside the transaction
    // because that function is SECURITY DEFINER and must not trust its caller.
    if (contract.earner_user_id !== earnerUserId) return json({ error: 'not_the_owner' }, 403)

    const guestAccessToken = crypto.randomUUID()
    const guestAccessTokenExpiresAt = new Date(
      Date.now() + GUEST_ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()

    for (let attempt = 0; attempt < MAX_CHAIN_RETRIES; attempt++) {
      const { data: tip } = await admin
        .from('events')
        .select('event_hash')
        .eq('contract_id', contract_id)
        .not('event_hash', 'is', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle()

      const prevHash = tip?.event_hash ?? GENESIS_HASH

      // Built the same way every other event is, so a reissue is the same kind
      // of object as an acceptance or an assertion and a verifier needs no
      // special case for it. The payload carries nothing a party asserted —
      // the event's own type is the whole statement.
      const event = await buildEventRecord({
        type: REISSUE_TYPE,
        contract,
        actorId: earnerUserId,
        party: 'earner',
        payload: {},
        prevEventHash: prevHash,
      })

      const { data: result, error: rpcError } = await admin.rpc('reissue_guest_access', {
        p_contract_id:         contract_id,
        p_earner_user_id:      earnerUserId,
        p_guest_token:         guestAccessToken,
        p_guest_token_expires: guestAccessTokenExpiresAt,
        p_prev_event_hash:     prevHash,
        p_event:               event,
      })

      if (rpcError) return json({ error: 'reissue_failed', detail: rpcError.message }, 500)

      const mapped = STATUS_RESPONSES[result?.status as string]
      if (mapped) return json({ error: mapped.error }, mapped.status)

      // Another event landed between reading the tip and the transaction.
      // Re-read and rebuild rather than linking to a predecessor that is no
      // longer last.
      if (result?.status === 'chain_conflict') continue

      if (result?.status !== 'reissued') return json({ error: 'reissue_failed' }, 500)

      return json({
        contract_id,
        guest_access_token: guestAccessToken,
        expires_at:         guestAccessTokenExpiresAt,
        event_id:           result.event?.id ?? null,
      }, 200)
    }

    return json({ error: 'chain_contention' }, 409)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
