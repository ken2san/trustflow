import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.99.1'
import { corsHeaders } from '../_shared/cors.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCOPES = new Set(['read', 'accept', 'performance.asserted', 'performance.accepted',
  'performance.rejected', 'payment.reported', 'payment.acknowledged', 'payment.disputed'])
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
// The same technical cap as the table and the RPC; the database stays the authority.
const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1000
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
// A strict ISO 8601 instant inside (now, now + 30 days], passed on in canonical
// UTC form so the database never parses a string Date.parse read differently.
// Anything else is a 400, not a database error.
const parseExpiry = (value: unknown): string | null => {
  const m = typeof value === 'string' ? INSTANT.exec(value) : null
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null
  const at = Date.parse(value as string), now = Date.now()
  return Number.isFinite(at) && at > now && at <= now + MAX_GRANT_MS ? new Date(at).toISOString() : null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_body' }, 400)
    if (body.action === 'issue' && Deno.env.get('ENTRY_CREDENTIAL_ISSUANCE') !== 'on') {
      return json({ error: 'issuance_disabled' }, 503)
    }
    if (!['issue', 'revoke', 'list'].includes(body.action) || typeof body.contract_id !== 'string' || !UUID.test(body.contract_id)) {
      return json({ error: 'invalid_body' }, 400)
    }
    const authorization = req.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'not_authorized' }, 403)
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data, error } = await admin.auth.getUser(authorization.slice(7))
    if (error || !data?.user || data.user.is_anonymous !== false) return json({ error: 'not_authorized' }, 403)
    if (body.action === 'list') {
      const result = await admin.rpc('list_entry_agent_credentials', { p_contract_id: body.contract_id, p_issuer_id: data.user.id })
      return result.error ? json({ error: 'list_failed' }, 500) : json({ grants: result.data }, 200)
    }
    if (body.action === 'revoke') {
      if (typeof body.id !== 'string' || !UUID.test(body.id)) return json({ error: 'invalid_body' }, 400)
      const result = await admin.rpc('revoke_entry_agent_credential', {
        p_contract_id: body.contract_id, p_id: body.id, p_issuer_id: data.user.id,
      })
      if (result.error) return json({ error: 'revoke_failed' }, 500)
      return result.data?.status === 'revoked' ? json({ status: 'revoked' }, 200) : json({ error: 'not_authorized' }, 403)
    }
    if (!['owner_account', 'counterpart_account'].includes(body.issuer_kind)
      || !Array.isArray(body.scopes) || body.scopes.length === 0
      || body.scopes.some((s: unknown) => typeof s !== 'string' || !SCOPES.has(s))
      || new Set(body.scopes).size !== body.scopes.length
      || (body.issuer_kind === 'owner_account' && body.scopes.includes('accept'))
      || (body.invite !== undefined && typeof body.invite !== 'string')) return json({ error: 'invalid_grant' }, 400)
    const expiresAt = parseExpiry(body.expires_at)
    if (!expiresAt) return json({ error: 'invalid_grant' }, 400)
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)))
    const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    const result = await admin.rpc('issue_entry_agent_credential', {
      p_id: crypto.randomUUID(), p_contract_id: body.contract_id, p_issuer_id: data.user.id,
      p_issuer_kind: body.issuer_kind, p_secret_hash: hash, p_scopes: body.scopes,
      p_expires_at: expiresAt, p_invite: body.invite ?? null,
    })
    if (result.error) return json({ error: 'issue_failed' }, 500)
    if (result.data?.status === 'invalid_grant') return json({ error: 'invalid_grant' }, 400)
    if (result.data?.status !== 'issued') return json({ error: 'not_authorized' }, 403)
    return json({ grant: result.data, secret }, 201)
  } catch {
    return json({ error: 'internal_error' }, 500)
  }
})
