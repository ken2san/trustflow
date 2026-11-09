// src/lib/trustpoints.js
// TrustPoints — a reputation reward token that is not awarded.
//
// NOTHING AWARDS OR SPENDS THESE. This header used to say "server-side awards
// happen in Supabase Edge Functions, which import the same TP_* constants" —
// those were `capture-payment` and `cancel-payment`, un-deployed on 2026-11-06
// and deleted in Task 20, so there is no server-side award path and this module
// has no caller but its own unit test. Codex's Task 20 review flagged that the
// header still described them.
//
// What the design WAS, since the constants only make sense with it: points
// earned through good behaviour and spent on platform benefits (fee discounts,
// priority arbitration, badge unlocks), never convertible to cash — airline
// miles, not money. None of it is built, and `trustpoints_ledger` has no
// writer (see HANDOFF.md for what that does and does not establish).
//
// The constants still come from supabase/functions/_shared/trustpointsRules.ts
// rather than being redeclared here. That file was the single source of truth
// so a value could not drift between what a server awarded and what the UI
// displayed as the rule; with no server side left, the reason to keep the
// import is narrower — one place to change if this is ever built, and the unit
// tests cover the pair.
// This file provides:
//   - TRUSTPOINTS_RULES: earn/spend configuration
//   - BADGES: badge definitions and unlock thresholds
//   - computeBalance(): compute balance from a ledger array
//   - getUnlockedBadges(): which badges a user has earned
//   - getNextBadge(): the next badge to earn

import {
  TP_CONTRACT_COMPLETED,
  TP_ON_TIME_BONUS,
  TP_CONTRACT_COMPLETED_HIRER,
  TP_CANCELLATION_PENALTY,
} from '../../supabase/functions/_shared/trustpointsRules.ts'

// ── Earn / Spend rules ──────────────────────────────────────────────────────

export const TRUSTPOINTS_RULES = {
  // Earning
  CONTRACT_COMPLETED:           { delta: TP_CONTRACT_COMPLETED,                    label: 'Contract completed' },
  CONTRACT_COMPLETED_ON_TIME:   { delta: TP_CONTRACT_COMPLETED + TP_ON_TIME_BONUS, label: 'Contract completed on time (+20 bonus)' },
  CONTRACT_COMPLETED_HIRER:     { delta: TP_CONTRACT_COMPLETED_HIRER,              label: 'Contract completed as Hirer' },
  DISPUTE_WON:                  { delta: +30,  label: 'Dispute resolved in your favor' },
  HIGH_RATING_RECEIVED:         { delta: +10,  label: 'Received 5-star rating' },
  FIRST_CONTRACT:               { delta: +100, label: 'First contract completed (one-time bonus)' },
  REFERRAL_JOINED:              { delta: +50,  label: 'Referred user completed their first contract' },

  // Spending (negative delta)
  FEE_DISCOUNT_1PCT:            { delta: -100, label: 'Platform fee −1% (one contract)' },
  PRIORITY_ARBITRATION:         { delta: -500, label: 'Priority dispute processing (48h → 24h)' },
  TRUST_PASSPORT_FEATURED:      { delta: -200, label: 'Featured badge on Trust Passport (30 days)' },

  // Penalties (negative delta, applied automatically)
  CONTRACT_CANCELLED:           { delta: TP_CANCELLATION_PENALTY, label: 'Contract cancelled' },
  DISPUTE_LOST:                 { delta: -50,  label: 'Dispute resolved against you' },
  GHOSTING_FLAG:                { delta: -80,  label: 'Flagged for ghosting' },
}

// ── Badges ──────────────────────────────────────────────────────────────────
// Badges are unlocked by cumulative TrustPoints (not by spending).
// Once unlocked they cannot be revoked by penalties.

export const BADGES = [
  {
    id: 'first_contract',
    label: 'First Contract',
    description: 'Completed your first TrustFlow contract',
    icon: '🏅',
    threshold: 50,       // cumulative earned points (ignores spending/penalties)
  },
  {
    id: 'reliable',
    label: 'Reliable',
    description: 'Earned 200+ TrustPoints through completed contracts',
    icon: '⚡',
    threshold: 200,
  },
  {
    id: 'trusted_node',
    label: 'Trusted Node',
    description: 'Earned 500+ TrustPoints — top-tier reputation',
    icon: '🛡',
    threshold: 500,
  },
  {
    id: 'elite',
    label: 'Elite',
    description: 'Earned 1000+ TrustPoints — platform legend',
    icon: '🌟',
    threshold: 1000,
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute current balance and lifetime earned from a ledger array.
 * @param {Array<{delta: number}>} ledger
 * @returns {{ balance: number, lifetimeEarned: number }}
 */
export function computeBalance(ledger) {
  let balance = 0
  let lifetimeEarned = 0
  for (const entry of ledger) {
    balance += entry.delta
    if (entry.delta > 0) lifetimeEarned += entry.delta
  }
  return { balance, lifetimeEarned }
}

/**
 * Which badges has a user unlocked based on lifetime earned points?
 * @param {number} lifetimeEarned
 * @returns {typeof BADGES}
 */
export function getUnlockedBadges(lifetimeEarned) {
  return BADGES.filter(b => lifetimeEarned >= b.threshold)
}

/**
 * The next badge a user is working toward.
 * @param {number} lifetimeEarned
 * @returns {{ badge: object, remaining: number } | null}
 */
export function getNextBadge(lifetimeEarned) {
  const next = BADGES.find(b => lifetimeEarned < b.threshold)
  if (!next) return null
  return { badge: next, remaining: next.threshold - lifetimeEarned }
}
