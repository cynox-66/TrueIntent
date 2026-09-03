# ADR-006: Two-layer idempotency

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: the "Idempotency Key Scope" open decision in ADR-001

## Context

Phase 0 proposed a single idempotency key, `H(mandateRef ‖ phase ‖ cartDigest)`.
A single agent-chosen key cannot bound money movement, for a reason that is
obvious once stated: **the agent chooses it**. An agent that wants a second
charge simply varies the key.

The converse failure is just as real. If the _same_ key arrives with a
_different_ payload, returning the stored answer would let an attacker get a
new cart charged under an approval given for an old one.

## Decision

Two layers with different jobs, and the guarantee lives in the database.

### Layer 1 — client key: deduplicates _requests_

`releases.client_idempotency_key UNIQUE`, stored alongside a
`request_fingerprint` — a domain-separated hash of
`(authorizationId, snapshotId, gate, principal)`.

- same key, same fingerprint → the stored answer is replayed, provider untouched
- same key, **different** fingerprint → `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`,
  DENY

### Layer 2 — server-derived receipt and a partial unique index: bounds _money_

The agent has no influence here.

- `receipt = f(authorizationId, snapshotHash)`, `UNIQUE`. Deterministic, so a
  retry recomputes it; server-derived, so a fresh one cannot be minted.
- ```sql
  CREATE UNIQUE INDEX releases_one_active_per_authorization
    ON releases (authorization_id)
    WHERE state NOT IN ('SETTLED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED');
  ```
  **At most one non-terminal release per authorization.** Ten concurrent requests
  to spend one mandate all issue the insert; Postgres lets exactly one through
  and rejects nine with 23505. No application logic is consulted, so no
  application bug can weaken it.
- `provider_payment_id UNIQUE` — one release per payment.
- Every state change is `UPDATE … WHERE id = $1 AND state = ANY($2) RETURNING *`.
  Zero rows means the caller lost the race. There is no read-then-write anywhere
  in the release path, because a read-then-write is exactly how two concurrent
  captures both conclude they may proceed.

### Capture is bounded by the state machine, not by a key

After a capture the release is no longer in a state the capture gate may run
from, so a second attempt cannot reach the provider whatever key it presents.
Razorpay's own non-idempotent capture is the last line: even if everything above
failed, the provider refuses the second capture.

## What is proven where

| Claim                                                 | Proven by                                                 |
| ----------------------------------------------------- | --------------------------------------------------------- |
| One active release per authorization across processes | `postgres.db.test.ts` — 10 concurrent inserts, 1 succeeds |
| One winner per state transition                       | `postgres.db.test.ts` — 10 concurrent CAS, 1 succeeds     |
| One webhook processed per event id                    | `postgres.db.test.ts` — 10 concurrent claims, 1 succeeds  |
| The application logic has the right shape             | in-memory suite, single process                           |

The split is deliberate. The in-memory repositories model the semantics
faithfully and run offline, but on a single-threaded event loop they cannot
prove anything about several API instances sharing a database. Only the Postgres
suite can, so the claims above are scoped to what it actually covers.

## Consequences

**Positive.** Duplicate prevention is a database constraint rather than a
convention. An agent varying its idempotency key gains nothing.

**Negative.** An authorization funds one purchase at a time. A legitimate user
wanting two concurrent purchases needs two authorizations — which is arguably
the correct model for a delegated mandate anyway.
