/**
 * Deterministic canonical serialization and domain-separated hashing.
 *
 * See docs/decisions/ADR-002-canonicalization-and-hashing.md for the rationale.
 *
 * This is the trust anchor for every hash TrueIntent produces: snapshot
 * hashes, policy hashes, decision hashes, and the evidence chain. If two
 * logically identical structures could serialize differently, an attacker
 * could produce a colliding-yet-different payload, or a verifier could report
 * false tampering. The algorithm is therefore a deliberately *restricted*
 * subset of RFC 8785 (JSON Canonicalization Scheme) that rejects every input
 * whose serialization is ambiguous rather than trying to normalize it.
 */

import { createHash } from 'node:crypto';
import type { Brand } from './brand.js';
import { CanonicalizationError } from './errors.js';

/** Lowercase hex SHA-256 digest, 64 characters. */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): value is Sha256Hex {
  return SHA256_HEX_PATTERN.test(value);
}

export function asSha256Hex(value: string): Sha256Hex {
  if (!isSha256Hex(value)) {
    throw new CanonicalizationError('Value is not a lowercase 64-char hex digest', 'sha256');
  }
  return value;
}

/**
 * Closed set of hash domains.
 *
 * Every digest is computed as SHA-256(domain || 0x00 || canonicalJSON). Without
 * this separation a canonical cart could be replayed as an evidence envelope
 * (or vice versa) whenever the two structures happened to coincide. The 0x00
 * separator cannot occur inside a domain tag, so the encoding is unambiguous.
 */
export const HASH_DOMAINS = [
  'capturelock.v1.constraints',
  'capturelock.v1.intent',
  'capturelock.v1.cart',
  'capturelock.v1.snapshot',
  'capturelock.v1.item_row',
  'capturelock.v1.live_state',
  'capturelock.v1.policy',
  'capturelock.v1.context',
  'capturelock.v1.decision',
  'capturelock.v1.envelope',
  'capturelock.v1.receipt',
  'capturelock.v1.request_fingerprint',
  'capturelock.v1.webhook_payload',
  'capturelock.v1.session_bounds',
  'capturelock.v1.context_capsule',
  'capturelock.v1.purchase_request',
] as const;

export type HashDomain = (typeof HASH_DOMAINS)[number];

/**
 * Object keys are restricted to this pattern.
 *
 * RFC 8785 sorts keys by UTF-16 code unit. That differs from code-point order
 * for astral characters, which is a subtle portability hazard for any
 * non-JavaScript verifier. Restricting keys to ASCII identifiers makes the two
 * orderings provably identical, so the choice can never surprise us. It also
 * rejects `__proto__`, `constructor`, and other prototype-pollution vectors by
 * construction, since a key must begin with a letter.
 */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Bounds on untrusted input. Agent-supplied JSON must not be able to exhaust the stack or CPU. */
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;

interface Cursor {
  nodes: number;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t !== 'object') return t;
  const ctor = (value as object).constructor;
  return ctor && typeof ctor.name === 'string' ? ctor.name : 'object';
}

/**
 * Rejects lone surrogates.
 *
 * A lone surrogate has no valid UTF-8 encoding. `JSON.stringify` escapes it
 * (ES2019 well-formed stringify) rather than failing, which would let two
 * different byte sequences round-trip to the same canonical form on some
 * platforms and not others. We refuse the input instead.
 */
function assertWellFormed(value: string, path: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError('String contains a lone high surrogate', path);
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalizationError('String contains a lone low surrogate', path);
    }
  }
}

