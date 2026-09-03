# ADR-005: The release state machine, and what Razorpay actually does

- **Status**: Accepted; two premises corrected by [ADR-015](ADR-015-razorpay-reality.md), and the atomicity claim corrected by [ADR-011](ADR-011-unit-of-work-and-stranded-releases.md)
- **Date**: 2026-09-03
- **Supersedes**: the release FSM in `docs/architecture/STATE_MACHINE.md`

## Context

Phase 0 modelled the release as `PENDING → ORDER_CREATED → AUTHORIZED →
CAPTURED | FAILED`, and modelled verdicts (ALLOW / PAUSE / DENY) as _states of a
session_.

Two problems.

**A verdict is not a state.** It is the output of an evaluation, and an
authorization may be evaluated more than once. "The session is in state ALLOW"
stops meaning anything the moment a second evaluation says DENY.

**There was no state for "we asked and never heard back."** That is the state a
payment system spends its most dangerous moments in. Without it, a process that
dies mid-call either forgets the request happened or retries it blindly.

Before designing the recovery path, we checked what the Razorpay API actually
does rather than assuming it behaves like Stripe:

- [`POST /v1/orders`](https://razorpay.com/docs/api/orders/create/) treats
  `receipt` as an idempotency key with **reject-on-duplicate** semantics. A
  repeat create returns an error, _not the existing order_. So the standard
  "retry with the same key and read the response" recovery does not work here.
  `receipt` is also capped at **40 characters**, which a 64-character SHA-256 hex
  digest does not fit.
- [`POST /v1/payments/:id/capture`](https://razorpay.com/docs/api/payments/capture/)
  is **not idempotent**. Re-capturing returns HTTP 400 "The payment has already
  been either captured or voided."
- [`GET /v1/orders?receipt=`](https://razorpay.com/docs/api/orders/fetch-all/)
  and `GET /v1/payments/:id` are the recovery reads. **The order lookup is
  eventually consistent** — empty immediately after a create, populated seconds
  later — so an empty result is not proof of absence. See ADR-015.

That last capture behaviour is the sharp edge. The 400 is a _success signal in
disguise_: it means the money moved. Code that treats it as a failure either
retry-storms or records a loss that did not happen.

## Decision

Three separate lifecycles, and an explicit transition table.

- **Authorization**: `ACTIVE → CONSUMED | REVOKED | EXPIRED`
- **Release**: the money-movement machine below
- **Evaluation**: an immutable event with no lifecycle at all

```
DRAFT → VERIFYING → VERIFIED | PAUSED | DENIED
VERIFIED → ORDER_IN_FLIGHT → ORDER_CREATED | ORDER_INDETERMINATE | FAILED
ORDER_INDETERMINATE → ORDER_CREATED | FAILED      (via findOrderByReceipt ONLY)
ORDER_CREATED → PAYMENT_AUTHORIZED
PAYMENT_AUTHORIZED → CAPTURE_VERIFYING → CAPTURE_APPROVED | PAUSED | DENIED
CAPTURE_APPROVED → CAPTURE_IN_FLIGHT              (write-ahead; MONEY AT RISK)
CAPTURE_IN_FLIGHT → CAPTURED | CAPTURE_INDETERMINATE | CAPTURE_REJECTED
CAPTURE_INDETERMINATE → CAPTURED | CAPTURE_REJECTED  (via getPayment ONLY)
CAPTURED → SETTLED
PAUSED → CAPTURE_VERIFYING | ABORTED
Terminal: SETTLED, DENIED, CAPTURE_REJECTED, FAILED, ABORTED
```

### Write-ahead before every provider call

`ORDER_IN_FLIGHT` and `CAPTURE_IN_FLIGHT` are **committed before the request goes
out** and cleared only after a response comes back. (Phase 1 described this as
one transaction but implemented it as several autocommits; corrected in
[ADR-011](ADR-011-unit-of-work-and-stranded-releases.md), which also covers the
stranding hazard that created.) A process that dies in
between wakes up in one of them, holding a durable record — including the exact
receipt — that a provider call was about to happen.

### Indeterminate is not failure

From `*_INDETERMINATE` the only legal moves are reached by _asking the provider
what it knows_. There is deliberately **no edge back into an in-flight state**,
so a blind retry is not expressible. The FSM tests assert this.

### `CAPTURED` is not terminal

Money has moved, but the provider has not confirmed settlement. Keeping it
non-terminal means a `payment.captured` webhook has somewhere to land.

### Deterministic, length-bounded receipt

`receipt = "cl_" + base64url(SHA-256(domain ‖ authorizationId ‖ snapshotHash)[0:24])`
— 35 characters, inside Razorpay's 40-character limit. Deterministic so a retry
recomputes the same value; server-derived so an agent cannot mint a fresh one to
escape deduplication.

## Consequences

**Positive.** "We do not know" is a first-class, durable state with exactly one
way out. The `ALREADY_CAPTURED` provider outcome is a named variant of a
discriminated union, so a caller cannot ignore it without a type error.

**Negative.** More states than a naive model, and every provider call costs two
extra database writes.

**Honest limitation.** We can claim **at-most-once money movement** plus
**eventually-consistent knowledge of settlement**. We cannot claim end-to-end
exactly-once: after an indeterminate capture, whether the money moved is unknown
to us until reconciliation succeeds. If the provider stays unreachable, the
release stays stuck — which is the correct behaviour, and it is a human's problem
to resolve, not something to paper over with a guess.
