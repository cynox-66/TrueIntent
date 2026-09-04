# TrueIntent state machines

Rationale and the Razorpay findings that shaped this are in
[ADR-005](../decisions/ADR-005-release-state-machine.md). This document is the
reference.

## 1. Three lifecycles, kept apart

Phase 0 modelled verdicts as states of a session. A verdict is the _output of an
evaluation_, and an authorization may be evaluated many times — "the session is
in state ALLOW" stops meaning anything the moment a second evaluation says DENY.

| Lifecycle     | What it tracks            | Mutability                              |
| ------------- | ------------------------- | --------------------------------------- |
| Authorization | a user-granted mandate    | `ACTIVE → CONSUMED / REVOKED / EXPIRED` |
| Release       | one attempt to move money | the machine below                       |
| Evaluation    | one decision              | immutable; no lifecycle                 |

## 2. Release state machine

```
                    ┌─────────┐
                    │  DRAFT  │
                    └────┬────┘
                         │ RELEASE_REQUESTED
                         ▼
                   ┌───────────┐
                   │ VERIFYING │──── VERIFICATION_DENIED ──► DENIED  ▣
                   └─────┬─────┘──── VERIFICATION_PAUSED ──► PAUSED
                         │ VERIFICATION_ALLOWED
                         ▼
                   ┌──────────┐
                   │ VERIFIED │
                   └─────┬────┘
                         │ ORDER_CALL_STARTED     ◄── write-ahead, committed
                         ▼                            BEFORE the provider call
              ┌────────────────────┐
              │  ORDER_IN_FLIGHT   │──── ORDER_REJECTED ──► FAILED  ▣
              └─────┬──────────┬───┘
     ORDER_CREATED  │          │ ORDER_CALL_INDETERMINATE
                    │          ▼
                    │   ┌──────────────────────┐
                    │   │ ORDER_INDETERMINATE  │
                    │   └──────┬───────────────┘
                    │          │ findOrderByReceipt  (lookup ONLY, never a retry)
                    ▼          ▼
              ┌───────────────────┐
              │  ORDER_CREATED    │──── PAYMENT_FAILED ──► FAILED  ▣
              └─────┬─────────────┘
                    │ PAYMENT_AUTHORIZED  (verified webhook)
                    ▼
           ┌──────────────────────┐
           │  PAYMENT_AUTHORIZED  │
           └──────┬───────────────┘
                  │ CAPTURE_REQUESTED
                  ▼
           ┌────────────────────┐
           │ CAPTURE_VERIFYING  │──── CAPTURE gate: the kernel runs AGAIN
           └──────┬─────────────┘     against a fresh live merchant read
                  │ CAPTURE_ALLOWED
                  ▼
           ┌────────────────────┐
           │  CAPTURE_APPROVED  │
           └──────┬─────────────┘
                  │ CAPTURE_CALL_STARTED   ◄── write-ahead; MONEY AT RISK
                  ▼                            from here on
        ┌────────────────────────┐
        │   CAPTURE_IN_FLIGHT    │── CAPTURE_PROVIDER_REJECTED ─► CAPTURE_REJECTED ▣
        └───┬────────────────┬───┘
CAPTURE_    │                │ CAPTURE_CALL_INDETERMINATE
SUCCEEDED   │                ▼
            │   ┌──────────────────────────┐
            │   │ CAPTURE_INDETERMINATE    │
            │   └───┬──────────────────┬───┘
            │       │ getPayment       │ getPayment
            │       │ → captured       │ → not captured
            ▼       ▼                  ▼
        ┌──────────────┐        ┌───────────────────┐
        │   CAPTURED   │        │ CAPTURE_REJECTED ▣│
        └──────┬───────┘        └───────────────────┘
               │ SETTLEMENT_CONFIRMED  (verified webhook)
               ▼
        ┌───────────┐
        │ SETTLED ▣ │
        └───────────┘

PAUSED ── REVIEW_APPROVED ──► CAPTURE_VERIFYING   (re-verifies; does not execute)
PAUSED ── REVIEW_REJECTED ──► ABORTED ▣

▣ = terminal
```

## 3. Invariants, all asserted by tests

1. **No transition leaves a terminal state.** Every trigger from every terminal
   state returns null.
