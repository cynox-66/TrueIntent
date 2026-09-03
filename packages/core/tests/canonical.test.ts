import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  hash,
  hashBytes,
  asSha256Hex,
  isSha256Hex,
  HASH_DOMAINS,
} from '../src/canonical.js';
import { CanonicalizationError } from '../src/errors.js';

describe('canonicalize', () => {
  describe('key ordering invariance', () => {
    it('produces identical output regardless of key insertion order', () => {
      const a = { zebra: 1, apple: 2, mango: 3 };
      const b = { mango: 3, apple: 2, zebra: 1 };
      const c = { apple: 2, zebra: 1, mango: 3 };
      expect(canonicalize(a)).toBe('{"apple":2,"mango":3,"zebra":1}');
      expect(canonicalize(b)).toBe(canonicalize(a));
      expect(canonicalize(c)).toBe(canonicalize(a));
    });

    it('sorts nested object keys at every depth', () => {
      const value = { b: { z: 1, a: 2 }, a: { y: 3, b: 4 } };
      expect(canonicalize(value)).toBe('{"a":{"b":4,"y":3},"b":{"a":2,"z":1}}');
    });

    it('sorts by code unit, which for ASCII identifiers is byte order', () => {
      // Uppercase letters sort before lowercase in ASCII/UTF-16.
      expect(canonicalize({ a: 1, A: 2, Z: 3, z: 4 })).toBe('{"A":2,"Z":3,"a":1,"z":4}');
    });
  });

  describe('array handling', () => {
    it('preserves array order (order is semantic)', () => {
      expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
      expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    });

    it('handles empty arrays and objects', () => {
      expect(canonicalize([])).toBe('[]');
      expect(canonicalize({})).toBe('{}');
      expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
    });

    it('rejects sparse array holes so a sparse array cannot impersonate a dense one', () => {
      // Built with `new Array` rather than an elided literal so the lint rule
      // that (rightly) bans sparse literals does not have to be disabled.
      const sparse: unknown[] = new Array<unknown>(3);
      sparse[0] = 1;
      sparse[2] = 3;
      expect(() => canonicalize(sparse)).toThrow(CanonicalizationError);
    });
  });

  describe('number restrictions', () => {
    it('accepts safe integers including negatives and zero', () => {
      expect(canonicalize(0)).toBe('0');
      expect(canonicalize(-1)).toBe('-1');
      expect(canonicalize(499900)).toBe('499900');
      expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
      expect(canonicalize(Number.MIN_SAFE_INTEGER)).toBe('-9007199254740991');
    });

    it('rejects fractional numbers (money must be integer minor units)', () => {
      expect(() => canonicalize(49.99)).toThrow(/safe integers/);
      expect(() => canonicalize({ price: 0.1 })).toThrow(/safe integers/);
    });

    it('rejects NaN and infinities', () => {
      expect(() => canonicalize(NaN)).toThrow(/Non-finite/);
      expect(() => canonicalize(Infinity)).toThrow(/Non-finite/);
      expect(() => canonicalize(-Infinity)).toThrow(/Non-finite/);
    });

    it('rejects negative zero, which String() would silently normalize to "0"', () => {
      expect(() => canonicalize(-0)).toThrow(/Negative zero/);
    });

    it('rejects integers beyond the safe range where precision is already lost', () => {
      expect(() => canonicalize(2 ** 53)).toThrow(/safe integers/);
    });
  });

  describe('undefined and null', () => {
    it('rejects undefined anywhere, since only null may express absence', () => {
      expect(() => canonicalize(undefined)).toThrow(/undefined/);
      expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
      expect(() => canonicalize([undefined])).toThrow(/undefined/);
      expect(() => canonicalize({ a: { b: undefined } })).toThrow(/undefined/);
    });

    it('distinguishes an explicit null from a missing key', () => {
      expect(canonicalize({ a: null })).toBe('{"a":null}');
      expect(canonicalize({})).toBe('{}');
      expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
    });
  });

  describe('string handling', () => {
    it('escapes per RFC 8785 (minimal escapes, short forms for controls)', () => {
      expect(canonicalize('a"b')).toBe('"a\\"b"');
      expect(canonicalize('a\\b')).toBe('"a\\\\b"');
      expect(canonicalize('a\nb')).toBe('"a\\nb"');
      expect(canonicalize('a\tb')).toBe('"a\\tb"');
      expect(canonicalize('')).toBe('"\\u0001"');
    });

    it('does not escape non-ASCII characters', () => {
      expect(canonicalize('₹')).toBe('"₹"');
      expect(canonicalize('日本語')).toBe('"日本語"');
    });

    it('accepts valid surrogate pairs', () => {
      expect(canonicalize('\u{1f600}')).toBe('"\u{1f600}"');
    });

    it('rejects lone surrogates, which have no valid UTF-8 encoding', () => {
      expect(() => canonicalize('\ud800')).toThrow(/lone high surrogate/);
      expect(() => canonicalize('\udc00')).toThrow(/lone low surrogate/);
      expect(() => canonicalize('a\ud800b')).toThrow(/lone high surrogate/);
    });

    it('does NOT Unicode-normalize: NFC-distinct strings hash differently by design', () => {
      const composed = 'é'; // e-acute, precomposed
      const decomposed = 'é'; // e + combining acute
      expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
      expect(canonicalize(composed)).not.toBe(canonicalize(decomposed));
    });
  });

  describe('key restrictions', () => {
    it('rejects keys that are not ASCII identifiers', () => {
      expect(() => canonicalize({ 'has-dash': 1 })).toThrow(/ASCII identifier/);
      expect(() => canonicalize({ 'has space': 1 })).toThrow(/ASCII identifier/);
      expect(() => canonicalize({ '1leading': 1 })).toThrow(/ASCII identifier/);
      expect(() => canonicalize({ '': 1 })).toThrow(/ASCII identifier/);
      expect(() => canonicalize({ ключ: 1 })).toThrow(/ASCII identifier/);
    });

    it('rejects __proto__ as a key by construction (a key must start with a letter)', () => {
      const polluted: unknown = JSON.parse('{"__proto__": {"isAdmin": true}}');
      expect(() => canonicalize(polluted)).toThrow(/ASCII identifier/);
    });
  });

  describe('type restrictions', () => {
    it('rejects Date, Map, Set and class instances', () => {
      expect(() => canonicalize(new Date(0))).toThrow(/plain objects/);
      expect(() => canonicalize(new Map())).toThrow(/plain objects/);
      expect(() => canonicalize(new Set())).toThrow(/plain objects/);
      class Thing {
        public a = 1;
      }
      expect(() => canonicalize(new Thing())).toThrow(/plain objects/);
    });

    it('accepts null-prototype objects', () => {
      const value = Object.create(null) as Record<string, unknown>;
      value['a'] = 1;
      expect(canonicalize(value)).toBe('{"a":1}');
    });

    it('rejects bigint, symbol and function', () => {
      expect(() => canonicalize(1n)).toThrow(/bigint/);
      expect(() => canonicalize(Symbol('x'))).toThrow(/symbol/);
      expect(() => canonicalize(() => 1)).toThrow(/function/);
    });

    it('rejects symbol-keyed properties', () => {
      const value: Record<string, unknown> = { a: 1 };
      (value as Record<symbol, unknown>)[Symbol('hidden')] = 2;
      expect(() => canonicalize(value)).toThrow(/Symbol-keyed/);
    });
  });

  describe('resource bounds on untrusted input', () => {
    it('rejects structures nested beyond the depth limit', () => {
      let deep: unknown = 1;
      for (let i = 0; i < 40; i += 1) deep = { a: deep };
      expect(() => canonicalize(deep)).toThrow(/nested deeper/);
    });

    it('rejects structures with too many nodes', () => {
      const big = Array.from({ length: 25_000 }, (_, i) => i);
      expect(() => canonicalize(big)).toThrow(/exceeds/);
    });

    it('rejects circular references instead of overflowing the stack', () => {
      const a: Record<string, unknown> = {};
      a['self'] = a;
      expect(() => canonicalize(a)).toThrow(/Circular/);
    });

    it('allows the same object to appear twice in a tree (not a cycle)', () => {
      const shared = { a: 1 };
      expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    });
  });

  describe('golden vectors', () => {
    // Committed so the algorithm cannot drift silently. Changing any of these
    // invalidates every previously issued hash and must be a versioned change.
    const vectors: ReadonlyArray<readonly [unknown, string]> = [
      [{}, '{}'],
      [[], '[]'],
      [null, 'null'],
      [true, 'true'],
      [0, '0'],
      ['', '""'],
      [{ a: 1, b: [1, 2, 3], c: { d: null } }, '{"a":1,"b":[1,2,3],"c":{"d":null}}'],
      [
        { currency: 'INR', amountMinor: 479900, sku: 'SKU_BLK_RUN_42' },
        '{"amountMinor":479900,"currency":"INR","sku":"SKU_BLK_RUN_42"}',
      ],
      [[{ b: 2, a: 1 }], '[{"a":1,"b":2}]'],
    ];

    it.each(vectors)('canonicalizes to the committed form', (input, expected) => {
      expect(canonicalize(input)).toBe(expected);
    });
  });
});

