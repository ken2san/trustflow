// supabase/functions/create-payment-intent/index.ts
//
// Creates a Stripe PaymentIntent for a TrustFlow contract.
// Funds are captured immediately and held in the platform's Stripe Connect
// balance until `capture-payment` releases them to the Earner.
//
// Called by the frontend once the Hirer has accepted terms (TERMS_ACCEPTED state).
// The Hirer is authorized either as a guest (X-Guest-Access-Token, issued by
// validate-invite-token's accept step) or, if they later register, via Supabase
// Auth matching hirer_user_id — see _shared/partyAuth.ts. The amount is always
// the contract's own DB-owned amount_jpy; a client-supplied amount is never trusted.
//
// Environment variables required (set in Supabase dashboard → Edge Functions):
//   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  — for webhook signature verification (not used here)
//
// Deploy:
//   npx supabase functions deploy create-payment-intent

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import Stripe from 'npm:stripe@^14'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { authorizeParty } from '../_shared/partyAuth.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-access-token',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { contractId, description } = await req.json()

    if (!contractId) {
      return new Response(JSON.stringify({ error: 'contractId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: contract, error: contractError } = await supabase
      .from('contracts')
      .select('*')
      .eq('id', contractId)
      .single()

    if (contractError || !contract) {
      return new Response(JSON.stringify({ error: 'Contract not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Only the Hirer (guest or registered) may fund the contract.
    const party = await authorizeParty(req, supabase, contract)
    if (!party || party.role !== 'hirer') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (contract.state !== 'TERMS_ACCEPTED') {
      return new Response(JSON.stringify({ error: `Cannot charge in state: ${contract.state}` }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Charging is JPY-only, and after 2026-11-08 a contract need not be. The
    // PaymentIntent below hard-codes `currency: 'jpy'`, so a CAD contract would
    // be charged its cent amount as yen. Refused rather than converted: there
    // is no FX anywhere in this system, and adding one at a payment boundary
    // is a product and compliance decision. Same guard as capture-payment.
    if (contract.currency !== 'JPY') {
      return new Response(JSON.stringify({
        error: 'currency_not_chargeable',
        detail: `Charging is JPY-only; this contract is in ${contract.currency}`,
      }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Amount is always the contract's own DB-owned value — a client-supplied
    // amount is never trusted, regardless of what the frontend displays.
    // Guarded above: JPY only, where amount_minor and amount_jpy are equal.
    const amountJpy = contract.amount_minor ?? contract.amount_jpy
    if (!Number.isInteger(amountJpy) || amountJpy < 50 || amountJpy > 10_000_000) {
      return new Response(JSON.stringify({ error: 'Contract has no valid amount' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (contract.stripe_payment_intent_id) {
      return new Response(JSON.stringify({ error: 'Payment already created for this contract' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Create Stripe PaymentIntent
    // capture_method: 'automatic' — charges immediately, funds held in platform balance
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountJpy,        // Stripe uses smallest currency unit (JPY is already integer)
      currency: 'jpy',
      description: description ?? `TrustFlow contract ${contractId}`,
      // Stripe sends its own payment receipt to the Hirer automatically
      ...(contract.hirer_email ? { receipt_email: contract.hirer_email } : {}),
      metadata: {
        contract_id: contractId,
        earner_user_id: contract.earner_user_id,
        hirer_email: contract.hirer_email ?? '',
      },
      // Platform holds funds until explicit transfer to earner
      transfer_group: contractId,
    })

    // Store the PaymentIntent ID on the contract. Guard against a concurrent
    // duplicate create winning the race (idempotency).
    const { data: updated, error: updateError } = await supabase
      .from('contracts')
      .update({ stripe_payment_intent_id: paymentIntent.id, state: 'IN_PROGRESS' })
      .eq('id', contractId)
      .is('stripe_payment_intent_id', null)
      .select('id')

    if (updateError || !updated || updated.length === 0) {
      // Lost the race — cancel the PaymentIntent we just created so it's not orphaned.
      await stripe.paymentIntents.cancel(paymentIntent.id).catch(() => {})
      return new Response(JSON.stringify({ error: 'Payment already created for this contract' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[create-payment-intent]', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
