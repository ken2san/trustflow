import { describe, it, expect } from 'vitest'
import { fetchAllEvents } from '../../scripts/lib/pagedEvents.mjs'

// The paged read (3C-CLI). Mocked pages only; no network.
const pager = (sizes, status = 200) => {
  const queries = []
  let call = 0
  const fetchPage = async (q) => {
    queries.push(q)
    const n = sizes[call++] ?? 0
    return { status, body: Array.from({ length: n }, (_, i) => ({ id: `${call}-${i}` })) }
  }
  return { fetchPage, queries }
}

describe('fetchAllEvents', () => {
  it('pages in order with explicit limit/offset until an empty page ends the read', async () => {
    const { fetchPage, queries } = pager([500, 500, 123, 0])
    const { rows, read } = await fetchAllEvents(fetchPage, 'c-1', 'id,type')
    expect(rows).toHaveLength(1123)
    expect(read).toEqual({ start: 'first_event', tail_complete: true, pages: 4, row_cap: 10000 })
    expect(queries[0]).toBe('events?contract_id=eq.c-1&select=id,type&order=created_at.asc,id.asc&limit=500&offset=0')
    expect(queries[2]).toContain('&offset=1000')
    expect(queries[3]).toContain('&offset=1123')
  })

  it('a short page is not the end: a server ceiling below the limit still reads the tail (Codex T174)', async () => {
    // PostgREST max-rows 100 under a 500-row request; the deal has 101 rows.
    const { fetchPage, queries } = pager([100, 1, 0])
    const { rows, read } = await fetchAllEvents(fetchPage, 'c', 'id')
    expect(rows).toHaveLength(101)
    expect(read.tail_complete).toBe(true)
    expect(queries[1]).toContain('&offset=100')
    expect(queries[2]).toContain('&offset=101')
  })

  it('a short page followed by a failed page is an error, never a complete prefix', async () => {
    let call = 0
    const fetchPage = async () => (call++ === 0
      ? { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: i })) }
      : { status: 500, body: null })
    await expect(fetchAllEvents(fetchPage, 'c', 'id')).rejects.toThrow(/refusing to treat a partial read/)
  })

  it('a page larger than the limit is refused', async () => {
    const { fetchPage } = pager([501])
    await expect(fetchAllEvents(fetchPage, 'c', 'id')).rejects.toThrow(/refusing an unbounded page/)
  })

  it('an empty first page is a complete, empty read', async () => {
    const { fetchPage } = pager([0])
    expect((await fetchAllEvents(fetchPage, 'c', 'id')).read).toMatchObject({ tail_complete: true, pages: 1 })
  })

  it('stopping at the row cap is never called complete, even on an exact boundary', async () => {
    const { fetchPage, queries } = pager([4, 4, 2])
    const { rows, read } = await fetchAllEvents(fetchPage, 'c', 'id', { pageSize: 4, rowCap: 10 })
    expect(rows).toHaveLength(10)
    expect(read.tail_complete).toBe(false)
    expect(queries[2]).toContain('&limit=2&offset=8')
  })

  it('a failed page is an error, not a short read', async () => {
    const { fetchPage } = pager([10], 500)
    await expect(fetchAllEvents(fetchPage, 'c', 'id')).rejects.toThrow(/refusing to treat a partial read/)
  })
})
