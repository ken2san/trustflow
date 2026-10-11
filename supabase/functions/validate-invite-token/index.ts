// supabase/functions/validate-invite-token/index.ts
//
// Two-step guest invite flow:
//   1. preview (default): read-only. Validates the token (not used, not expired)
//      and returns the contract summary for InviteView's read-only review stage.
//      Does NOT consume the token and does NOT require an email yet.
//   2. accept (accept: true): the Hirer's explicit "I Agree" step. Consumes the
//      one-time invitation, records the claimed identity, issues the
//      guest_access_token that authorizes the guest's later actions, moves the
//      contract to TERMS_ACCEPTED, AND appends the acceptance evidence event —
//      all as one database transaction.
//
// WHY ACCEPTANCE WRITES THE EVENT
// It used to be the browser's job: accept here, then call log-event separately.
// A failure between the two left a contract that was accepted with no record of
// what had been accepted. Under canonical v4 the acceptance event carries the
// agreement snapshot, so it is the only place the agreed deal is preserved —
// absence of that event is absence of the evidence, not merely of a log line.
// Correctness cannot depend on the client making a second call.
//
// The hash is still computed here, in Deno, over the canonical defined once in
// _shared/eventCanonical.ts. Only the commit is handed to the database, through
// accept_invitation() — see 20260928000000_atomic_acceptance.sql.
//
// Deploy:
//   npx supabase functions deploy validate-invite-token

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ACCEPTANCE_TYPE, buildEventRecord } from '../_shared/eventRecord.ts'
import { bearerAssurance } from '../_shared/authAssurance.ts'
import { GENESIS_HASH } from '../_shared/eventCanonical.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Guest access token validity — generous, covers a typical contract's lifetime.
const GUEST_ACCESS_TOKEN_TTL_DAYS = 90

// A concurrent append can move the chain tip between reading it and committing.
// The transaction refuses rather than linking to the wrong predecessor, and we
// try again from a fresh read. Bounded, because unbounded retry against real
// contention is a way to stay busy rather than a way to succeed.
const MAX_ACCEPT_ATTEMPTS = 5

