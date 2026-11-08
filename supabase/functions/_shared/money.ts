// supabase/functions/_shared/money.ts
//
// The one definition of which currencies exist, how many minor units each has,
// and how a typed amount becomes the integer that gets stored and hashed.
//
// WHY THIS FILE EXISTS
// TrustFlow was JPY-only: the column was literally `amount_jpy`, the DB CHECK
// said `currency = 'JPY'`, and the validation list in agreementRules.ts said
// the same. Kenji transacts in Canada, Hong Kong and Japan, so that is now
// wrong for real use (2026-11-08). Three places had to learn about currency —
// the browser form, the Edge Functions, and the database — and the one
// production bug this project's hash chain has ever had came from two
// implementations of a rule drifting apart. So the list lives here, once, and
// `agreementRules.SUPPORTED_CURRENCIES` and the DB CHECK are both derived from
// it (the DB copy by hand, in a migration, with this file named in its header).
//
// MINOR UNITS, AND WHY NOTHING HERE TOUCHES A FLOAT
// The stored amount is an INTEGER in the currency's minor unit: yen for JPY
// (0 decimals), cents for the rest (2). A money value parsed through
// `parseFloat` and multiplied by 100 is wrong for values a user will really
// type — 1.005 * 100 is 100.49999999999999 — and an amount is hashed into
// every event of a chain forever, so a rounding artefact is permanent. The
// parser below therefore reads the decimal string digit by digit and never
// performs floating-point arithmetic on the input.
//
// NO FX, ANYWHERE
// There is no conversion in this file and there must not be one. An amount is
// only ever compared with, or displayed alongside, its own currency. A rate
// would have to be sourced, dated, and hashed to mean anything in evidence,
// and none of that is decided.

/**
 * Every currency a contract may be denominated in, ISO 4217.
 *
 * Append-only. Removing one would retroactively invalidate agreements already
 * recorded in it, and a row that no longer satisfies the DB CHECK cannot be
 * read back through a path that re-validates. Adding one is a migration plus a
 * line here.
 */
export const SUPPORTED_CURRENCIES = ['JPY', 'CAD', 'HKD', 'USD', 'EUR', 'GBP'] as const

export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number]

/**
 * How many decimal places each currency has, i.e. how many minor units make a
 * major one. These are ISO 4217 exponents, not a preference: JPY genuinely has
 * no minor unit in circulation, so "12.5 yen" is not an amount anyone can pay.
 */
export const CURRENCY_MINOR_DIGITS: Record<SupportedCurrency, number> = {
  JPY: 0,
  CAD: 2,
  HKD: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
}

/** What a form starts on, and what every pre-2026-11 contract is. */
export const DEFAULT_CURRENCY: SupportedCurrency = 'JPY'

/**
 * The ceiling is the column's, not a policy.
 *
 * `amount_minor` is `integer`, so 2,147,483,647 is the largest value that can
 * be stored at all. It matters more than it used to: a 2-decimal currency
 * multiplies the typed number by 100, so the largest CAD amount is about
 * 21.47 million dollars rather than 2.1 billion. Rejecting it here with a
 * named reason beats a Postgres range error with none.
 *
 * Whether there should be a *business* ceiling is still UNDECIDED — see
 * AMOUNT_CEILING in agreementRules.ts.
 */
export const AMOUNT_MINOR_MAX = 2_147_483_647

