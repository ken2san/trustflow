// supabase/functions/capture-payment/index.ts
//
// Releases held funds to the Earner's Stripe Connected Account.
// Called after the Hirer has confirmed performance (state === PERFORMANCE_ACCEPTED). The caller
// must authorize as the Hirer — guest (X-Guest-Access-Token) or, if later
// registered, Supabase Auth matching hirer_user_id. See _shared/partyAuth.ts.
//
// The settlement destination is resolved server-side from
// contracts.earner_user_id -> earner_payout_profiles, never from the request
// body. If the Earner has no payout profile on file yet, settlement fails
// safely: no transfer, no state change, no points awarded.
//
// Flow:
//   1. Verify contract is in PERFORMANCE_ACCEPTED state and caller is the Hirer
//   2. Resolve the Earner's Stripe Connected Account server-side
//   3. Retrieve the Stripe PaymentIntent
//   4. Create a Stripe Transfer to the Earner's Connected Account
//   5. Update contract state → SETTLED, store transfer ID
//   6. Award TrustPoints
//
// Environment variables required:
//   STRIPE_SECRET_KEY
//
// Deploy:
//   npx supabase functions deploy capture-payment

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import Stripe from 'npm:stripe@^14'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { authorizeParty } from '../_shared/partyAuth.ts'
import { TP_CONTRACT_COMPLETED, TP_ON_TIME_BONUS, TP_CONTRACT_COMPLETED_HIRER } from '../_shared/trustpointsRules.ts'

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
    const { contractId } = await req.json()

    if (!contractId) {
      return new Response(JSON.stringify({ error: 'contractId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Load contract
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

    // Only the Hirer confirms delivery and releases funds.
    const party = await authorizeParty(req, supabase, contract)
    if (!party || party.role !== 'hirer') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Only from PERFORMANCE_ACCEPTED: the state a contract reaches when the
    // HIRER has confirmed the Earner's assertion of performance.
    //
    // This deliberately replaces the old 'DELIVERED' gate. 'DELIVERED' read as
    // an established fact but nothing ever set it, and the projection that
    // would have set it is driven by the Earner's own assertion. Gating an
    // irreversible transfer on a state one party can reach alone is the exact
    // failure this boundary exists to prevent — an assertion is not a
    // confirmation, and only a confirmation opens this door.
    if (contract.state !== 'PERFORMANCE_ACCEPTED') {
      return new Response(JSON.stringify({ error: `Cannot capture in state: ${contract.state}` }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Settlement is JPY-only, and after 2026-11-08 a contract need not be.
    //
    // The transfer below hard-codes `currency: 'jpy'` and sends
    // `contract.amount_jpy` as the amount. For a CAD contract that column is
    // NULL (20261108161000) and `amount_minor` is cents, so the two ways this
    // could have gone wrong are a transfer of null yen and a transfer of
    // 1250 YEN for a CA$12.50 agreement. Payment behaviour is deliberately NOT
    // being extended here — Stripe settlement is retired in production and
    // multi-currency payout is a product and compliance decision, not a
    // formatting one. So this refuses, before the settlement claim is written,
    // rather than transferring an amount in the wrong unit.
    if (contract.currency !== 'JPY') {
      return new Response(JSON.stringify({
        error: 'currency_not_settleable',
        detail: `Settlement is JPY-only; this contract is in ${contract.currency}`,
      }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const paymentIntentId = contract.stripe_payment_intent_id
    if (!paymentIntentId) {
      return new Response(JSON.stringify({ error: 'No PaymentIntent on this contract' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Resolve the settlement destination server-side. The client never
    // decides where funds go. No profile on file -> fail safely, nothing released.
    const { data: payoutProfile } = await supabase
      .from('earner_payout_profiles')
      .select('stripe_connected_account_id')
      .eq('user_id', contract.earner_user_id)
      .single()

    const earnerStripeAccountId = payoutProfile?.stripe_connected_account_id
    if (!earnerStripeAccountId) {
      return new Response(JSON.stringify({ error: 'Earner has no payout account on file' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Idempotency: claim settlement before touching Stripe, so a concurrent
    // duplicate call can't double-transfer. Uses a separate claim timestamp
    // rather than a transient `state` value, keeping `state` limited to the
    // spec's canonical list.
    const { data: claimed, error: claimError } = await supabase
      .from('contracts')
      .update({ settlement_claimed_at: new Date().toISOString() })
      .eq('id', contractId)
      .eq('state', 'PERFORMANCE_ACCEPTED')
      .is('settlement_claimed_at', null)
      .select('id')

    if (claimError || !claimed || claimed.length === 0) {
      return new Response(JSON.stringify({ error: 'Settlement already in progress or completed' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Retrieve PaymentIntent to get the charge ID
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
    const chargeId = pi.latest_charge as string

    let transferId: string
    try {
      const transfer = await stripe.transfers.create({
        // Guarded above: this line is only reached for a JPY contract, where
        // amount_minor and amount_jpy are the same integer by CHECK.
        amount: contract.amount_minor ?? contract.amount_jpy,
        currency: 'jpy',
        destination: earnerStripeAccountId,
        source_transaction: chargeId,
        transfer_group: contractId,
        metadata: { contract_id: contractId },
      })
      transferId = transfer.id
    } catch (transferErr) {
      // Roll back the claim so a retry is possible.
      await supabase.from('contracts').update({ settlement_claimed_at: null }).eq('id', contractId)
      throw transferErr
    }

    // Finalize
    await supabase
      .from('contracts')
      .update({ state: 'SETTLED', stripe_transfer_id: transferId })
      .eq('id', contractId)

    // Award TrustPoints
    const isOnTime = contract.deadline
      ? new Date() <= new Date(contract.deadline)
      : false

    const earnedPoints = TP_CONTRACT_COMPLETED + (isOnTime ? TP_ON_TIME_BONUS : 0)

    // Earner points — the real reward, always applicable (earner_user_id is NOT NULL).
    await supabase.from('trustpoints_ledger').insert({
      user_id: contract.earner_user_id,
      delta: earnedPoints,
      reason: `Contract completed${isOnTime ? ' on time' : ''}`,
      reason_code: isOnTime ? 'CONTRACT_COMPLETED_ON_TIME' : 'CONTRACT_COMPLETED',
      contract_id: contractId,
    })

    // Hirer points (smaller reward for fair completion) — only if the Hirer
    // has a registered account to credit. A pure guest has no user id.
    if (contract.hirer_user_id) {
      await supabase.from('trustpoints_ledger').insert({
        user_id: contract.hirer_user_id,
        delta: TP_CONTRACT_COMPLETED_HIRER,
        reason: 'Contract completed as Hirer',
        reason_code: 'CONTRACT_COMPLETED_HIRER',
        contract_id: contractId,
      })
    }

    // H1: Send DoD acceptance email to the Hirer — fire-and-forget.
    // Email failure must never block fund release. send-acceptance-email now
    // loads everything it needs (recipient, amount, DoD) from the contract
    // record itself once it sees state === SETTLED, so only the id is passed.
    if (contract.hirer_email) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      fetch(`${supabaseUrl}/functions/v1/send-acceptance-email`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contract_id: contractId }),
      }).catch((err) => console.error('[capture-payment] email dispatch failed', err))
    }

    return new Response(
      JSON.stringify({ success: true, transferId, earnedPoints }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[capture-payment]', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
