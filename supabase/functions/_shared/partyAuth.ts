// supabase/functions/_shared/partyAuth.ts
//
// Authorizes a caller against an already-loaded contract row as either the
// registered Earner/Hirer (Supabase Auth JWT) or the guest Hirer
// (guest_access_token, issued by validate-invite-token's accept step).
// A guest Hirer is not required to register an account for this MVP — the
// guest_access_token path is the primary way a Hirer authorizes anything.

// Exact version, matching the four functions that bundle this file and the web
// client's lockfile. A floating `@2` let esm.sh pick a different library at
// each deploy, underneath an authorization check.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.99.1'

export type PartyRole = 'earner' | 'hirer'

export interface AuthorizedParty {
  role: PartyRole
  userId: string | null // null for a guest — no Supabase Auth account
}

export interface PartyContract {
  earner_user_id: string
  hirer_user_id: string | null
  guest_access_token: string | null
  guest_access_token_expires_at: string | null
}

export async function authorizeParty(
  req: Request,
  supabase: SupabaseClient,
  contract: PartyContract,
): Promise<AuthorizedParty | null> {
  const authHeader = req.headers.get('Authorization')
  if (authHeader) {
    const jwt = authHeader.replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(jwt)
    if (user) {
      if (user.id === contract.earner_user_id) return { role: 'earner', userId: user.id }
      if (user.id === contract.hirer_user_id) return { role: 'hirer', userId: user.id }
    }
  }

  const guestToken = req.headers.get('X-Guest-Access-Token')
  if (guestToken && contract.guest_access_token && guestToken === contract.guest_access_token) {
    const notExpired = !contract.guest_access_token_expires_at
      || new Date(contract.guest_access_token_expires_at) > new Date()
    if (notExpired) return { role: 'hirer', userId: null }
  }

  return null
}