describe('hash', () => {
  it('is stable across key orderings', () => {
    const a = hash('capturelock.v1.cart', { zebra: 1, apple: 2 });
    const b = hash('capturelock.v1.cart', { apple: 2, zebra: 1 });
    expect(a).toBe(b);
  });

  it('is domain-separated: the same value under two domains yields different digests', () => {
    const value = { amountMinor: 1000 };
    expect(hash('capturelock.v1.cart', value)).not.toBe(hash('capturelock.v1.envelope', value));
  });

  it('produces a different digest for every declared domain', () => {
    const digests = new Set(HASH_DOMAINS.map(d => hash(d, { a: 1 })));
    expect(digests.size).toBe(HASH_DOMAINS.length);
  });

  it('produces a lowercase 64-char hex digest', () => {
    const digest = hash('capturelock.v1.decision', { verdict: 'ALLOW' });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(isSha256Hex(digest)).toBe(true);
  });

  it('matches committed golden digests', () => {
    // Preimage: utf8(domain) || 0x00 || utf8(canonicalJSON)
    expect(hash('capturelock.v1.cart', { currency: 'INR', amountMinor: 479900 })).toBe(
      'b39c34160e5615c765461e490e73f2fb7e18f9faf149a2f8524dde65776264e7',
    );
    expect(hash('capturelock.v1.decision', {})).toBe(
      '93b2425e8b713c3af7a82d131ca36cd3c47500007ce32bf2e2553794786212d0',
    );
  });

  it('hashBytes agrees with hash', () => {
    const value = { a: 1, b: 'two' };
    expect(hashBytes('capturelock.v1.policy', value).toString('hex')).toBe(
      hash('capturelock.v1.policy', value),
    );
  });

  it('propagates canonicalization failures rather than hashing a fallback', () => {
    expect(() => hash('capturelock.v1.cart', { a: undefined })).toThrow(CanonicalizationError);
    expect(() => hash('capturelock.v1.cart', { price: 1.5 })).toThrow(CanonicalizationError);
  });
});

describe('asSha256Hex', () => {
  it('accepts a valid digest', () => {
    expect(asSha256Hex('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects wrong length, uppercase, and non-hex', () => {
    expect(() => asSha256Hex('a'.repeat(63))).toThrow();
    expect(() => asSha256Hex('A'.repeat(64))).toThrow();
    expect(() => asSha256Hex('g'.repeat(64))).toThrow();
  });
});