const STATUS_RESPONSES: Record<string, { error: string, status: number }> = {
  not_found:        { error: 'not_found',     status: 404 },
  already_used:     { error: 'already_used',  status: 410 },
  expired:          { error: 'expired',       status: 410 },
  // The agreement changed under us mid-acceptance. Refusing is the only honest
  // answer: the counterparty reviewed terms that are no longer the terms.
  contract_changed: { error: 'terms_changed', status: 409 },
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { invite_token, accept, hirer_email, counterparty_name } = await req.json()
    if (!invite_token || typeof invite_token !== 'string') {
      return json({ error: 'missing invite_token' }, 400)
    }

    if (accept) {
      if (typeof hirer_email !== 'string' || !EMAIL_RE.test(hirer_email.trim())) {
        return json({ error: 'valid hirer_email required' }, 400)
      }
    }

    // Use service role to bypass RLS for token lookup — guests have no auth.users row.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    if (!accept) {
      // Read-only preview — the token stays valid and unused.
      //
      // This path validates the invitation here because nothing else will. The
      // ACCEPT path deliberately does not: it validates inside the transaction
      // that consumes the token, where the answer is still true when it is
      // acted on. Checking here as well would be two code paths answering the
      // same question, and a check made before a lock is a check that can be
      // stale by the time it matters.
      const { data: contract, error } = await supabase
        .from('contracts')
        .select('id, project_name, dod, amount_jpy, currency, deadline, performed_by, '
          + 'earner_display_name, invited_hirer_email, invite_token_expires_at, invite_token_used_at')
        .eq('invite_token', invite_token)
        .maybeSingle()

      if (error || !contract) return json({ error: 'not_found' }, 404)
      if (contract.invite_token_used_at) return json({ error: 'already_used' }, 410)
      if (contract.invite_token_expires_at
          && new Date(contract.invite_token_expires_at) < new Date()) {
        return json({ error: 'expired' }, 410)
      }

      // Everything here comes from the contract row. The URL carries only the
      // token, never the terms, so a tampered URL cannot change what the
      // Hirer is shown.
      return json({
        contract_id: contract.id,
        project_name: contract.project_name,
        dod: contract.dod,
        amount_jpy: contract.amount_jpy,
        currency: contract.currency,
        deadline: contract.deadline,
        earner_display_name: contract.earner_display_name,
        invited_hirer_email: contract.invited_hirer_email,
        // Which side does the work. It is bound into the agreement snapshot at
        // acceptance, so it has to be on screen before anyone agrees —
        // attesting consent to a term nobody was shown would be dishonest.
        performed_by: contract.performed_by,
      }, 200)
    }

    // Accept: consume the invitation and record the evidence for it, together.
    const claimedEmail = hirer_email.trim().slice(0, 254)
    const guestAccessToken = crypto.randomUUID()
    const guestAccessTokenExpiresAt = new Date(
      Date.now() + GUEST_ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()

    for (let attempt = 0; attempt < MAX_ACCEPT_ATTEMPTS; attempt++) {
      // One read: the terms as they stand, the chain tip, and an opaque version
      // of the row. All three are re-checked inside the transaction.
      const { data: context, error: contextError } = await supabase
        .rpc('invite_acceptance_context', { p_invite_token: invite_token })

      if (contextError) return json({ error: 'lookup_failed' }, 500)
      const known = STATUS_RESPONSES[context?.status]
      if (known) return json({ error: known.error }, known.status)
      if (context?.status !== 'ok') return json({ error: 'not_found' }, 404)

      // The deal as the server holds it, plus the identity this acceptance is
      // about to record. hirer_email is written and hashed in the same breath,
      // so the snapshot cannot describe an identity the row does not carry.
      const agreementRow = { ...context.contract, hirer_email: claimedEmail }

      const event = await buildEventRecord({
        type: ACCEPTANCE_TYPE,
        contract: agreementRow,
        // The guest has no auth.users row; their identity on this contract is
        // the address they accepted with, exactly as log-event resolves it.
        actorId: `guest:${claimedEmail}`,
        party: 'guest_hirer',
        // The authority for an acceptance is the single-use invitation being
        // consumed in this same transaction. The counterparty presents no
        // credential of their own and there is no authentication event here at
        // all — which is worth recording precisely because this is the act the
        // whole agreement rests on. The address below is typed by the accepter
        // and is already marked unverified; this says the same about the
        // authority behind it.
        assurance: bearerAssurance('invite_token'),
        payload: {
          counterparty_name: typeof counterparty_name === 'string'
            ? counterparty_name.slice(0, 200) : null,
          counterparty_email: claimedEmail,
          dod_items: context.contract.dod ?? [],
        },
        prevEventHash: context.chain_tip ?? GENESIS_HASH,
        // One acceptance per contract, enforced by the database rather than by
        // this function remembering to check.
        idempotencyKey: `acceptance:${context.contract.id}`,
      })

      const { data: result, error: acceptError } = await supabase
        .rpc('accept_invitation', {
          p_invite_token:        invite_token,
          p_hirer_email:         claimedEmail,
          p_guest_token:         guestAccessToken,
          p_guest_token_expires: guestAccessTokenExpiresAt,
          p_row_version:         context.row_version,
          p_prev_event_hash:     context.chain_tip ?? GENESIS_HASH,
          p_event:               event,
        })

      // A raised exception rolls the whole call back, so an error here means
      // neither the acceptance nor the evidence landed. Reporting it as a
      // failure is therefore accurate, not optimistic.
      if (acceptError) return json({ error: 'accept_failed', detail: acceptError.message }, 500)

      const refused = STATUS_RESPONSES[result?.status]
      if (refused) return json({ error: refused.error }, refused.status)

      // Another event claimed the tip we hashed against. Nothing was written;
      // read the new tip and build the event again.
      if (result?.status === 'chain_conflict') continue

      if (result?.status !== 'accepted') return json({ error: 'accept_failed' }, 500)

      return json({
        contract_id: result.contract.id,
        project_name: result.contract.project_name,
        dod: result.contract.dod,
        amount_jpy: result.contract.amount_jpy,
        currency: result.contract.currency,
        deadline: result.contract.deadline,
        earner_display_name: result.contract.earner_display_name,
        guest_access_token: guestAccessToken,
        // Stated explicitly so the client never has to assume it. The record
        // exists because this response exists; there is no second call to make.
        acceptance_event_id: result.event.id,
      }, 200)
    }

    return json({ error: 'chain_contention' }, 409)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