2. **`CAPTURED` is deliberately not terminal.** Money has moved; the provider has
   not confirmed settlement, and that confirmation should have somewhere to land.
3. **`CAPTURE_IN_FLIGHT` is reachable only from `CAPTURE_APPROVED`**, which is
   reachable only from `CAPTURE_VERIFYING` via `CAPTURE_ALLOWED`. There is
   exactly one route to money moving and it passes through the kernel.
4. **No blind retry.** No edge leads from an indeterminate state back into an
   in-flight one. The only exits ask the provider what it knows.
5. **Approval re-verifies.** `PAUSED → CAPTURE_VERIFYING`, never straight to a
   capture. If the price moved while a human deliberated, the approval does not
   paper over it.
6. **No unreachable states, no non-terminal dead ends.** Checked structurally by
   `graphInvariants()`.
7. **Every declared trigger appears in the table.** This invariant caught two
   dead triggers during development.

## 4. Write-ahead, and why the ordering matters

```
tx: CAS CAPTURE_APPROVED → CAPTURE_IN_FLIGHT, persist receipt + inFlightSince
COMMIT                                    ← durable record: we are about to move money
    provider.capturePayment(...)
tx: CAS CAPTURE_IN_FLIGHT → CAPTURED | CAPTURE_INDETERMINATE | CAPTURE_REJECTED
```

A crash anywhere in the middle leaves the release in `CAPTURE_IN_FLIGHT`, and
`in_flight_since` is non-null, so the reconciliation sweep finds it. Doing this
the other way round — call, then record — means a process that dies mid-call
leaves no evidence that money may have moved.

Every transition is `UPDATE … WHERE release_id = $1 AND state = ANY($2)
RETURNING *`. Zero rows means the caller lost the race, and the caller reports
what is now true rather than forcing its own transition through.

## 5. Transitions

| Trigger                           | From                                              | To                    | Notes                               |
| --------------------------------- | ------------------------------------------------- | --------------------- | ----------------------------------- |
| `RELEASE_REQUESTED`               | DRAFT                                             | VERIFYING             |                                     |
| `VERIFICATION_ALLOWED`            | VERIFYING                                         | VERIFIED              |                                     |
| `VERIFICATION_PAUSED`             | VERIFYING, CAPTURE_VERIFYING                      | PAUSED                | opens a review bound to the request |
| `VERIFICATION_DENIED`             | VERIFYING, CAPTURE_VERIFYING                      | DENIED                | terminal                            |
| `ORDER_CALL_STARTED`              | VERIFIED                                          | ORDER_IN_FLIGHT       | **write-ahead**                     |
| `ORDER_CREATED`                   | ORDER_IN_FLIGHT                                   | ORDER_CREATED         | no money yet                        |
| `ORDER_CALL_INDETERMINATE`        | ORDER_IN_FLIGHT                                   | ORDER_INDETERMINATE   | keeps `in_flight_since`             |
| `ORDER_REJECTED`                  | ORDER_IN_FLIGHT                                   | FAILED                | definite refusal                    |
| `ORDER_RECONCILED_FOUND`          | ORDER_INDETERMINATE, ORDER_IN_FLIGHT              | ORDER_CREATED         | lookup by receipt                   |
| `ORDER_RECONCILED_ABSENT`         | ORDER_INDETERMINATE, ORDER_IN_FLIGHT              | FAILED                | create never landed                 |
| `PAYMENT_AUTHORIZED`              | ORDER_CREATED                                     | PAYMENT_AUTHORIZED    | verified webhook                    |
| `CAPTURE_REQUESTED`               | PAYMENT_AUTHORIZED                                | CAPTURE_VERIFYING     |                                     |
| `CAPTURE_ALLOWED`                 | CAPTURE_VERIFYING                                 | CAPTURE_APPROVED      | the decision that lets money move   |
| `CAPTURE_CALL_STARTED`            | CAPTURE_APPROVED                                  | CAPTURE_IN_FLIGHT     | **write-ahead; money at risk**      |
| `CAPTURE_SUCCEEDED`               | CAPTURE_IN_FLIGHT                                 | CAPTURED              |                                     |
| `CAPTURE_CALL_INDETERMINATE`      | CAPTURE_IN_FLIGHT                                 | CAPTURE_INDETERMINATE | keeps `in_flight_since`             |
| `CAPTURE_PROVIDER_REJECTED`       | CAPTURE_IN_FLIGHT                                 | CAPTURE_REJECTED      | terminal                            |
| `CAPTURE_RECONCILED_CAPTURED`     | CAPTURE_INDETERMINATE, CAPTURE_IN_FLIGHT          | CAPTURED              | `getPayment` said captured          |
| `CAPTURE_RECONCILED_NOT_CAPTURED` | CAPTURE_INDETERMINATE, CAPTURE_IN_FLIGHT          | CAPTURE_REJECTED      | `getPayment` said otherwise         |
| `SETTLEMENT_CONFIRMED`            | CAPTURED                                          | SETTLED               | terminal                            |
| `PAYMENT_FAILED`                  | ORDER_CREATED, PAYMENT_AUTHORIZED                 | FAILED                | terminal                            |
| `REVIEW_APPROVED`                 | PAUSED                                            | CAPTURE_VERIFYING     | re-verifies                         |
| `REVIEW_REJECTED`                 | PAUSED                                            | ABORTED               | terminal                            |
| `ABORT`                           | DRAFT, VERIFYING, VERIFIED, ORDER_CREATED, PAUSED | ABORTED               | only before money can move          |