function encode(
  value: unknown,
  path: string,
  depth: number,
  cursor: Cursor,
  seen: Set<object>,
): string {
  cursor.nodes += 1;
  if (cursor.nodes > MAX_NODES) {
    throw new CanonicalizationError(`Structure exceeds ${MAX_NODES} nodes`, path);
  }
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError(`Structure nested deeper than ${MAX_DEPTH}`, path);
  }

  if (value === null) return 'null';

  if (value === undefined) {
    // `undefined` and "absent" are indistinguishable after JSON.stringify, which
    // would make two structurally different objects hash identically. Only
    // `null` may express absence.
    throw new CanonicalizationError('undefined is not canonicalizable; use null', path);
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    // Only safe integers. This sidesteps the entire IEEE-754 shortest-repr
    // problem that makes RFC 8785 number serialization hard to get right in
    // other languages. Money is integer minor units, ratios are integer basis
    // points, and timestamps are ISO-8601 strings, so nothing legitimate needs
    // a fractional number inside a hashed structure.
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError('Non-finite number is not canonicalizable', path);
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        'Only safe integers may be hashed (use integer minor units or basis points)',
        path,
      );
    }
    if (Object.is(value, -0)) {
      throw new CanonicalizationError('Negative zero is not canonicalizable', path);
    }
    return String(value);
  }

  if (typeof value === 'string') {
    assertWellFormed(value, path);
    // JSON.stringify's string production matches RFC 8785 exactly: escape only
    // '"', '\\' and C0 controls, preferring the short forms. Hand-rolling this
    // is a well-known source of bugs, so we delegate.
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    throw new CanonicalizationError('bigint is not canonicalizable; use a string', path);
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    throw new CanonicalizationError(`${typeof value} is not canonicalizable`, path);
  }

  const asObject = value as object;
  if (seen.has(asObject)) {
    throw new CanonicalizationError('Circular reference', path);
  }
  seen.add(asObject);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        // Array holes read as undefined and would silently become null under
        // JSON.stringify. Reject them so a sparse array can never impersonate a
        // dense one.
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          throw new CanonicalizationError(
            'Sparse array holes are not canonicalizable',
            `${path}[${i}]`,
          );
        }
        parts.push(encode(value[i], `${path}[${i}]`, depth + 1, cursor, seen));
      }
      return `[${parts.join(',')}]`;
    }

    // Only plain objects. Date/Map/Set/class instances have lossy or
    // implementation-defined JSON forms; the caller must convert explicitly so
    // the conversion is visible in the code and in the evidence.
    const proto = Object.getPrototypeOf(asObject) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(
        `Only plain objects are canonicalizable, received ${describeType(value)}`,
        path,
      );
    }
    if (Object.getOwnPropertySymbols(asObject).length > 0) {
      throw new CanonicalizationError('Symbol-keyed properties are not canonicalizable', path);
    }

    const keys = Object.keys(asObject);
    for (const key of keys) {
      if (!KEY_PATTERN.test(key)) {
        throw new CanonicalizationError(
          `Object key ${JSON.stringify(key)} is not an ASCII identifier`,
          path,
        );
      }
    }
    // Default sort is UTF-16 code-unit order. Because keys are ASCII
    // identifiers, this is identical to code-point and byte order.
    keys.sort();

    const parts: string[] = [];
    for (const key of keys) {
      const child = (asObject as Record<string, unknown>)[key];
      parts.push(
        `${JSON.stringify(key)}:${encode(child, `${path}.${key}`, depth + 1, cursor, seen)}`,
      );
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(asObject);
  }
}

/**
 * Serializes a value to its canonical JSON form.
 *
 * Throws {@link CanonicalizationError} for any input whose serialization would
 * be ambiguous. Callers in the money path must let that throw: a value we
 * cannot hash is a value we cannot authorize.
 */
export function canonicalize(value: unknown): string {
  return encode(value, '$', 0, { nodes: 0 }, new Set<object>());
}

/**
 * Domain-separated SHA-256 over the canonical form.
 *
 * digest = SHA-256( utf8(domain) || 0x00 || utf8(canonicalJSON(value)) )
 */
export function hash(domain: HashDomain, value: unknown): Sha256Hex {
  const canonical = canonicalize(value);
  const digest = createHash('sha256')
    .update(Buffer.from(domain, 'utf8'))
    .update(Buffer.of(0x00))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex');
  return digest as Sha256Hex;
}

/** Raw SHA-256 digest bytes over the same domain-separated preimage. */
export function hashBytes(domain: HashDomain, value: unknown): Buffer {
  const canonical = canonicalize(value);
  return createHash('sha256')
    .update(Buffer.from(domain, 'utf8'))
    .update(Buffer.of(0x00))
    .update(Buffer.from(canonical, 'utf8'))
    .digest();
}
