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
import {
  createdAtFollows, guestCredentialStillValid, idempotencyOutcome,
} from '../_shared/eventWriteRules.ts'
import {
  type AuthAssurance, assuranceFromClaims, bearerAssurance, claimsFromVerifiedJwt,
} from '../_shared/authAssurance.ts'

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
//
// access.reissued is the same kind of fact: it records that the owner replaced
// the counterparty's access credential, written by reissue-guest-access inside
// the transaction that replaces it. A party asserting it themselves would be
// claiming the credential changed when it did not.
const SERVER_RECORDED_TYPES = new Set([ACCEPTANCE_TYPE, 'access.reissued'])

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
): Promise<{ actorId: string; role: 'earner' | 'guest_hirer'; assurance: AuthAssurance } | null> {
  const guestToken = req.headers.get('x-guest-access-token')
  if (guestToken) {
    // One statement of what a live guest capability is, shared with the
    // re-check made just before the insert. See eventWriteRules.ts.
    if (!guestCredentialStillValid(contract, guestToken)) return null
    // The accepting email is the guest's established identity on this
    // contract — recorded by validate-invite-token, not chosen by the client.
    const hirerEmail = contract.hirer_email as string | null
    if (!hirerEmail) return null
    // A capability, and nothing more: no credential of this actor's own was
    // tested, so there is no authentication event to record.
    return {
      actorId: `guest:${hirerEmail}`,
      role: 'guest_hirer',
      assurance: bearerAssurance('guest_access_token'),
    }
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
  // Only now, with the token accepted by the auth server and its subject
  // matched against the user it verified, are its claims read. See
  // claimsFromVerifiedJwt for why that ordering is a check and not a comment.
  const claims = claimsFromVerifiedJwt(jwt, data.user.id)
  return {
    actorId: data.user.id,
    role: 'earner',
    assurance: assuranceFromClaims(claims),
  }
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

    const presentedGuestToken = req.headers.get('x-guest-access-token')
    const actor = await resolveActor(req, admin, contract)
    if (!actor) return json({ error: 'not_a_party' }, 403)

    const roleHere = roleInAgreement(actor.role, contract.performed_by as string | null)
    const requiredRole = ROLE_REQUIRED[type]
    if (requiredRole && roleHere !== requiredRole) {
      return json({ error: 'wrong_party_for_event_type' }, 403)
    }

    // Idempotency: a retry returns what THIS caller already wrote.
    //
    // THE DISCLOSURE THIS CLOSES
    // The match used to be contract_id + key, and the row was returned raw.
    // So a guest who supplied a key an owner had used received the owner's
    // event in full — payload, internal fields and all — bypassing the
    // allowlist projection that `guest-contract-events` exists to apply.
    // Measured 2026-11-06: an owner wrote `performance.asserted` carrying an
    // internal note under a known key, a guest called this function with
    // `performance.accepted` and the same key, and got back HTTP 200,
    // `deduplicated: true`, and the note. Found by Codex's sweep for
    // transaction boundaries; it is not one, which is why it had survived.
    //
    // A key is scoped to an operation, not to a contract. Matching the type
    // and the actor as well makes a retry a retry, and makes a collision a
    // collision — answered as one, rather than handed someone else's record.
    //
    // That rule is `idempotencyOutcome` in _shared/eventWriteRules.ts, and it
    // is the same call at all three places this function answers a key hit.
    // It was fixed here on 2026-11-06 and left unfixed in the unique-violation
    // branch below, where the row was still returned without asking whose it
    // was — one rule, three copies, and the drift went the only direction
    // drift ever goes.
    if (idempotency_key) {
      const { data: existing } = await admin
        .from('events')
        .select('*')
        .eq('contract_id', contract_id)
        .eq('idempotency_key', idempotency_key)
        .maybeSingle()
      const outcome = idempotencyOutcome(existing, { type, actorId: actor.actorId })
      if (outcome === 'replay') return json({ event: existing, deduplicated: true }, 200)
      // Same key, different operation. Refusing names the real problem;
      // returning the other event would disclose it, and writing a second
      // row under one key would make "idempotent" meaningless.
      if (outcome === 'conflict') return json({ error: 'idempotency_key_in_use' }, 409)
    }

    // Set when an attempt was abandoned because this isolate's clock was not
    // ahead of the chain tip, so the refusal at the end of the loop can say
    // which of the two things went wrong. Cleared whenever an attempt gets
    // past that check, since a later contention failure is a different fault.
    let behindTip: string | null = null

    for (let attempt = 0; attempt < MAX_CHAIN_RETRIES; attempt++) {
      const { data: tip } = await admin
        .from('events')
        // created_at comes back too: the stamp this event will carry has to be
        // later than its predecessor's, and this is the predecessor.
        .select('event_hash, created_at')
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
        assurance: actor.assurance,
        payload,
        prevEventHash: prevHash,
        idempotencyKey: (idempotency_key as string | null) ?? null,
      })

      // The stamp this event carries must be later than the one it follows.
      //
      // `created_at` is this isolate's clock, it is inside the event hash, and
      // every reader in the system orders by it — the tip read above,
      // `derive_contract_state()`, and the trail both parties are shown.
      // Nothing made it advance. Two events in the same millisecond are
      // ordered by a random UUID, and two isolates whose clocks disagree can
      // write a chain whose stamps run backwards: the tip read then returns
      // the wrong row, the fork index refuses every later write, and the
      // projected state is the one the inverted event names.
      //
      // So it is checked here, where the predecessor is in hand, and the
      // attempt is abandoned rather than written. A tie resolves itself on
      // the next pass, one round trip later; a real skew does not, and ends
      // as a refusal that names itself. See createdAtFollows for the two
      // alternatives — clamping the stamp, or ordering every reader by the
      // chain — and why neither was taken without the owner.
      if (!createdAtFollows(tip?.created_at as string | null | undefined, event.created_at)) {
        behindTip = (tip?.created_at as string | null) ?? null
        continue
      }
      behindTip = null

      // The credential is re-read here, immediately before the write.
      //
      // WHAT THIS CLOSES
      // A guest's authority was tested once, against the contract row read at
      // the top of the handler, and then the request went on: resolve the
      // actor, look up the idempotency key, read the chain tip, hash the
      // event — and up to five of those rounds on a contested tip. A token
      // the owner revoked anywhere in that window still wrote, because
      // nothing looked again. Revocation by overwrite is the only credential
      // withdrawal this system has (see reissue-guest-access), so a
      // revocation that a request in flight can outlive is not one.
      //
      // Narrowing, not closing: between this read and the insert there is
      // still a window, and shutting it entirely needs the check inside the
      // insert's own transaction — which is what enforce_performance_order
      // does for ordering, and which the event row cannot do here because it
      // does not carry the token that was presented. Named in the report;
      // not decided alone.
      if (actor.role === 'guest_hirer') {
        const { data: credential } = await admin
          .from('contracts')
          .select('guest_access_token, guest_access_token_expires_at')
          .eq('id', contract_id)
          .maybeSingle()
        if (!guestCredentialStillValid(credential, presentedGuestToken)) {
          // Deliberately its own reason rather than the `not_a_party` the
          // same failure answers at the top of the handler. A credential that
          // was good when the request arrived and is not good now is a
          // different event from one that was never good, and a log that
          // cannot tell them apart cannot show a revocation taking effect.
          return json({ error: 'guest_credential_revoked' }, 403)
        }
      }

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

      // The agreement is not in a state where this event can follow. Raised
      // by `enforce_performance_order`, inside the insert's own transaction
      // and under a lock on the contract row — see that migration for why an
      // Edge-side check would not have been enough.
      //
      // Answered here rather than falling through to `insert_failed`/500,
      // which is what a migration alone would have produced: a refusal that
      // reads as a server fault teaches the caller to retry something that
      // can never succeed. It is deliberately NOT routed into the retry below
      // — the loop exists for a contested chain tip, and retrying a
      // wrong-state refusal does nothing the caller did not already do. (Not
      // "refused identically forever": a later re-assertion after a rejection
      // legitimately changes the state. What is wrong is retrying it here,
      // automatically, inside one request.)
      if (insertError.code === 'TF001') {
        // ...unless this IS the operation that moved the state. Two requests
        // carrying the same idempotency key can both miss the lookup above;
        // one inserts and changes the state, the other waits on the lock and
        // is then refused by the trigger for a state its own twin created.
        // Answering 409 there would break the contract that a retry of one
        // operation returns what was written. Codex found this, 2026-11-06.
        //
        // Matched on type and actor as well as the key, so a different
        // operation that happens to reuse a key is still refused rather than
        // handed someone else's event.
        if (idempotency_key) {
          const { data: twin } = await admin
            .from('events')
            .select('*')
            .eq('contract_id', contract_id)
            .eq('idempotency_key', idempotency_key as string)
            .maybeSingle()
          if (idempotencyOutcome(twin, { type, actorId: actor.actorId }) === 'replay') {
            return json({ event: twin, deduplicated: true }, 200)
          }
        }
        return json({
          error: 'wrong_state_for_event_type',
          detail: insertError.message,
          hint: insertError.hint ?? null,
        }, 409)
      }

      // 23505 on the fork index means another event claimed this tip first.
      // Re-read the tip and try again.
      if (insertError.code === '23505') {
        if (insertError.message?.includes('events_idempotency_idx')) {
          // The same disclosure as the lookup above, reached the other way.
          // This branch runs when a row under the key was committed between
          // that lookup and this insert, so the row it finds is exactly as
          // likely to be the other party's — and until now it was returned
          // raw, without asking whose it was. Narrower than the lookup path,
          // and the same leak.
          const { data: raced } = await admin
            .from('events')
            .select('*')
            .eq('contract_id', contract_id)
            .eq('idempotency_key', idempotency_key as string)
            .maybeSingle()
          const racedOutcome = idempotencyOutcome(raced, { type, actorId: actor.actorId })
          if (racedOutcome === 'replay') return json({ event: raced, deduplicated: true }, 200)
          if (racedOutcome === 'conflict') return json({ error: 'idempotency_key_in_use' }, 409)
        }
        continue
      }

      return json({ error: 'insert_failed', detail: insertError.message }, 500)
    }

    if (behindTip) {
      // Not contention. This isolate's clock is not ahead of the chain, and
      // no number of retries fixes that. Said plainly so it is diagnosed as
      // the infrastructure fault it is rather than as a busy contract.
      return json({ error: 'clock_behind_chain', detail: `chain tip is stamped ${behindTip}` }, 409)
    }
    return json({ error: 'chain_contention' }, 409)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
