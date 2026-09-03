/**
 * Money as integer minor units with a currency tag.
 *
 * Two rules drive this module:
 *
 * 1. No floating point ever touches an amount. `0.1 + 0.2 !== 0.3`, and a
 *    payment system that rounds differently from the merchant produces
 *    unexplainable disputes. Amounts are integers in the currency's minor unit
 *    (paise for INR, cents for USD, yen for JPY which has no minor unit).
 * 2. Currency is part of the value, not context. Adding INR to USD is a type
 *    error at runtime rather than a silently wrong total.
 */

import { z } from 'zod';
import { CaptureLockError } from './errors.js';

/**
 * Supported currencies and their ISO-4217 minor-unit exponents.
 *
 * JPY is included deliberately: it has exponent 0, which catches any code that
 * assumes "minor units" always means "hundredths".
 */
export const CURRENCY_EXPONENTS = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AED: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export const CURRENCY_CODES = Object.keys(CURRENCY_EXPONENTS) as readonly CurrencyCode[];

export const CurrencyCodeSchema = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);

/**
 * Hard ceiling on any single amount, and on every arithmetic result.
 *
 * 1e13 minor units is 10,000 crore rupees. It is far above any legitimate
 * agentic transaction and far below Number.MAX_SAFE_INTEGER, so no sequence of
 * checked operations can silently lose precision.
 */
export const MAX_AMOUNT_MINOR = 10_000_000_000_000;

export interface Money {
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
}

export const MoneySchema = z
  .object({
    currency: CurrencyCodeSchema,
    amountMinor: z
      .number()
      .int('Amount must be an integer number of minor units')
      .min(-MAX_AMOUNT_MINOR)
      .max(MAX_AMOUNT_MINOR),
  })
  .strict();

export class CurrencyMismatchError extends CaptureLockError {
  constructor(left: CurrencyCode, right: CurrencyCode) {
    super('CURRENCY_MISMATCH', `Cannot combine ${left} with ${right}`, { left, right });
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyRangeError extends CaptureLockError {
  constructor(message: string, amountMinor: number) {
    super('MONEY_OVERFLOW', message, { amountMinor });
    this.name = 'MoneyRangeError';
  }
}

function checkAmount(amountMinor: number): number {
  if (!Number.isInteger(amountMinor)) {
    throw new CaptureLockError(
      'MONEY_NOT_INTEGER',
      'Amount must be an integer number of minor units',
      { amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0 },
    );
  }
  if (Object.is(amountMinor, -0)) return 0;
  if (Math.abs(amountMinor) > MAX_AMOUNT_MINOR) {
    throw new MoneyRangeError('Amount exceeds the supported range', amountMinor);
  }
  return amountMinor;
}

export function money(currency: CurrencyCode, amountMinor: number): Money {
  return Object.freeze({ currency, amountMinor: checkAmount(amountMinor) });
}

export function zero(currency: CurrencyCode): Money {
  return money(currency, 0);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.amountMinor + b.amountMinor);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.amountMinor - b.amountMinor);
}

/** Sums a list in a known currency. An empty list yields zero, never a guess at the currency. */
export function sum(currency: CurrencyCode, amounts: readonly Money[]): Money {
  let total = 0;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new CurrencyMismatchError(currency, amount.currency);
    }
    total += amount.amountMinor;
    checkAmount(total);
  }
  return money(currency, total);
}

/** Multiplies by a non-negative integer count (a quantity), never by a fraction. */
export function multiply(amount: Money, factor: number): Money {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new MoneyRangeError('Money may only be multiplied by a non-negative integer', factor);
  }
  return money(amount.currency, amount.amountMinor * factor);
}

/**
 * Applies a ratio expressed in integer basis points (1 bps = 0.01%).
 *
 * Rounding is truncation toward zero, applied once, on the integer minor unit.
 * This is documented rather than inferred because a policy ceiling that rounds
 * differently from the check that enforces it is a bypass.
 */
export function applyBasisPoints(amount: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyRangeError('Basis points must be a non-negative integer', basisPoints);
  }
  return money(amount.currency, Math.trunc((amount.amountMinor * basisPoints) / 10_000));
}

/** Returns -1, 0 or 1. Throws rather than comparing across currencies. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function isGreaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function isLessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function isAtMost(a: Money, b: Money): boolean {
  return compare(a, b) <= 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isNegative(amount: Money): boolean {
  return amount.amountMinor < 0;
}

export function absolute(amount: Money): Money {
  return money(amount.currency, Math.abs(amount.amountMinor));
}

/**
 * Human-readable rendering for evidence and logs only.
 *
 * Never parse this back; the canonical representation is the integer pair. The
 * output is locale-independent so it is stable across machines.
 */
export function format(amount: Money): string {
  const exponent = CURRENCY_EXPONENTS[amount.currency];
  const negative = amount.amountMinor < 0;
  const digits = Math.abs(amount.amountMinor)
    .toString()
    .padStart(exponent + 1, '0');
  const major = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const minor = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${amount.currency} ${major}${minor}`;
}