### 5.1 Why `PAYMENT_AUTHORIZED` is reachable at all

Every order is created with `payment_capture: 0`.

Razorpay's default for that field comes from an **account-level setting**. If
that setting is auto-capture — a common default — a payment moves
`created → captured` the moment the payer completes checkout, and never passes
through `authorized`. The whole right-hand side of this machine would then be
unreachable: the capture gate would have nothing left to gate, because the
provider had already moved the money before the second verification ran.

So manual capture is asserted per order rather than inherited. A property the
architecture depends on should not be a dashboard toggle someone can flip
without touching this repository. Found by live measurement; see
[ADR-016](../decisions/ADR-016-live-capture-verification.md).

## 6. Two kinds of stuck, and two sweeps

A release can be stuck for two quite different reasons, and conflating them
would be dangerous in one direction and useless in the other.

|                          | transient                                                                 | indeterminate                                                                          |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| states                   | `DRAFT`, `VERIFYING`, `VERIFIED`, `CAPTURE_VERIFYING`, `CAPTURE_APPROVED` | `ORDER_IN_FLIGHT`, `ORDER_INDETERMINATE`, `CAPTURE_IN_FLIGHT`, `CAPTURE_INDETERMINATE` |
| was the provider called? | **provably not**                                                          | possibly                                                                               |
| safe action              | abort                                                                     | ask the provider                                                                       |
| sweep                    | `sweepAbandoned()`                                                        | `sweep()`                                                                              |
| what it fixes            | liveness                                                                  | correctness                                                                            |

**Why aborting a transient state is safe, precisely.** Each is entered _before_
a write-ahead commit and left _by_ one. A release sitting in `CAPTURE_APPROVED`
means the commit into `CAPTURE_IN_FLIGHT` did not happen — and that commit
precedes the provider call. So nothing was called, and there is nothing to
reconcile.

**Why the liveness sweep is necessary at all.** The partial unique index permits
one non-terminal release per authorization. A stranded release holds that slot
forever, so a single crash during verification would permanently prevent the
mandate from ever being spent. The safety property creates the hazard; this
resolves it. See [ADR-011](../decisions/ADR-011-unit-of-work-and-stranded-releases.md).

**Why reconciliation waits.** An empty order lookup is _not_ proof of absence:
Razorpay's receipt search is eventually consistent, measured at roughly eight
seconds. Concluding `FAILED` from an early empty read would mark a real order
failed. Reconciliation only draws that conclusion past
`providerLookupConsistencySeconds`. See [ADR-015](../decisions/ADR-015-razorpay-reality.md).

## 7. Webhooks and out-of-order delivery

A webhook resolves to a trigger; the trigger is applied only if the machine
declares that edge from the release's current state. An event implying an
undeclared move — a late `payment.authorized` for a settled release — is
**recorded in the inbox and not applied**. A webhook can never create a release,
only advance one along a declared edge.
