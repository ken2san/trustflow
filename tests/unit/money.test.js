import { describe, it, expect } from 'vitest'
import {
  SUPPORTED_CURRENCIES, CURRENCY_MINOR_DIGITS, DEFAULT_CURRENCY, AMOUNT_MINOR_MAX,
  isSupportedCurrency, minorDigitsOf, minorUnitsFrom, majorStringFrom, formatMinor,
} from '../../supabase/functions/_shared/money.ts'

// WHY THESE TESTS EXIST
// The amount is hashed into every event of a chain, permanently. A rounding
// artefact in this parser is not a display bug that can be fixed later — it is
// a wrong number in evidence that will still verify as untampered. So the
// cases below are the ones that produce a WRONG ANSWER rather than an error:
// the float path (1.005 * 100 is 100.49999999999999), a 2-decimal amount typed
// into a currency that has none, and a cent amount read as yen.

const ok = (input, currency) => {
  const r = minorUnitsFrom(input, currency)
  expect(r.ok, `${currency} ${JSON.stringify(input)} was rejected: ${r.reason}`).toBe(true)
  return r.minor
}
const no = (input, currency) => {
  const r = minorUnitsFrom(input, currency)
  expect(r.ok, `${currency} ${JSON.stringify(input)} was accepted`).toBe(false)
  return r.reason
}

describe('the list of currencies', () => {
  it('is the six ISO 4217 codes, JPY first and default', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['JPY', 'CAD', 'HKD', 'USD', 'EUR', 'GBP'])
    expect(DEFAULT_CURRENCY).toBe('JPY')
  })

  it('states each currency\'s minor-unit exponent', () => {
    expect(CURRENCY_MINOR_DIGITS).toEqual({
      JPY: 0, CAD: 2, HKD: 2, USD: 2, EUR: 2, GBP: 2,
    })
    // Every listed currency has an answer, and nothing else does.
    for (const code of SUPPORTED_CURRENCIES) expect(minorDigitsOf(code)).not.toBeNull()
    expect(minorDigitsOf('CHF')).toBeNull()
    expect(minorDigitsOf(null)).toBeNull()
    expect(isSupportedCurrency('jpy')).toBe(false)
  })
})