export function isSupportedCurrency(value: unknown): value is SupportedCurrency {
  return typeof value === 'string'
    && (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
}

/** Decimal places for a currency, or null if we do not support it. */
export function minorDigitsOf(currency: unknown): number | null {
  return isSupportedCurrency(currency) ? CURRENCY_MINOR_DIGITS[currency] : null
}

/** Why a typed amount could not become minor units. Stable strings: an API. */
export type AmountRejection =
  | 'currency_unsupported'
  | 'amount_malformed'
  | 'amount_too_precise'
  | 'amount_not_positive'
  | 'amount_too_large'

export type MinorUnitsResult =
  | { ok: true, minor: number }
  | { ok: false, reason: AmountRejection }

/** Digits, with an optional decimal point. No sign, no separators, no exponent. */
const DECIMAL_SHAPE = /^(\d+)(?:\.(\d*))?$/

/**
 * A typed amount as an integer number of minor units.
 *
 * Accepts the string a text input produces, or a number (converted through its
 * own decimal form, never multiplied). Rejects thousands separators rather
 * than guessing: "1,250" means one thousand two hundred fifty in Canada and
 * is a syntax error in a French locale, and silently reading it as 1250 in a
 * form the user may have typed "1.250" into is how a 1000x error gets hashed.
 *
 * Trailing zeros past the currency's precision are fine — "12.50" is a normal
 * way to write a CAD amount, and "12.500" still names a payable one. A
 * non-zero digit past it is not: "12.555" CAD and "12.5" JPY are amounts
 * nobody can pay, and rounding them here would mean recording a deal nobody
 * agreed to.
 */
export function minorUnitsFrom(input: unknown, currency: unknown): MinorUnitsResult {
  const digits = minorDigitsOf(currency)
  if (digits === null) return { ok: false, reason: 'currency_unsupported' }

  let text: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'amount_malformed' }
    text = String(input)
    // 1e21 and up stringify in exponent form, which DECIMAL_SHAPE rejects —
    // and which is far past the column anyway.
    if (text.includes('e') || text.includes('E')) return { ok: false, reason: 'amount_too_large' }
  } else if (typeof input === 'string') {
    text = input.trim()
  } else {
    return { ok: false, reason: 'amount_malformed' }
  }

  if (text.length === 0) return { ok: false, reason: 'amount_malformed' }

  const match = DECIMAL_SHAPE.exec(text)
  if (!match) return { ok: false, reason: 'amount_malformed' }

  const whole = match[1]
  // Trailing zeros carry no value, so they cannot make an amount too precise.
  const frac = (match[2] ?? '').replace(/0+$/, '')
  if (frac.length > digits) return { ok: false, reason: 'amount_too_precise' }

  const minorText = whole + frac.padEnd(digits, '0')
  // Length first: a 40-digit string is past Number.MAX_SAFE_INTEGER, where the
  // comparison below would be performed on a value that is already wrong.
  if (minorText.length > 19) return { ok: false, reason: 'amount_too_large' }

  const minor = Number(minorText)
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'amount_too_large' }
  if (minor <= 0) return { ok: false, reason: 'amount_not_positive' }
  if (minor > AMOUNT_MINOR_MAX) return { ok: false, reason: 'amount_too_large' }

  return { ok: true, minor }
}

/**
 * Minor units back as the plain decimal string a form field holds.
 * Not for display — this is the inverse of the parser, so that editing an
 * existing amount starts from exactly what was stored.
 */
export function majorStringFrom(minor: unknown, currency: unknown): string {
  const digits = minorDigitsOf(currency)
  if (digits === null || typeof minor !== 'number' || !Number.isInteger(minor)) return ''
  if (digits === 0) return String(minor)
  const sign = minor < 0 ? '-' : ''
  const text = String(Math.abs(minor)).padStart(digits + 1, '0')
  return `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`
}

/**
 * An amount as a reader of that currency expects to see it.
 *
 * The fraction digits are the currency's own, stated explicitly in both
 * directions. Intl.NumberFormat already knows them, but GuestEvidenceView used
 * to pass `maximumFractionDigits: 0` for every currency, which turned a CAD
 * amount into a rounded whole number on the one screen whose entire job is to
 * show what was agreed. Pinning both bounds makes that failure impossible to
 * reintroduce by passing the wrong one.
 *
 * Falls back to "<amount> <CODE>" rather than throwing: a display helper that
 * can throw takes a screen down over a currency code, and an unformatted
 * amount is still a readable one.
 */
export function formatMinor(minor: unknown, currency: unknown, locale?: string): string {
  const digits = minorDigitsOf(currency)
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—'
  if (digits === null) return `${minor} ${typeof currency === 'string' ? currency : ''}`.trim()
  const major = digits === 0 ? minor : minor / 10 ** digits
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency as string,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major)
  } catch {
    return `${major.toFixed(digits)} ${currency as string}`
  }
}
