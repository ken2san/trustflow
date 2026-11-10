import { describe, it, expect } from 'vitest'
import { amountProblem } from '../../src/lib/amountInput.js'

describe('amountProblem', () => {
  it('refuses an empty amount, which the submit would otherwise send as 0', () => {
    expect(amountProblem('', 'JPY')).toMatch(/enter the amount/i)
    expect(amountProblem(undefined, 'JPY')).toMatch(/enter the amount/i)
    expect(amountProblem('   ', 'CAD')).toMatch(/enter the amount/i)
  })

  it('treats ideographic spaces, which a Japanese IME types, as empty', () => {
    expect(amountProblem('　　', 'JPY')).toMatch(/enter the amount/i)
  })

  it('refuses zero, which the database refuses as contracts_amount_minor_positive_check', () => {
    expect(amountProblem('0', 'JPY')).toMatch(/more than zero/i)
    expect(amountProblem('0.00', 'CAD')).toMatch(/more than zero/i)
  })

  it('accepts a whole JPY amount and a two-decimal CAD amount', () => {
    expect(amountProblem('1000', 'JPY')).toBeNull()
    expect(amountProblem(' 12.50 ', 'CAD')).toBeNull()
  })

  it('refuses decimals the currency does not have', () => {
    expect(amountProblem('12.5', 'JPY')).toMatch(/decimal places/i)
  })

  it('refuses symbols and separators', () => {
    expect(amountProblem('¥1,000', 'JPY')).toMatch(/digits/i)
  })
})