describe('a typed amount becomes minor units', () => {
  it('reads a 2-decimal currency as cents', () => {
    expect(ok('12.50', 'CAD')).toBe(1250)
    expect(ok('12.5', 'CAD')).toBe(1250)
    expect(ok('12', 'CAD')).toBe(1200)
    expect(ok('0.01', 'CAD')).toBe(1)
    expect(ok('1250.00', 'HKD')).toBe(125000)
  })

  it('reads JPY as whole yen', () => {
    expect(ok('1250', 'JPY')).toBe(1250)
    expect(ok('300000', 'JPY')).toBe(300000)
    // A trailing zero after the point is still a whole number of yen.
    expect(ok('1250.0', 'JPY')).toBe(1250)
  })

  it('refuses a precision the currency does not have', () => {
    // The case from the brief: JPY has no minor unit in circulation, so this
    // is not an amount anyone can pay. Rounding it would record a deal that
    // differs from the one typed.
    expect(no('12.5', 'JPY')).toBe('amount_too_precise')
    expect(no('12.555', 'CAD')).toBe('amount_too_precise')
    expect(no('0.001', 'USD')).toBe('amount_too_precise')
  })

  it('never reaches the float path that rounds the wrong way', () => {
    // parseFloat('1.005') * 100 is 100.49999999999999, so a float
    // implementation stores 100 cents for an amount typed as 1.005 — and
    // 1.005 is a value a person really types. Here it is refused outright,
    // and the neighbouring payable values are exact.
    expect(no('1.005', 'CAD')).toBe('amount_too_precise')
    expect(ok('1.00', 'CAD')).toBe(100)
    expect(ok('1.01', 'CAD')).toBe(101)
    // 8.165 and 0.615 are the other classic float-representation cases.
    expect(no('8.165', 'USD')).toBe('amount_too_precise')
    expect(ok('8.16', 'USD')).toBe(816)
    // Exactness across the whole range of cents, which a *100 would not give.
    for (let cents = 1; cents <= 1000; cents++) {
      const typed = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
      expect(minorUnitsFrom(typed, 'CAD')).toEqual({ ok: true, minor: cents })
    }
  })

  it('rejects what is not a plain decimal rather than guessing', () => {
    // '1,250' is one thousand two hundred fifty in Canada and a syntax error
    // in a French locale; reading it as 1250 in a form someone may have typed
    // '1.250' into is how a 1000x error gets hashed.
    expect(no('1,250', 'CAD')).toBe('amount_malformed')
    expect(no('¥300000', 'JPY')).toBe('amount_malformed')
    expect(no('12.50 CAD', 'CAD')).toBe('amount_malformed')
    expect(no('-5', 'CAD')).toBe('amount_malformed')
    expect(no('', 'CAD')).toBe('amount_malformed')
    expect(no('   ', 'CAD')).toBe('amount_malformed')
    expect(no('abc', 'CAD')).toBe('amount_malformed')
    expect(no(null, 'CAD')).toBe('amount_malformed')
    expect(no(undefined, 'CAD')).toBe('amount_malformed')
    expect(no(NaN, 'CAD')).toBe('amount_malformed')
    // Surrounding whitespace is a typing artefact, not a malformed amount.
    expect(ok('  12.50  ', 'CAD')).toBe(1250)
  })

  it('refuses zero and anything past the integer column', () => {
    expect(no('0', 'JPY')).toBe('amount_not_positive')
    expect(no('0.00', 'CAD')).toBe('amount_not_positive')
    expect(ok(String(AMOUNT_MINOR_MAX), 'JPY')).toBe(AMOUNT_MINOR_MAX)
    expect(no(String(AMOUNT_MINOR_MAX + 1), 'JPY')).toBe('amount_too_large')
    // The ceiling in major units for a 2-decimal currency: CA$21,474,836.47.
    expect(ok('21474836.47', 'CAD')).toBe(AMOUNT_MINOR_MAX)
    expect(no('21474836.48', 'CAD')).toBe('amount_too_large')
    expect(no('9'.repeat(40), 'JPY')).toBe('amount_too_large')
    expect(no(1e21, 'JPY')).toBe('amount_too_large')
  })

  it('refuses an unsupported currency before looking at the amount', () => {
    // Order matters: without the currency there is no precision rule to apply,
    // so reporting the amount as malformed would misdirect the caller.
    expect(no('12.50', 'CHF')).toBe('currency_unsupported')
    expect(no('nonsense', 'CHF')).toBe('currency_unsupported')
    expect(no('12.50', null)).toBe('currency_unsupported')
  })

  it('accepts a number as well as the string a field holds', () => {
    expect(ok(1250, 'JPY')).toBe(1250)
    expect(ok(12.5, 'CAD')).toBe(1250)
    expect(no(12.5, 'JPY')).toBe('amount_too_precise')
    expect(no(Infinity, 'CAD')).toBe('amount_malformed')
  })
})

describe('minor units go back the way they came', () => {
  it('round-trips through the form field', () => {
    for (const [currency, typed] of [['JPY', '300000'], ['CAD', '12.50'], ['GBP', '0.01']]) {
      const minor = ok(typed, currency)
      expect(majorStringFrom(minor, currency)).toBe(typed)
    }
    expect(majorStringFrom(1250, 'CAD')).toBe('12.50')
    expect(majorStringFrom(5, 'CAD')).toBe('0.05')
    expect(majorStringFrom(1250, 'JPY')).toBe('1250')
    expect(majorStringFrom(null, 'CAD')).toBe('')
    expect(majorStringFrom(1250, 'CHF')).toBe('')
  })
})

describe('an amount on screen', () => {
  it('uses the currency\'s own symbol and decimals', () => {
    expect(formatMinor(63500, 'JPY', 'en-US')).toBe('¥63,500')
    expect(formatMinor(1250, 'CAD', 'en-US')).toBe('CA$12.50')
    expect(formatMinor(1250, 'USD', 'en-US')).toBe('$12.50')
    // The defect this replaces: maximumFractionDigits: 0 for every currency
    // showed CA$12.50 as CA$13 — and the same integer read as yen would have
    // been ¥1,250, a hundredfold error in the other direction.
    expect(formatMinor(1250, 'CAD', 'en-US')).not.toBe('CA$13')
    expect(formatMinor(1250, 'CAD', 'en-US')).not.toBe('CA$1,250.00')
  })

  it('keeps the trailing zeros a money amount is written with', () => {
    expect(formatMinor(1200, 'CAD', 'en-US')).toBe('CA$12.00')
    expect(formatMinor(1, 'EUR', 'en-US')).toBe('€0.01')
  })

  it('degrades rather than throwing on something it does not know', () => {
    // A display helper that throws takes a screen down over a currency code.
    expect(formatMinor(1250, 'CHF')).toBe('1250 CHF')
    expect(formatMinor(null, 'JPY')).toBe('—')
    expect(formatMinor(undefined, 'JPY')).toBe('—')
  })
})
