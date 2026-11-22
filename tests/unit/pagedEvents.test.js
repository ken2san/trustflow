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
  it('pages in order with explicit limit/offset until a short page ends the read', async () => {
    const { fetchPage, queries } = pager([500, 500, 123])
    const { rows, read } = await fetchAllEvents(fetchPage, 'c-1', 'id,type')
    expect(rows).toHaveLength(1123)
    expect(read).toEqual({ start: 'first_event', tail_complete: true, pages: 3, row_cap: 10000 })
    expect(queries[0]).toBe('events?contract_id=eq.c-1&select=id,type&order=created_at.asc,id.asc&limit=500&offset=0')
    expect(queries[2]).toContain('&offset=1000')
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
