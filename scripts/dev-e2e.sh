#!/usr/bin/env bash
# Run the dev server against trustflow-e2e instead of production, without
# touching .env. Vite prefers real environment variables over .env file
# values, so exporting these here is enough to redirect the running app —
# .env itself, and a plain `npm run dev` afterward, are untouched.
#
# Why this exists: manual click-through testing needs a real browser session
# against a database that is safe to create and fully accept contracts in.
# Production is not that (see HANDOFF.md's "do not delete production's
# existing test data" — every contract accepted there is permanent).
# trustflow-e2e was built for exactly this and already has anonymous
# sign-ins on, all migrations applied, and its own credentials in .env.e2e.
#
# Note: trustflow-e2e does not have Custom SMTP configured (production does,
# as of 2026-09-27) — it's still on Supabase's default mailer. This is rarely
# a problem in practice: accepting an invite needs no OTP at all (the guest
# side just claims an email, no verification round trip), so the only email
# this flow sends is the operator's own "Your email" confirmation, once.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.e2e ]; then
  echo "error: .env.e2e not found. See docs/e2e-project.md for what it needs." >&2
  exit 1
fi

export VITE_SUPABASE_URL="$(grep '^VITE_SUPABASE_URL=' .env.e2e | cut -d= -f2-)"
export VITE_SUPABASE_ANON_KEY="$(grep '^VITE_SUPABASE_ANON_KEY=' .env.e2e | cut -d= -f2-)"

if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_ANON_KEY" ]; then
  echo "error: VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing from .env.e2e" >&2
  exit 1
fi

echo "Starting dev server against trustflow-e2e ($VITE_SUPABASE_URL)"
echo "(.env / production is untouched — a plain 'npm run dev' goes back to it)"
exec npm run dev
