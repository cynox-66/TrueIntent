import { describe, it, expect } from 'vitest';
import {
  MAX_AMOUNT_MINOR,
  add,
  applyBasisPoints,
  compare,
  equals,
  format,
  isAtMost,
  isGreaterThan,
  money,
  multiply,
  subtract,
  sum,
  zero,
  CurrencyMismatchError,
  MoneyRangeError,
} from '../src/money.js';
import { canonicalize } from '../src/canonical.js';

describe('money construction', () => {
  it('accepts integer minor units', () => {
    expect(money('INR', 479900)).toEqual({ currency: 'INR', amountMinor: 479900 });
  });

  it('rejects fractional amounts rather than rounding them', () => {
    expect(() => money('INR', 4799.5)).toThrow(/integer/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => money('INR', NaN)).toThrow(/integer/);
    expect(() => money('INR', Infinity)).toThrow(/integer/);
  });

  it('normalizes negative zero to zero', () => {
    expect(money('INR', -0).amountMinor).toBe(0);
    expect(Object.is(money('INR', -0).amountMinor, -0)).toBe(false);
  });

  it('rejects amounts beyond the supported range', () => {
    expect(() => money('INR', MAX_AMOUNT_MINOR + 1)).toThrow(MoneyRangeError);
    expect(() => money('INR', -MAX_AMOUNT_MINOR - 1)).toThrow(MoneyRangeError);
  });

  it('produces frozen values so a verified amount cannot be mutated later', () => {
    const amount = money('INR', 100);
    expect(Object.isFrozen(amount)).toBe(true);
  });

  it('always yields a canonicalizable value', () => {
    expect(canonicalize(money('INR', 479900))).toBe('{"amountMinor":479900,"currency":"INR"}');
  });
});

describe('currency safety', () => {
  it('refuses to add across currencies', () => {
    expect(() => add(money('INR', 100), money('USD', 100))).toThrow(CurrencyMismatchError);
  });

  it('refuses to compare across currencies', () => {
    expect(() => compare(money('INR', 100), money('USD', 100))).toThrow(CurrencyMismatchError);
  });

  it('refuses to sum a list containing a foreign currency', () => {
    expect(() => sum('INR', [money('INR', 100), money('EUR', 100)])).toThrow(CurrencyMismatchError);
  });

  it('treats equality across currencies as false rather than throwing', () => {
    expect(equals(money('INR', 100), money('USD', 100))).toBe(false);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(money('INR', 450000), money('INR', 90000)).amountMinor).toBe(540000);
    expect(subtract(money('INR', 540000), money('INR', 90000)).amountMinor).toBe(450000);
  });

  it('sums an empty list to zero in the stated currency, never guessing', () => {
    expect(sum('INR', [])).toEqual({ currency: 'INR', amountMinor: 0 });
  });

  it('multiplies only by non-negative integers', () => {
    expect(multiply(money('INR', 479900), 2).amountMinor).toBe(959800);
    expect(multiply(money('INR', 479900), 0).amountMinor).toBe(0);
    expect(() => multiply(money('INR', 100), 1.5)).toThrow(/non-negative integer/);
    expect(() => multiply(money('INR', 100), -1)).toThrow(/non-negative integer/);
  });

  it('detects overflow on every intermediate step of a sum', () => {
    const big = money('INR', MAX_AMOUNT_MINOR);
    expect(() => sum('INR', [big, big])).toThrow(MoneyRangeError);
  });

  it('detects overflow on multiplication', () => {
    expect(() => multiply(money('INR', MAX_AMOUNT_MINOR), 2)).toThrow(MoneyRangeError);
  });

  it('never produces a non-integer, which the canonicalizer would reject', () => {
    const values = [1, 7, 33, 99, 4999, 100003];
    for (const a of values) {
      for (const b of values) {
        expect(Number.isInteger(add(money('INR', a), money('INR', b)).amountMinor)).toBe(true);
        expect(Number.isInteger(multiply(money('INR', a), b).amountMinor)).toBe(true);
        expect(Number.isInteger(applyBasisPoints(money('INR', a), b).amountMinor)).toBe(true);
      }
    }
  });
});

describe('applyBasisPoints', () => {
  it('computes integer basis points with truncation toward zero', () => {
    // 5% of 4,999.00 = 249.95 -> truncated to 249 minor units of the product
    expect(applyBasisPoints(money('INR', 499900), 500).amountMinor).toBe(24995);
    // 3.33% of 100 minor units = 3.33 -> 3
    expect(applyBasisPoints(money('INR', 100), 333).amountMinor).toBe(3);
  });

  it('is exact at 0 and 10000 basis points', () => {
    expect(applyBasisPoints(money('INR', 479900), 0).amountMinor).toBe(0);
    expect(applyBasisPoints(money('INR', 479900), 10_000).amountMinor).toBe(479900);
  });

  it('rejects fractional or negative basis points', () => {
    expect(() => applyBasisPoints(money('INR', 100), 1.5)).toThrow();
    expect(() => applyBasisPoints(money('INR', 100), -100)).toThrow();
  });
});

describe('comparison', () => {
  it('orders amounts correctly', () => {
    expect(isGreaterThan(money('INR', 500000), money('INR', 499900))).toBe(true);
    expect(isAtMost(money('INR', 499900), money('INR', 499900))).toBe(true);
    expect(isAtMost(money('INR', 500000), money('INR', 499900))).toBe(false);
  });

  it('treats the budget boundary as inclusive', () => {
    // "under 5,000" compiled as maxTotal = 500000 must allow exactly 500000.
    expect(isAtMost(money('INR', 500000), money('INR', 500000))).toBe(true);
  });
});

describe('format', () => {
  it('renders two-decimal currencies', () => {
    expect(format(money('INR', 479900))).toBe('INR 4799.00');
    expect(format(money('INR', 5))).toBe('INR 0.05');
    expect(format(money('INR', 0))).toBe('INR 0.00');
    expect(format(money('INR', -12345))).toBe('-INR 123.45');
  });

  it('renders zero-decimal currencies without a separator', () => {
    expect(format(money('JPY', 1500))).toBe('JPY 1500');
    expect(format(zero('JPY'))).toBe('JPY 0');
  });
});
