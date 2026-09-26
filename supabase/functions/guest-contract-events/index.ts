// supabase/functions/guest-contract-events/index.ts
//
// Read-side counterpart to log-event: lets a guest Hirer retrieve the evidence
// trail for the one contract they accepted.
//
// WHY A FUNCTION AND NOT A POLICY
// A guest has no auth.users row, so RLS cannot recognise them by uid. It is
// technically possible to write a policy that reads the token out of
// current_setting('request.headers'), but that returns whole rows, and whole
// rows are the problem: events carry hash internals, an idempotency key, a
// server timestamp, and payloads holding internal fields. Postgres column
// visibility is granted per role, not per request, so no policy can project a
// per-guest subset. Shaping the response is the requirement, so the shaping has
// to happen somewhere that runs per request. A SECURITY DEFINER rpc could also
// do it, but it would put the token in a request body Postgres logs, and would
// mean granting anon EXECUTE on a definer function — the exact pattern just
// cleaned up elsewhere in this schema.
//
// THE REQUEST CARRIES NOTHING
// There is no contract id in the body, because there is nothing to spoof if the
// server never reads one. The guest_access_token is looked up directly against
// contracts.guest_access_token (unique index), and the contract it resolves to
// IS the contract. Body-based spoofing is not defended against; it is
// structurally impossible.
//
// Deploy:
//   npx supabase functions deploy guest-contract-events

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  GENESIS_HASH, eventCanonical, canonicalVersionOf, payloadHash, sha256Hex,
  buildAgreementSnapshot,
} from '../_shared/eventCanonical.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-access-token',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const MAX_EVENTS = 500

// Payload keys a guest may see, per event type. Everything else is dropped.
//
// An allowlist rather than a denylist: payloads are free-form jsonb written
// over two trust models, so the set of keys that could appear is open-ended and
// a denylist would silently leak whatever gets added next. Notable exclusions:
//   _actor_role — internal; surfaced as actor.role instead
//   user_agent  — the accepting browser's UA, recorded by legacy consent rows
const PAYLOAD_ALLOWLIST: Record<string, string[]> = {
  'contract.initiated':    ['step', 'title', 'budgetPoints'],
  'contract.accepted':     ['step'],
  'performance.asserted':  ['step', 'note'],
  'performance.accepted':  ['step'],
  'performance.rejected':  ['step', 'reason'],
  // Retired names, kept so historical rows still render their detail.
  'work.submitted':        ['step'],
  'work.approved':         ['step'],
  'work.rejected':         ['step', 'reason'],
  'contract.cancelled':    ['reason'],
  'contract.completed':    [],
  'dod.consent_recorded':  ['counterparty_name', 'counterparty_email', 'dod_items'],
  'dispute.opened':        ['reason'],
  'rating.submitted':      ['rating'],
  // A party's claim about payment sent/received/disputed outside TrustFlow —
  // see log-event's ALLOWED_TYPES comment. 'note' is the only field either
  // side writes: method, reference, whatever they choose to say.
  'payment.reported':      ['note'],
  'payment.acknowledged':  ['note'],
  'payment.disputed':      ['note'],
}

function filterPayload(type: string, payload: unknown): Record<string, unknown> {
  const allowed = PAYLOAD_ALLOWLIST[type]
  // An unknown type gets an empty payload rather than a pass-through: a type
  // this function has not been taught about is one whose payload shape nobody
  // has reviewed.
  if (!allowed || typeof payload !== 'object' || payload === null) return {}
  const source = payload as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in source) out[key] = source[key]
  }
  return out
}

/**
 * Which agreed terms the contract row no longer matches.
 *
 * Built by re-deriving the snapshot from the CURRENT row with the same function
 * that produced the accepted one, so this comparison cannot drift from what the
 * hash actually binds. An empty list means the row still says what was agreed;
 * a non-empty one means the record moved and the accepted terms are the ones
 * the evidence proves.
 */
function termsChangedSinceAcceptance(
  accepted: Record<string, unknown> | null,
  contract: Record<string, unknown>,
): string[] | null {
  if (!accepted) return null
  const current = buildAgreementSnapshot(contract) as unknown as Record<string, unknown>
  return Object.keys(current)
    .filter(key => key !== 'snapshot_version')
    .filter(key => JSON.stringify(current[key]) !== JSON.stringify(accepted[key]))
}

