# ADR-015: What Razorpay actually does, measured

- **Status**: Accepted
- **Date**: 2026-09-03
- **Corrects**: [ADR-005](ADR-005-release-state-machine.md), which was built on the published documentation

## Context

Phase 1 read the Razorpay documentation rather than guessing, and built the
recovery design on two statements it makes:

> An order with the same `receipt` value has already been created on this
> account. `receipt` is treated as an idempotency key.

> `GET /v1/orders?receipt=` — retrieves the orders that contain the provided
> value for receipt.

Phase 2 ran `pnpm smoke:razorpay` against real test-mode credentials. **Both
statements are misleading in ways that break the recovery path.**

## Findings

### 1. A duplicate receipt is ACCEPTED by default

```
POST /v1/orders  receipt=cl_probe_1788449327  → order_TXc6b1dic8uruD
POST /v1/orders  receipt=cl_probe_1788449327  → order_TXc6bApxTCf9Md
```

Two distinct orders, one receipt, no error. Rejection is an opt-in account
setting ("prevent duplicate order with same receipt"), off by default.

**Consequence.** Retrying `orders.create` after a lost response does not return
the original order — it creates a **second** one. No money moves (an order is a
container, not a charge), but the customer would pay whichever order the
checkout points at, orphaning the other.

The Phase 1 design happened to be safe here, for the right reason: the FSM has no
edge from `ORDER_INDETERMINATE` back into `ORDER_IN_FLIGHT`, so a blind retry was
never expressible. But it was safe by a rule justified with a _false premise_,
which is not the same as being safe by design.

### 2. The receipt lookup is EVENTUALLY CONSISTENT

```
POST /v1/orders  receipt=R                    → order created
GET  /v1/orders?receipt=R                     → {"count": 0, "items": []}
   … ~8 seconds …
GET  /v1/orders?receipt=R                     → {"count": 2, …}
```

**Consequence, and this one was a live bug.** Reconciliation read a null lookup
as `ORDER_RECONCILED_ABSENT → FAILED`. Against the real API that marks a _real_
order FAILED whenever reconciliation runs inside the indexing window — and then
invites a later attempt to create a duplicate for the same purchase.

### 3. The lookup may return the wrong duplicate

With two orders sharing a receipt, the smoke test recovered
`order_TXc9u04TtxWCzE` — the **second** one. The list is newest-first, so a
lookup after an accidental duplicate returns the most recent, which is not
necessarily the one whose id was lost.

## Decision

1. **An empty lookup is inconclusive, not proof of absence.** Reconciliation
   concludes `ABSENT` only once the release has been in flight longer than
   `providerLookupConsistencySeconds` (default 60s, against ~8s observed).
   Before that, it stays `ORDER_INDETERMINATE` and reports `NOT_RESOLVED`.
   Refusing to guess is the whole posture of this system, and this is a case
   where the previous code guessed.

2. **The fake provider models both behaviours.** `rejectDuplicateReceipt`
   defaults to **false**, matching reality, so no test can rely on protection
   that is off by default. `lookupImmediatelyConsistent` can be turned off so
   the lag is exercised offline.

3. **The smoke test reports rather than asserts** on duplicate handling, because
   the answer is an account setting and both answers are legitimate. It still
   asserts that the order becomes findable, since recovery depends on it.

4. **Recommended, not depended upon:** enable "prevent duplicate order with same
   receipt" in the Razorpay dashboard. It removes finding 1. The code is correct
   either way, and must stay so, because we do not control that setting.

## Consequences

**Positive.** The recovery path is now built on measured behaviour. A real order
is no longer marked FAILED because a search index lagged.

**Negative.** An order whose response was lost stays unresolved for up to a
minute. That is the honest cost of not guessing.

**Honest limitations.**

- Measured on **one account, one day**. Both behaviours could differ on another
  account or change without notice. The smoke test exists to be re-run.
- The consistency window is empirical, not contractual. Razorpay publishes no
  bound, and 60s is a margin over one observation of ~8s, not a guarantee.
- **Capture semantics remain unverified against the live API.** The smoke test
  deliberately never captures, so the non-idempotent-capture behaviour
  underpinning `CAPTURE_INDETERMINATE` is still taken from the documentation
  alone. Verifying it needs a real authorized payment, which needs a hosted
  checkout and a human. That is the largest remaining gap between what is tested
  and what is claimed.

  > **Closed by [ADR-016](ADR-016-live-capture-verification.md).** This was true
  > when written. A full authorize → capture lifecycle was subsequently run in
  > test mode, including the duplicate-capture wording. Left in place because an
  > ADR records what was known at the time; the pointer is the correction.
