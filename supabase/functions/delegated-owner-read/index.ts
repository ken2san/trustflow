// supabase/functions/delegated-owner-read/index.ts
//
// Row 5b (docs/plans/row5-owner-read.md §5b): an owner-issued `read` grant
// retrieves one deal's authorized projection and a portable receipt.
//
// AUTHORITY
// `Authorization: Bearer <public anon key>` is gateway transport only. The
// grant travels in `x-trustflow-grant`; only the SHA-256 of its secret leaves
// this function (_shared/delegatedAuth.ts). The database decides everything
// under its locks in ONE call, read_delegated_owner_deal, which also
// materializes the data. This function never reads a table: no deal pre-read,
// no event count, no acceptance lookup, no owner-session or guest fallback.
//
// ANSWERS
// 200 the envelope; 400 malformed body; 405 method; 403 `delegation_refused`
// for every authorization refusal, one answer that reveals nothing about a
// grant; 503 `delegated_read_unavailable` when the route is off or the RPC is
// absent; 500 `response_too_large` when the encoded envelope would exceed
// MAX_RESPONSE_BYTES (2 MiB UTF-8): no deal data, and no partial envelope,
// since trimming would have to rebuild prefix, boundary and receipt together;
// 500 `internal_error` for anything else, never the raw error. Every
// answer is `Cache-Control: private, no-store`. Log lines carry a fixed reason
// and validated ids or null: never a header, a secret or deal data. A database
// error code is logged only from LOGGED_ERROR_CODES, otherwise as `rpc_error`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.99.1'
import { corsHeaders } from '../_shared/cors.ts'
import { DELEGATION_REFUSED, delegatedAdmission, refusalAnswer } from '../_shared/delegatedAuth.ts'
import { MAX_RESPONSE_BYTES, encodeOwnerRead, shapeOwnerRead } from '../_shared/ownerReadResponse.ts'

export const DELEGATED_READ_UNAVAILABLE = { error: 'delegated_read_unavailable', status: 503 } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NO_STORE = 'private, no-store'
// Error codes this route may write to a log verbatim: the PostgreSQL states a
// read can meet (serialization, deadlock, lock or statement timeout, aborted
// transaction, connection), the project's isolation guard, and PostgREST's
// own. Anything else, being whatever string arrived, is logged as rpc_error.
const LOGGED_ERROR_CODES = new Set([
  '40001', '40P01', '55P03', '57014', '25P02', '53300', '08006', 'TF005',
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'PGRST301',
])

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...cors, 'Cache-Control': NO_STORE } })
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': NO_STORE },
  })
  const log = (level: 'warn' | 'error', fields: Record<string, unknown>) =>
    console[level](JSON.stringify({ fn: 'delegated-owner-read', ...fields }))

  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    // Off until its own release decision, independent of the append rollout.
    if (Deno.env.get('ENTRY_DELEGATED_READ') !== 'on') {
      return json({ error: DELEGATED_READ_UNAVAILABLE.error }, DELEGATED_READ_UNAVAILABLE.status)
    }

    // Body shape first, answered the same for every deal: exactly one key.
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.contract_id !== 'string' || !UUID.test(body.contract_id)) {
      return json({ error: 'invalid_body' }, 400)
    }
    const contractId: string = body.contract_id

    const delegation = await delegatedAdmission(req.headers, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
    const credentialId = delegation.delegated && delegation.ok ? delegation.credentialId : null
    const refuse = (reason: string) => {
      log('warn', { delegated_read_refusal: reason, contract_id: contractId, credential_id: credentialId })
      return json({ error: DELEGATION_REFUSED.error }, DELEGATION_REFUSED.status)
    }
    if (!delegation.delegated) return refuse('not_delegated')
    if (!delegation.ok) return refuse(delegation.reason)

    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data, error } = await admin.rpc('read_delegated_owner_deal', {
      p_contract_id: contractId, p_credential_id: delegation.credentialId, p_secret_hash: delegation.secretHash,
    })
    if (error) {
      if (error.code === 'PGRST202') {
        log('error', { delegated_read_fault: 'rpc_missing', contract_id: contractId })
        return json({ error: DELEGATED_READ_UNAVAILABLE.error }, DELEGATED_READ_UNAVAILABLE.status)
      }
      const code = typeof error.code === 'string' && LOGGED_ERROR_CODES.has(error.code) ? error.code : 'rpc_error'
      log('error', { delegated_read_fault: code, contract_id: contractId, credential_id: credentialId })
      return json({ error: 'internal_error' }, 500)
    }

    const status = data?.status
    if (status !== 'ok') {
      if (typeof status === 'string' && refusalAnswer(status) === DELEGATION_REFUSED) return refuse(status)
      // The read RPC has no gate and no other status: this is drift.
      log('error', { delegated_read_fault: 'unexpected_status', contract_id: contractId, credential_id: credentialId })
      return json({ error: 'internal_error' }, 500)
    }

    const encoded = encodeOwnerRead(await shapeOwnerRead(data))
    if (encoded.over) {
      log('error', { delegated_read_fault: 'response_too_large', bytes: encoded.bytes, limit: MAX_RESPONSE_BYTES, contract_id: contractId, credential_id: credentialId })
      return json({ error: 'response_too_large' }, 500)
    }
    return new Response(encoded.text, {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': NO_STORE },
    })
  } catch {
    log('error', { delegated_read_fault: 'unexpected_throw' })
    return json({ error: 'internal_error' }, 500)
  }
})