/**
 * Describe who acted, without making the reader look up an opaque id.
 *
 * actor_id is kept: it is part of the hashed canonical, so removing it would
 * make the chain impossible for the guest to re-verify independently, and
 * independent verifiability is the point of the trail. It is an opaque random
 * uuid for the Earner — not an email, a name or a credential — so exposing it
 * to their counterparty costs little next to what redacting it would break.
 */
function describeActor(
  actorId: string | null,
  contract: Record<string, unknown>,
  actorRole: string | null,
) {
  if (!actorId) return { id: null, role: 'unknown', label: 'Unknown' }

  if (actorId === contract.earner_user_id) {
    return {
      id: actorId,
      role: 'earner',
      label: (contract.earner_display_name as string | null) ?? 'The other party',
    }
  }
  if (actorId.startsWith('guest:')) {
    return { id: actorId, role: 'guest_hirer', label: actorId.slice('guest:'.length) }
  }
  // Legacy rows: actor_id was whatever the browser supplied ('user', an email,
  // a display name). It identifies nobody reliably.
  return { id: actorId, role: actorRole ?? 'unknown', label: 'Unverified actor' }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const guestToken = req.headers.get('x-guest-access-token')
    if (!guestToken) return json({ error: 'missing_guest_token' }, 401)

    // A malformed token is rejected before it reaches the database, so a
    // non-uuid string cannot produce a cast error that distinguishes itself
    // from a miss.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guestToken)) {
      return json({ error: 'invalid_guest_token' }, 403)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // The token IS the contract identity. Nothing in the request selects it.
    const { data: contract, error: contractError } = await admin
      .from('contracts')
      .select('id, project_name, dod, amount_jpy, currency, deadline, state, performed_by, '
        + 'earner_user_id, earner_display_name, hirer_email, guest_access_token_expires_at')
      .eq('guest_access_token', guestToken)
      .maybeSingle()

    if (contractError) return json({ error: 'lookup_failed' }, 500)
    // Same response for "no such token" and "malformed token": a caller learns
    // nothing about which tokens exist.
    if (!contract) return json({ error: 'invalid_guest_token' }, 403)

    if (!contract.guest_access_token_expires_at
      || new Date(contract.guest_access_token_expires_at) < new Date()) {
      return json({ error: 'guest_token_expired' }, 403)
    }

    // Scoped to this contract by its id. runtime.snapshot rows carry
    // contract_id 'runtime' and legacy demo rows carry marketplace fixture ids
    // ('1', 'mock'), so neither can match a real contract's uuid — but the
    // snapshot type is excluded explicitly as well, because "it cannot happen"
    // is a weaker guarantee than "it is not selected".
    const { data: rows, error: eventsError } = await admin
      .from('events')
      .select('id, type, actor_id, payload, dod_hash, created_at, event_hash, prev_event_hash, hash_version, payload_hash, agreement_hash')
      .eq('contract_id', contract.id)
      .neq('type', 'runtime.snapshot')
      // The same ordering the writers use to pick the tip, read backwards.
      // created_at comes from the writer's clock in milliseconds, so two events
      // can share one; replaying them in an order the chain was not built in
      // reports chain_linked false on an untouched record, which is the one
      // failure this product can least afford.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MAX_EVENTS)

    if (eventsError) return json({ error: 'events_lookup_failed' }, 500)

    let expectedPrev = GENESIS_HASH
    const events = []

    for (const row of rows ?? []) {
      // Three canonical formats now exist; a row is verified under the one it
      // was written with. Applying the newest to an older row reports an
      // untouched event as tampered with.
      const hashVersion = canonicalVersionOf(row)
      const recomputed = await sha256Hex(eventCanonical({
        id:              row.id,
        type:            row.type,
        contract_id:     contract.id,
        actor_id:        row.actor_id,
        dod_hash:        row.dod_hash ?? null,
        created_at:      row.created_at,
        prev_event_hash: row.prev_event_hash,
        payload_hash:    row.payload_hash,
        agreement_hash:  row.agreement_hash,
      }, hashVersion))

      // From v3 the payload is bound into the hash, so the substance of an
      // assertion can be checked as well as its authorship. null rather than
      // false for older rows: TrustFlow never attested their payloads, which is
      // a different statement from the check having failed.
      const substanceValid = hashVersion >= 3 && row.payload_hash
        ? (await payloadHash(row.payload ?? {})) === row.payload_hash
        : null

      const actorRole = (row.payload as Record<string, unknown> | null)?._actor_role as string | null

      events.push({
        id:         row.id,
        type:       row.type,
        created_at: row.created_at,
        actor:      describeActor(row.actor_id, contract, actorRole ?? null),
        dod_hash:   row.dod_hash ?? null,
        payload:    filterPayload(row.type, row.payload),
        integrity: {
          // v1 rows were written by a browser that chose its own actor_id,
          // type and hash. They are preserved as history, not as attestation.
          trust_model:     hashVersion >= 2 ? 'server_attested' : 'client_asserted',
          event_hash:      row.event_hash ?? null,
          prev_event_hash: row.prev_event_hash ?? null,
          hash_valid:      row.event_hash ? row.event_hash === recomputed : null,
          chain_linked:    row.prev_event_hash ? row.prev_event_hash === expectedPrev : null,
          substance_valid: substanceValid,
          // From v4 the whole deal is bound, not just its completion criteria.
          binds_whole_agreement: hashVersion >= 4,
        },
      })

      // Advance regardless of match, so a break also surfaces on the next
      // event rather than silently resetting the expected chain.
      expectedPrev = row.event_hash ?? expectedPrev
    }

    // The deal as it stood when it was accepted, taken from the acceptance
    // event rather than from the contract row. The row may legitimately have
    // moved on, and the historical record must not depend on it.
    const acceptance = (rows ?? []).find(r => r.type === 'dod.consent_recorded')
    const acceptedAgreement = (acceptance?.payload as Record<string, unknown> | null)?._agreement ?? null
    const invitedRecipient = (acceptance?.payload as Record<string, unknown> | null)?._invited_recipient ?? null
    const claimedIdentity = (acceptance?.payload as Record<string, unknown> | null)?._claimed_identity ?? null

    const attested = events.filter(e => e.integrity.trust_model === 'server_attested')

    return json({
      // What was ACCEPTED, recorded at the time. Null for agreements accepted
      // before the snapshot existed — absent, not reconstructed.
      accepted_agreement: acceptedAgreement,
      // Terms on which the current row and the accepted agreement disagree.
      // Empty when they still match; null when there is no accepted snapshot
      // to compare against.
      terms_changed_since_acceptance: termsChangedSinceAcceptance(
        acceptedAgreement as Record<string, unknown> | null, contract),
      // Kept apart: an invitation can be forwarded, and the divergence is
      // itself evidence. Neither address is verified.
      acceptance_identity: acceptance ? {
        invited_recipient: invitedRecipient,
        claimed_identity: claimedIdentity,
        claimed_identity_verified: false,
        authentication: (acceptance.payload as Record<string, unknown>)?._auth_method ?? null,
      } : null,
      // The CURRENT row. May differ from accepted_agreement.
      contract: {
        id:                  contract.id,
        project_name:        contract.project_name,
        dod:                 contract.dod,
        amount_jpy:          contract.amount_jpy,
        currency:            contract.currency,
        deadline:            contract.deadline,
        state:               contract.state,
        // Which side does the work. The guest needs it to know whether the
        // next action is theirs, and it is a term of the deal rather than
        // anything internal.
        performed_by:        contract.performed_by,
        // The guest is always the counterparty; saying so plainly saves the
        // client from re-deriving it.
        viewer_role:         contract.performed_by === 'counterparty' ? 'performer' : 'receiver',
        earner_display_name: contract.earner_display_name,
        // The address that accepted — this guest's own, echoed back so the
        // trail is self-describing in an export.
        hirer_email:         contract.hirer_email,
      },
      events,
      chain: {
        event_count:          events.length,
        server_attested:      attested.length,
        client_asserted:      events.length - attested.length,
        // True only if every row that carries the material to be checked
        // checks out. Rows with nothing to verify do not count as verified.
        verified: attested.length > 0
          && attested.every(e => e.integrity.hash_valid !== false && e.integrity.chain_linked !== false),
        truncated: (rows?.length ?? 0) >= MAX_EVENTS,
        // Whether the detail fields are tamper-evident, stated rather than left
        // for a reader to discover. True only when every returned event was
        // written under a canonical that binds its payload; events from before
        // that are covered for authorship and timing but not for substance.
        payload_covered_by_hash: events.length > 0
          && events.every(e => e.integrity.substance_valid !== null),
      },
    }, 200)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
