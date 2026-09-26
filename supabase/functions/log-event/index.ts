// supabase/functions/log-event/index.ts
//
// The only writer to the `events` table.
//
// WHAT THE CLIENT MAY SAY, AND WHAT IT MAY NOT
// A caller supplies only: type, contract_id, payload, dod_hash, idempotency_key.
// Everything that determines whether the record is evidence is derived here:
//
//   actor_id        — from the verified session, never from the body. An Earner
//                     is identified by their JWT's sub; a guest Hirer by the
//                     guest_access_token issued at invite acceptance.
//   created_at      — the server's clock.
//   event_hash      — computed here, over the server's own field values.
//   prev_event_hash — read from the contract's current chain tip here.
//   type            — checked against ALLOWED_TYPES; anything else is rejected.
//
// The actor must also be a party to the referenced contract, and the contract
// must be a real row in `contracts`. Events referencing marketplace fixtures
// (contract_id '1', 'mock', …) are rejected by design: a server-authoritative
// record of a contract that does not exist is not evidence, and carving out an
// exception for them would put a permanent bypass in this validator.
//
// CHAIN SERIALIZATION
// No advisory locks. `events_chain_no_fork_idx` makes (contract_id,
// prev_event_hash) unique, so two concurrent writers that read the same tip
// cannot both commit — the loser gets 23505 and retries against the new tip.
// Forking is structurally impossible rather than merely unlikely.
//
// Deploy:
//   npx supabase functions deploy log-event

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GENESIS_HASH } from '../_shared/eventCanonical.ts'
import { ACCEPTANCE_TYPE, buildEventRecord, roleInAgreement } from '../_shared/eventRecord.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // x-guest-access-token must be listed: a browser preflights any request
  // carrying a non-standard header, and a header missing from this list fails
  // that preflight — so the guest Hirer's writes never leave the browser at
  // all. Server-side callers do not preflight, which is why an API-level test
  // cannot see this and the browser-level one can.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-access-token',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// Types a party may record about their own contract. Deliberately excludes
// runtime.snapshot (application state, now in runtime_snapshots) and every
// type whose truth is decided by the payment processor rather than by a
// party's assertion — payment.*, trustpoints.* and the dispute verdicts are
// written by capture-payment / cancel-payment with the service role, or by a
// future arbitration path, and must not be assertable from a browser.
const ALLOWED_TYPES = new Set([
  'contract.initiated',
  'contract.accepted',
  // What a party SAYS about performance. These names are deliberate: the
  // Earner asserting they performed is not the same fact as the work having
  // been delivered, and TrustFlow can only attest the first. The projection in
  // derive_contract_state() is built on exactly this distinction.
  'performance.asserted',
  'performance.accepted',
  'performance.rejected',
  'contract.cancelled',
  'contract.completed',
  'dispute.opened',
  'rating.submitted',
  // What a party SAYS about payment, made for a rail TrustFlow does not
  // control — bank transfer, cash, anything outside Stripe. Deliberately the
  // same shape as performance.*: a claim, not a processor fact. These three
  // leaf names are the only payment.* types a party may ever write. Every
  // other payment.* name (intent_created, captured, refunded — see the
  // comment above ALLOWED_TYPES) stays absent from this set on purpose: those
  // are Stripe-verified facts written by capture-payment / cancel-payment
  // with the service role, and must never be confused with a party's
  // unverified say-so.
  'payment.reported',
  'payment.acknowledged',
  'payment.disputed',
])

// Written by the server as part of another operation, never on a party's say-so.
//
// dod.consent_recorded is the authoritative record of what was accepted, and it
// is now appended inside the same transaction that consumes the invitation —
// see validate-invite-token. Accepting one here as well would let a guest add a
// second, later acceptance to the same agreement, with a snapshot taken at a
// different moment, and leave a reader with two records and no rule for which
// one is the agreement. Existing rows are untouched and verify as before.
const SERVER_RECORDED_TYPES = new Set([ACCEPTANCE_TYPE])

