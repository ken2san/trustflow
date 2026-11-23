// Read one deal's whole event chain in explicit, ordered pages, and say what
// the read can prove about its own completeness (row 3, 3C-CLI).
//
// WHY PAGED
// A single PostgREST request is silently capped by the project's max-rows
// setting. A verifier that read one capped page and reported "verified" would
// be verifying a prefix while calling it the chain. So the read pages until a
// successful EMPTY page ends it, and it reports `tail_complete: false` — never
// complete — if it stops at its own row cap first.
//
// WHY A SHORT PAGE IS NOT THE END (Codex T174)
// A page shorter than the requested limit proves nothing: a server row ceiling
// below `limit` (say PostgREST max-rows 100 under a 500-row request) returns a
// short page with a tail behind it. So the offset advances by the rows actually
// returned, and only an empty page — the server saying there is nothing at
// that offset — ends the read as complete. It costs one extra request.
//
// WHY OFFSET PAGING IS SAFE HERE
// Evidence is append-only, and a deal's created_at is enforced monotonic by the
// database, so a row inserted during the read can only appear at the tail. The
// order (created_at, id) is the one the writers build the chain in.

export const PAGE_SIZE = 500
export const ROW_CAP = 10_000

/**
 * @param {(query: string) => Promise<{ status: number, body: unknown }>} fetchPage
 *   Runs one `events?...` query and returns the PostgREST response.
 * @returns {Promise<{ rows: object[], read: { start: 'first_event', tail_complete: boolean, pages: number, row_cap: number } }>}
 */
export async function fetchAllEvents(fetchPage, contractId, columns, { pageSize = PAGE_SIZE, rowCap = ROW_CAP } = {}) {
  const rows = []
  let pages = 0
  let tailComplete = false
  while (rows.length < rowCap) {
    const limit = Math.min(pageSize, rowCap - rows.length)
    const query = `events?contract_id=eq.${encodeURIComponent(contractId)}`
      + `&select=${columns}&order=created_at.asc,id.asc&limit=${limit}&offset=${rows.length}`
    const r = await fetchPage(query)
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) {
      throw new Error(`events read failed (HTTP ${r.status}); refusing to treat a partial read as the chain`)
    }
    if (r.body.length > limit) {
      throw new Error(`events read returned ${r.body.length} rows for a limit of ${limit}; refusing an unbounded page`)
    }
    pages += 1
    if (r.body.length === 0) { tailComplete = true; break }
    rows.push(...r.body)
  }
  // Reaching the cap exactly is not proof of the end: the next page might exist.
  return { rows, read: { start: 'first_event', tail_complete: tailComplete, pages, row_cap: rowCap } }
}
