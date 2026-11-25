// supabase/functions/_shared/ownerReadResponse.ts
//
// The delegated owner read's 200 envelope (row 5b, docs/plans/row5-owner-read.md
// §5b), shaped from ONE authorized read_delegated_owner_deal result. Pure: no
// database, no clock. Everything here was materialized under the RPC's locks;
// nothing is looked up again.
//
// Three separate statements per event, never merged:
//   canonical_inputs_complete (from SQL): the projection withheld no canonical
//     input. Nothing about validity.
//   stored_format (here): what the stored canonical values classify as
//     (legacy / v5 / unsupported / invalid), from those values alone.
//   the receipt's verdict: only the offline verifier gives one.

import { classifyStoredEvent } from './eventVerifyV5.ts'
import { buildReceiptV2 } from './receiptV2.ts'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

export const OWNER_READ_SOURCE = {
  api: 'delegated-owner-read',
  issued_for_role: 'owner',
  authority: 'entry_agent_grant',
} as const

/**
 * When the accepted terms must stay out of the receipt even though its rows
 * might suggest otherwise: the deal's first acceptance lies past the prefix
 * (the prefix alone would look pre-acceptance), or the deal holds more than one
 * acceptance (the prefix may show only one). null: let the rows decide.
 */
export function acceptanceOverride(boundary: Row): { status: string } | null {
  if (Number(boundary.acceptance_count) > 1) return { status: 'multiple_acceptances' }
  const anchor = boundary.acceptance_anchor
  if (anchor && anchor.in_prefix !== true) return { status: 'outside_read_prefix' }
  return null
}

export async function shapeOwnerRead(result: Row): Promise<Row> {
  const boundary = result.read_boundary as Row
  const events = (result.events as Row[]).map(e => ({ ...e, stored_format: classifyStoredEvent(e).kind }))
  const receipt = events.length === 0 ? null : await buildReceiptV2({
    contract: result.contract,
    rows: result.events,
    read: { start: 'first_event', tail_complete: boundary.truncated === false, pages: 1, row_cap: boundary.cap_events },
    source: OWNER_READ_SOURCE,
    issuedAt: result.authorized_at,
    carriesIdempotencyKey: false,
    ...(acceptanceOverride(boundary) ? { accepted: acceptanceOverride(boundary) as { status: string } } : {}),
  })
  return { contract: result.contract, events, read_boundary: boundary, receipt }
}

/**
 * The whole encoded 200 body has an application budget of 2 MiB of UTF-8
 * (Codex T202). The SQL cap bounds only the projected event array; the
 * contract, both agreement snapshots and the receipt's acts come on top.
 * Serialized once: the measured text is the text sent.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function encodeOwnerRead(envelope: unknown): { text: string, bytes: number, over: boolean } {
  const text = JSON.stringify(envelope)
  const bytes = new TextEncoder().encode(text).length
  return { text, bytes, over: bytes > MAX_RESPONSE_BYTES }
}
