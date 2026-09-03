# ADR-002: Canonical serialization and domain-separated hashing

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: the "JSON Serialization Canonicalization" open decision in `docs/architecture/DATA_MODEL.md`

## Context

Every integrity claim CaptureLock makes rests on a hash: the snapshot hash that
pins a price, the intent hash that pins a budget, the policy hash that pins the
rules, the decision hash that makes a verdict reproducible, and the chain hash
that makes the ledger tamper-evident.

If two logically identical structures can serialize differently, all of those
claims weaken at once. A verifier reports false tampering, or — worse — an
attacker finds two different payloads that serialize the same and substitutes one
for the other.

RFC 8785 (JSON Canonicalization Scheme) is the obvious starting point, but its
hardest part is number serialization: reproducing ECMAScript's shortest
round-tripping representation of an IEEE-754 double is subtle, and getting it
wrong in _any_ verifier implementation breaks interoperability silently.

## Decision

A **restricted subset of RFC 8785**, which rejects ambiguous input rather than
trying to normalize it. Implemented in `packages/core/src/canonical.ts`.

1. **Integers only.** A number must satisfy `Number.isSafeInteger`. Fractional
   values, `NaN`, infinities and `-0` are refused. This removes the entire
   double-serialization problem: money is integer minor units, ratios are
   integer basis points, and timestamps are ISO-8601 strings, so nothing
   legitimate needs a fractional number inside a hashed structure.
2. **`undefined` is refused.** `JSON.stringify` erases it, making
   `{a: undefined}` and `{}` hash identically. Only `null` may express absence.
3. **Keys are ASCII identifiers** (`/^[A-Za-z][A-Za-z0-9_]*$/`). RFC 8785 sorts
   by UTF-16 code unit, which differs from code-point order for astral
   characters — a portability hazard for any non-JavaScript verifier.
   Restricting the charset makes the two orderings provably identical. It also
   rejects `__proto__` and `constructor`-style pollution vectors by
   construction, since a key must begin with a letter.
4. **Lone surrogates are refused.** They have no valid UTF-8 encoding, and
   escaping them (as ES2019 `JSON.stringify` does) would let two different byte
   sequences produce one canonical form.
5. **No Unicode normalization.** Two NFC-equivalent strings hash differently, by
   design. Normalizing would let two distinct SKUs collide, which matters more
   than the cosmetic inconvenience.
6. **Plain objects only.** `Date`, `Map`, `Set`, `BigInt` and class instances are
   refused, so any conversion is visible in the calling code rather than
   implicit in a serializer.
7. **Bounded.** Depth 32, 20,000 nodes, no cycles — because the input includes
   agent-supplied JSON.
8. **Domain separation.** `SHA-256(utf8(domain) || 0x00 || utf8(canonicalJSON))`
   over a closed set of domain tags. Without it, a canonical cart could be
   replayed as an evidence envelope whenever the two structures coincided. The
   `0x00` separator cannot occur inside a tag, so the encoding is unambiguous.

Strings are serialized via `JSON.stringify`, whose string production matches
RFC 8785 exactly. Hand-rolling escape logic is a known source of bugs, so that
part is delegated rather than reimplemented.

## Alternatives rejected

- **Full RFC 8785.** Correct, and the number rules are the hard part. Since our
  data model has no legitimate use for fractional numbers, refusing them is
  strictly safer than implementing their serialization correctly.
- **Sorted-keys `JSON.stringify`.** What Phase 0 informally suggested. It
  silently accepts `undefined`, `-0`, floats, and `Date`, each of which
  introduces a collision or a platform dependency.
- **Protobuf / CBOR canonical forms.** Better-specified, but the evidence
  envelope should be readable by a human auditor without tooling, and JSON is.

## Consequences

**Positive.** Two independent implementations can agree without consulting a
floating-point specification. Golden vectors are committed, so the algorithm
cannot drift silently. Refusing hostile input at the serializer means a
malformed value fails loudly at the hashing boundary rather than producing a
plausible-looking wrong hash.

**Negative.** Callers must convert `Date` to ISO strings and percentages to basis
points explicitly. Attribute maps are modelled as sorted arrays of pairs rather
than objects, because merchant attribute names are not ASCII identifiers. Both
are minor, and both make the conversion visible where it happens.

**Honest limitation.** SHA-256 over a canonical form gives collision resistance
and tamper _evidence_. It is not a signature and it does not prove authorship;
that is ADR-007's job.
