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

// DEPENDENCIES, AND WHY THEY LOOK LIKE THIS
// No std/http import: the HTTP entry point is the runtime's own `Deno.serve`.
// This used to import `serve` from deno.land/std@0.177.0, from early 2023. That
// `serve` is deprecated and its own docs point at `Deno.serve`, so the
// dependency is removed rather than carried forward — Supabase's guidance is the
// built-in. A newer std would also have worked: 0.224.0 still exports `serve`,
// deprecated and scheduled for removal at 1.0. An earlier version of this
// comment said the pin could only be dropped and not moved forward, which Codex
// checked and found untrue; the reason to drop it is the deprecation, not an
// absence of alternatives.
//
// `@supabase/supabase-js` is pinned to an EXACT version. It was `@2`, which
// esm.sh resolves to the latest 2.x at deploy time: a redeploy that changed
// nothing in this repository could change the client library underneath an
// auth and evidence path, and the bundle digests two releases compare would
// disagree for no reason anybody could name. 2.99.1 is the release the web
// client's lockfile names, so both halves declare the SAME SDK RELEASE.
//
// Not the same bytes, and the distinction is the point: esm.sh builds for a
// different target than npm packs for, and a declared version is not an
// artifact. Comparing measured `ezbr_sha256` between projects stays the check
// that production got what E2E tested; this pin only stops the input drifting
// on its own.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.99.1'
import { corsHeaders } from '../_shared/cors.ts'
import { guestResponse, requestedResponseVersion, shadowStrictLog } from '../_shared/guestResponse.ts'

// CORS is per request now, from ../_shared/cors.ts: the allowed origin depends
// on who asked, so there is no constant to share. A caller that sends no Origin
// — every server-side client, including the harnesses and anything following
// /agent-protocol.md — is unaffected. The header list lives there too, as one
// union for all four functions; see that file for why that is safer than a
// per-function list.

const MAX_EVENTS = 500

// The payload allowlist and the shaping of a verifiable act now live in
// _shared/guestEventView.ts, where they can be exercised without a live
// request. See that file for why.

// termsChangedSinceAcceptance and the response body now live in
// _shared/guestResponse.ts, where both response versions can be tested.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })

  // Built here, not at module scope, because the allowed origin depends on
  // this request. Every `json(...)` call below is inside this handler, so the
  // signature stays two arguments and no call site changed — which matters for
  // a commit that cannot be deploy-tested: there is no third argument to forget
  // at one of the twenty-odd refusal paths.
  const cors = corsHeaders(req)
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })


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
      .select('id, project_name, dod, amount_jpy, amount_minor, currency, deadline, state, performed_by, earner_user_id, earner_display_name, hirer_email, guest_access_token_expires_at')
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

    // After the credential refusals, which come first. Absent means version 1.
    const requested = requestedResponseVersion(req.url)
    if (!requested.ok) return json({ error: requested.error }, requested.status)

    // Scoped to this contract by its id. runtime.snapshot rows carry
    // contract_id 'runtime' and legacy demo rows carry marketplace fixture ids
    // ('1', 'mock'), so neither can match a real contract's uuid — but the
    // snapshot type is excluded explicitly as well, because "it cannot happen"
    // is a weaker guarantee than "it is not selected".
    const { data: rows, error: eventsError, count } = await admin
      .from('events')
      // The v5 authority pair is selected explicitly (row 3). These columns
      // exist on E2E (T199); deploying this to a database without them makes
      // every read fail, so production storage must come first.
      //
      // `count: 'exact'` is the tail evidence for version 2: PostgREST counts
      // in the same statement, under the same filters, as the page. A short
      // page is not evidence of the end (Codex T174). Version 1 ignores it.
      .select('id, type, actor_id, payload, dod_hash, created_at, event_hash, prev_event_hash, hash_version, payload_hash, agreement_hash, credential_id, issuer_kind',
        { count: 'exact' })
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

    // Both versions are built in _shared/guestResponse.ts. Version 1 is the
    // literal that used to be here, moved verbatim, and never runs the strict
    // reader; version 2 fails closed if it throws.
    const response = await guestResponse(rows ?? [], contract, {
      version: requested.version, maxEvents: MAX_EVENTS, count,
    })

    // The shadow strict log, after the body exists. It never throws, so a
    // strict-only failure cannot turn a version 1 read into a 500.
    const log = await shadowStrictLog(rows ?? [], contract, response, { version: requested.version, count })
    if (log) console.warn(JSON.stringify(log))

    return json(response.body, 200)

  } catch (err) {
    return json({ error: 'internal_error', detail: String(err) }, 500)
  }
})