// Written before the vocabulary above. Still readable and still verifiable
// under the canonical they were written with — the log is append-only, so
// their names are permanent — but no longer accepted for new events, and they
// do not drive the projection. 'work.submitted' in particular could be read as
// "the work arrived", which is precisely the claim TrustFlow cannot make.
const RETIRED_TYPES = new Set(['work.submitted', 'work.approved', 'work.rejected'])

// Which FUNCTIONAL role an event type may come from.
//
// Being a party to the contract is not enough. Confirming an assertion is the
// other side's act by definition — a performer who could emit
// performance.accepted would be confirming their own claim and walking the
// agreement to the edge of an irreversible transfer alone. Party authorisation
// answers "may you write here"; this answers "is this yours to say".
//
// These are roles in the deal, not sides of the account/guest divide. Which
// party holds which role comes from contracts.performed_by, so the guarantee
// holds in both directions: whoever performs may assert, whoever receives may
// answer, and neither can do the other's part.
//
// Types absent from this map may come from either party.
const ROLE_REQUIRED: Record<string, 'performer' | 'receiver'> = {
  'performance.asserted': 'performer',
  'performance.accepted': 'receiver',
  'performance.rejected': 'receiver',
  // Payment flows the other way: whoever receives the work is the one paying
  // for it, and whoever performs is the one being paid.
  'payment.reported':     'receiver',
  'payment.acknowledged': 'performer',
  'payment.disputed':     'performer',
}

const MAX_PAYLOAD_BYTES = 16 * 1024
const MAX_CHAIN_RETRIES = 5

/**
 * Resolve who is making this request, from credentials only.
 *
 * An Earner presents their Supabase JWT as the bearer token. A guest Hirer has
 * no auth.users row, so they present the contract's guest_access_token in
 * x-guest-access-token — the credential validate-invite-token issued when they
 * accepted the invite.
 */
