import { describe, it, expect } from 'vitest'
import { dodItemsFrom, dodProblem } from '../../src/lib/dodInput.js'

describe('dodItemsFrom', () => {
  it('reads one item per line and drops blank lines and surrounding space', () => {
    expect(dodItemsFrom('  Logo files \n\n   \nBrand guide\n')).toEqual(['Logo files', 'Brand guide'])
  })

  it('treats a missing or whitespace-only field as no items', () => {
    expect(dodItemsFrom(undefined)).toEqual([])
    expect(dodItemsFrom('')).toEqual([])
    expect(dodItemsFrom(' \n\t\n ')).toEqual([])
  })

  it('drops a line of ideographic spaces, which a Japanese IME types', () => {
    expect(dodItemsFrom('　　\nロゴ')).toEqual(['ロゴ'])
  })
})

describe('dodProblem', () => {
  it('refuses no items, which is what the database refuses as contracts_dod_shape_check', () => {
    expect(dodProblem([])).toMatch(/at least one item/i)
    expect(dodProblem(dodItemsFrom('   \n  '))).toMatch(/at least one item/i)
  })

  it('accepts one item and fifty', () => {
    expect(dodProblem(['deploy check'])).toBeNull()
    expect(dodProblem(Array.from({ length: 50 }, (_, i) => `item ${i}`))).toBeNull()
  })

  it('refuses fifty-one, the database limit', () => {
    expect(dodProblem(Array.from({ length: 51 }, (_, i) => `item ${i}`))).toMatch(/at most 50/i)
  })

  it('is not stricter than the database on item length', () => {
    // agreementRules' unratified 1000-character item limit has no CHECK behind
    // it, so the form must not refuse what the record would accept.
    expect(dodProblem(['x'.repeat(1500)])).toBeNull()
  })
})
