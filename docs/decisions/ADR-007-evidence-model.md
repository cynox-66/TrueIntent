# ADR-007: Evidence — Ed25519 signatures over a hash chain

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: the signing-primitive open decisions in ADR-001, `THREAT_MODEL.md` and `SECURITY_MODEL.md`

## Context

Phase 0 specified hash-chained envelopes and left the cryptographic primitive
open: HMAC-SHA256 versus Ed25519.

The question that settles it is _which adversary_. A hash chain stored in the
same database it describes detects a single edited row — but an adversary with
write access to that database can recompute every subsequent hash and produce a
chain that verifies perfectly. Against the adversary who most plausibly wants to
rewrite a payment record, a bare hash chain is close to worthless.

## Decision

**Ed25519 signature over each envelope's chain hash, plus the SHA-256 chain.**
Implemented in `packages/evidence`, using Node's built-in `crypto`.

Two mechanisms, catching different things:

- The **chain** catches modification, deletion and reordering. `sequence` and
  `prevChainHash` are inside the hashed preimage, so moving an envelope or
  dropping the one before it breaks the link.
- The **signature** means recomputing the chain is not enough. Forgery requires
  the signing key, which does not live in the database.

**Ed25519 rather than HMAC** because verification needs only the _public_ key. A
dispute reviewer can check the ledger without being handed a secret that would
also let them forge it. That is the whole point of an evidence artefact, and an
HMAC cannot provide it. The public key is served at
`GET /v1/evidence/public-key`.

### Replay is the real claim

Every DECISION envelope carries the **full serialized verification context**, not
a summary. An auditor deserializes it, re-runs `evaluate`, and compares decision
hashes. If they match, the decision has been _reproduced_ from its inputs rather
than merely described.

This only works because the kernel is a pure function — no clock, no I/O, no
randomness. Purity is not a style preference here; it is what makes the evidence
a proof rather than a claim.

### Head witness

Each release response returns the chain head. A client that keeps it holds
something the operator cannot retroactively change. Truncation is internally
consistent and undetectable without one, which the tests demonstrate explicitly.

### Append-only at the database

Postgres triggers reject `UPDATE` and `DELETE` on `evidence_envelopes` and
`evaluations`. "Append-only at the application level" is a convention, and
conventions do not survive an incident at 3am.

## Alternatives rejected

- **Plain SHA-256 chain.** Would have left the primary adversary unaddressed.
- **HMAC-SHA256 chain.** Forgery-resistant against a DB-only attacker, but the
  verifier needs the secret, so there is no third-party verification.
- **External anchoring (a public log, a blockchain).** Would close the
  signing-key compromise below. Out of scope, and the brief explicitly excludes
  it.

## Honest limitations

- **An attacker with the signing key can forge history undetectably.** In this
  prototype the key is a local environment variable, so that is a realistic
  compromise. Production would hold it in an HSM or KMS and publish chain heads
  somewhere the operator cannot edit.
- **A head witness only helps if someone kept it.** We return it; we cannot make
  a client store it.
- **Replay reproduces the deterministic decision only.** The advisory
  adjustment (ADR-009) is recorded beside it, attributed and dated, and is
  explicitly not reproducible.
