// ⚠️ NOT DEPLOYED, ON PURPOSE. Deleted from the Supabase project 2026-09-26.
//
// Kept in source control so the work is not lost, not because it is live. Do not
// run `supabase functions deploy` on it without reading why it was removed.
//
// UNREACHABLE. Its only caller in the app is handleNextStep step 4, in the legacy
// five-step flow, gated on state === SETTLED — which the current state machine
// cannot reach. capture-payment also calls it server-side, but fire-and-forget
// and without inspecting the response, so its absence changes nothing there.
//
// AND STILL ABUSABLE WHILE DEPLOYED. An Edge Function is a public HTTPS endpoint
// whether or not src/ calls it, and the anon key that authorizes it ships inside
// the frontend bundle. The version that was live read the recipient, project
// name, DoD and amount straight from the request body, so any caller could send
// arbitrary content from this project's verified domain to any address.
//
// The source below is the CORRECTED version; what was live was the pre-fix
// source. That is what made deletion the right answer rather than a deploy. If
// this is ever brought back, deploy THIS file, then confirm the deployed source
// by downloading it back and diffing it — an `updated_at` change can be a
// secrets re-bundle rather than a deploy.

// supabase/functions/send-acceptance-email/index.ts
//
// Sends the Hirer a DoD acceptance confirmation email after a contract is SETTLED.
// The email captures: project name, DoD items, DoD hash, amount, timestamp, and
// contract ID — serving as chargeback/dispute evidence in Stripe.
//
// The caller supplies only contract_id. Every other field (recipient, amount,
// DoD, hash) is loaded from the contract record itself — a caller cannot make
// this function send arbitrary attacker-chosen content to an arbitrary
// address, and it only fires for contracts that are actually SETTLED.
//
// Gracefully skips (logs warning, returns 200) if RESEND_API_KEY is not set.
//
// Environment variables required:
//   RESEND_API_KEY        — Resend API key (https://resend.com)
//   EMAIL_FROM            — optional sender override (default: TrustFlow <noreply@trustflow.app>)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:
//   npx supabase functions deploy send-acceptance-email

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { formatMinor } from '../_shared/money.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

interface EmailPayload {
  hirer_email: string
  project_name: string
  dod: string[]
  dod_hash: string
  amount_minor: number
  currency: string
  contract_id: string
  settled_at: string // ISO 8601
}

function buildHtml(p: EmailPayload): string {
  const dodRows = p.dod
    .map((item, i) => `<li style="margin:6px 0">${i + 1}. ${escHtml(item)}</li>`)
    .join('')

  // The contract's own currency, with that currency's own decimals. It used to
  // be a fixed ja-JP/JPY format, which would have stated a CA$12.50 agreement
  // as ¥1,250 in a confirmation email. This function is retired in production
  // (it answers 404); the format is corrected rather than left wrong so that
  // whoever revives it does not revive the error with it.
  const formattedAmount = formatMinor(p.amount_minor, p.currency, 'en-CA')

  const formattedDate = new Date(p.settled_at).toLocaleString('en-US', {
    timeZone: 'UTC',
    dateStyle: 'long',
    timeStyle: 'short',
  }) + ' UTC'

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>DoD Confirmation</title></head>
<body style="font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7">

    <div style="background:#09090b;padding:24px 32px">
      <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.5px">TrustFlow</span>
      <span style="color:#71717a;font-size:13px;margin-left:12px">Agreement Confirmation</span>
    </div>

    <div style="padding:32px">
      <h1 style="font-size:18px;font-weight:600;color:#09090b;margin:0 0 4px">
        ${escHtml(p.project_name)}
      </h1>
      <p style="font-size:13px;color:#71717a;margin:0 0 24px">
        Settlement confirmed on ${formattedDate}
      </p>

      <div style="background:#f4f4f5;border-radius:6px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Contract Value</div>
        <div style="font-size:28px;font-weight:700;color:#09090b">${escHtml(formattedAmount)}</div>
      </div>

      <h2 style="font-size:14px;font-weight:600;color:#09090b;margin:0 0 12px">
        Definition of Done
      </h2>
      <ul style="margin:0 0 24px;padding-left:20px;color:#3f3f46;font-size:14px;line-height:1.6">
        ${dodRows}
      </ul>

      <div style="border-top:1px solid #e4e4e7;padding-top:20px;margin-top:4px">
        <div style="font-size:12px;color:#71717a;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">
          Verification Fingerprints
        </div>
        <table style="width:100%;font-size:12px;color:#52525b;border-collapse:collapse">
          <tr>
            <td style="padding:4px 0;width:110px;font-weight:500;color:#3f3f46">Contract ID</td>
            <td style="padding:4px 0;font-family:monospace;word-break:break-all">${escHtml(p.contract_id)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;font-weight:500;color:#3f3f46">DoD Hash</td>
            <td style="padding:4px 0;font-family:monospace;word-break:break-all">${escHtml(p.dod_hash)}</td>
          </tr>
        </table>
      </div>
    </div>

    <div style="background:#f4f4f5;padding:16px 32px;font-size:12px;color:#71717a;line-height:1.5">
      This email confirms the Definition of Done agreed by both parties before payment was released.
      The DoD hash above can be used to independently verify the contents of this agreement have not been altered.
      Keep this email as evidence in the event of a payment dispute.
    </div>

  </div>
</body>
</html>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.warn('[send-acceptance-email] RESEND_API_KEY not set — skipping email')
    return new Response(JSON.stringify({ skipped: true, reason: 'no_api_key' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { contract_id } = await req.json()
    if (!contract_id) {
      return new Response(JSON.stringify({ error: 'contract_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Everything the email says comes from the contract record itself —
    // a caller cannot inject arbitrary recipient/amount/DoD content, and
    // this only ever fires for a contract that is actually SETTLED.
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, project_name, dod, dod_hash, amount_minor, currency, hirer_email, state, updated_at')
      .eq('id', contract_id)
      .single()

    if (error || !contract) {
      return new Response(JSON.stringify({ error: 'Contract not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (contract.state !== 'SETTLED') {
      return new Response(JSON.stringify({ error: `Contract is not settled (state: ${contract.state})` }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!contract.hirer_email) {
      return new Response(JSON.stringify({ error: 'Contract has no hirer_email on file' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const payload: EmailPayload = {
      hirer_email: contract.hirer_email,
      project_name: contract.project_name,
      dod: Array.isArray(contract.dod) ? contract.dod : [],
      dod_hash: contract.dod_hash ?? '',
      amount_minor: contract.amount_minor,
      currency: contract.currency,
      contract_id: contract.id,
      settled_at: contract.updated_at,
    }

    const from = Deno.env.get('EMAIL_FROM') ?? 'TrustFlow <noreply@trustflow.app>'
    const subject = `Agreement Confirmed: ${payload.project_name}`
    const html = buildHtml(payload)

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [payload.hirer_email], subject, html }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[send-acceptance-email] Resend error', res.status, body)
      return new Response(JSON.stringify({ error: 'Email delivery failed', detail: body }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { id: emailId } = await res.json()
    console.log('[send-acceptance-email] sent', emailId, 'to', payload.hirer_email)

    return new Response(JSON.stringify({ sent: true, emailId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[send-acceptance-email]', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