async function resolveActor(
  req: Request,
  admin: ReturnType<typeof createClient>,
  contract: Record<string, unknown>,
): Promise<{ actorId: string; role: 'earner' | 'guest_hirer' } | null> {
  const guestToken = req.headers.get('x-guest-access-token')
  if (guestToken) {
    if (
      contract.guest_access_token !== guestToken ||
      !contract.guest_access_token_expires_at ||
      new Date(contract.guest_access_token_expires_at as string) < new Date()
    ) {
      return null
    }
    // The accepting email is the guest's established identity on this
    // contract — recorded by validate-invite-token, not chosen by the client.
    const hirerEmail = contract.hirer_email as string | null
    if (!hirerEmail) return null
    return { actorId: `guest:${hirerEmail}`, role: 'guest_hirer' }
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const jwt = authHeader.slice('Bearer '.length)

  const { data, error } = await admin.auth.getUser(jwt)
  if (error || !data?.user) return null
  // An anonymous session is a browser, not a party. Contracts can only be
  // created by a verified Earner (verified_earner_only_insert), so an
  // anonymous caller can never legitimately be a party to one.
  if (data.user.is_anonymous) return null
  if (data.user.id !== contract.earner_user_id) return null
  return { actorId: data.user.id, role: 'earner' }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return json({ error: 'invalid_body' }, 400)
    }

    const { type, contract_id, payload, dod_hash, idempotency_key } = body as Record<string, unknown>

    if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
      const retired = typeof type === 'string' && RETIRED_TYPES.has(type)
      const serverRecorded = typeof type === 'string' && SERVER_RECORDED_TYPES.has(type)
      return json({
        error: serverRecorded ? 'type_is_server_recorded'
          : retired ? 'type_retired'
          : 'type_not_allowed',
      }, 400)
    }
    if (typeof contract_id !== 'string' || !contract_id) {
      return json({ error: 'missing_contract_id' }, 400)
    }
    if (payload !== undefined && payload !== null && typeof payload !== 'object') {
      return json({ error: 'invalid_payload' }, 400)
    }
    if (JSON.stringify(payload ?? {}).length > MAX_PAYLOAD_BYTES) {
      return json({ error: 'payload_too_large' }, 413)
    }
    // Rejected, not ignored. The terms an assertion refers to are derived from
    // the agreement itself further down; a caller offering its own value is
    // either confused or trying to pin its assertion to terms that were never
    // agreed. Silently dropping it would hide both.
    if (dod_hash !== undefined && dod_hash !== null) {
      return json({ error: 'dod_hash_is_server_derived' }, 400)
    }
    if (idempotency_key !== undefined && idempotency_key !== null && typeof idempotency_key !== 'string') {
      return json({ error: 'invalid_idempotency_key' }, 400)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // The contract must exist. A UUID shape is required up front so that
    // marketplace fixture ids ('1', 'mock') fail here rather than as a
    // Postgres cast error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contract_id)) {
      return json({ error: 'contract_not_found' }, 404)
    }

    const { data: contract, error: contractError } = await admin
      .from('contracts')
      .select('id, project_name, dod, amount_jpy, currency, deadline, performed_by, '
        + 'earner_display_name, earner_user_id, invited_hirer_email, hirer_email, '
        + 'guest_access_token, guest_access_token_expires_at')
      .eq('id', contract_id)
      .maybeSingle()

    if (contractError) return json({ error: 'lookup_failed' }, 500)
    if (!contract) return json({ error: 'contract_not_found' }, 404)

    const actor = await resolveActor(req, admin, contract)
    if (!actor) return json({ error: 'not_a_party' }, 403)

    const roleHere = roleInAgreement(actor.role, contract.performed_by as string | null)
    const requiredRole = ROLE_REQUIRED[type]
    if (requiredRole && roleHere !== requiredRole) {
      return json({ error: 'wrong_party_for_event_type' }, 403)
    }

    // Idempotency: a retry returns what was already written.
    if (idempotency_key) {
      const { data: existing } = await admin
        .from('events')
        .select('*')
        .eq('contract_id', contract_id)
        .eq('idempotency_key', idempotency_key)
        .maybeSingle()
      if (existing) return json({ event: existing, deduplicated: true }, 200)
    }

    for (let attempt = 0; attempt < MAX_CHAIN_RETRIES; attempt++) {
      const { data: tip } = await admin
        .from('events')
        .select('event_hash')
        .eq('contract_id', contract_id)
        .not('event_hash', 'is', null)
        // Same ordering as accept_invitation and derive_contract_state. Two
        // events can share a millisecond, and a tip that depends on which row
        // the planner returns is a tip two writers can disagree about.
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle()

      const prevHash = tip?.event_hash ?? GENESIS_HASH

      // Everything that makes this row evidence — the terms pin, the agreement
      // snapshot and its hash, the actor's role, how they were authenticated —
      // is derived in _shared/eventRecord.ts, the one place that assembles an
      // event, so an assertion written here and an acceptance written by
      // validate-invite-token are the same kind of object.
      const event = await buildEventRecord({
        type,
        contract,
        actorId: actor.actorId,
        party: actor.role,
        payload,
        prevEventHash: prevHash,
        idempotencyKey: (idempotency_key as string | null) ?? null,
      })

      const { data: inserted, error: insertError } = await admin
        .from('events')
        .insert({
          ...event,
          server_recorded_at: new Date().toISOString(),
          tsa_token: null,
        })
        .select()
        .single()

      if (!insertError) return json({ event: inserted, deduplicated: false }, 201)

      // 23505 on the fork index means another event claimed this tip first.
      // Re-read the tip and try again.
      if (insertError.code === '23505') {
        if (insertError.message?.includes('events_idempotency_idx')) {
          const { data: existing } = await admin
            .from('events')
            .select('*')
            .eq('contract_id', contract_id)
            .eq('idempotency_key', idempotency_key as string)
            .maybeSingle()
          if (existing) return json({ event: existing, deduplicated: true }, 200)
        }
        continue
      }

      return json({ error: 'insert_failed', detail: insertError.message }, 500)
    }

    return json({ error: 'chain_contention' }, 409)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
