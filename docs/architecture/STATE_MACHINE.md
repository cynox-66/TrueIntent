# CaptureLock State Machine Architecture

## 1. Overview

To prevent undefined intermediate states and ensure strict reproducibility, CaptureLock replaces implicit logic with explicit, deterministic finite state machines (FSMs).

---

## 2. Session Verification State Machine

```
              ┌───────────────┐
              │  INITIALIZED  │
              └───────┬───────┘
                      │ POST /sessions/snapshot
                      ▼
              ┌───────────────┐
              │ SNAPSHOT_HELD │
              └───────┬───────┘
                      │ POST /sessions/authorize_capture
                      ▼
              ┌───────────────┐
              │  EVALUATING   │
              └───────┬───────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   ┌───────────┐┌───────────┐┌───────────┐
   │   ALLOW   ││   PAUSE   ││   DENY    │
   └─────┬─────┘└─────┬─────┘└─────┬─────┘
         │            │            │
         │ Razorpay   │ Human      │ Terminal
         │ Order      │ Override   │
         ▼            ▼            ▼
   ┌───────────┐┌───────────┐┌───────────┐
   │ EXECUTING ││ REVIEWING ││  ABORTED  │
   └─────┬─────┘└───────────┘└───────────┘
         │
         ▼
   ┌───────────┐
   │ COMPLETED │
   └───────────┘
```

### 2.1 State Definitions

| State           | Mutability | Permitted Transitions      | Trigger / Conditions                                                               |
| --------------- | ---------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `INITIALIZED`   | Mutable    | `SNAPSHOT_HELD`, `ABORTED` | Session created with user intent and budget constraints.                           |
| `SNAPSHOT_HELD` | Mutable    | `EVALUATING`, `ABORTED`    | Agent submits proposed cart with observed row hashes.                              |
| `EVALUATING`    | Transient  | `ALLOW`, `PAUSE`, `DENY`   | Verification pipeline executing deterministic & freshness checks.                  |
| `ALLOW`         | Immutable  | `EXECUTING`                | All checks passed. Payment release authorized.                                     |
| `PAUSE`         | Reviewable | `EXECUTING`, `ABORTED`     | Marginal intent divergence or trajectory threshold reached; human review required. |
| `DENY`          | Terminal   | `ABORTED`                  | Policy breach, stale state, or intent divergence. No money can move.               |
| `EXECUTING`     | In-Flight  | `COMPLETED`, `FAILED`      | Razorpay Order created in test mode; awaiting webhook resolution.                  |
| `COMPLETED`     | Terminal   | None                       | Payment captured and verified; evidence ledger updated.                            |
| `ABORTED`       | Terminal   | None                       | Session canceled, expired, or rejected.                                            |

---

## 3. Payment Release State Machine

```
   ┌─────────────┐
   │   PENDING   │ ◄─── Initial creation with idempotency key
   └──────┬──────┘
          │ Razorpay orders.create success
          ▼
   ┌─────────────┐
   │ORDER_CREATED│
   └──────┬──────┘
          │ Webhook: payment.authorized (optional pre-auth)
          ▼
   ┌─────────────┐
   │ AUTHORIZED  │
   └──────┬──────┘
          │ Webhook: payment.captured
          ├──────────────────────────┐
          ▼                          ▼
   ┌─────────────┐            ┌─────────────┐
   │  CAPTURED   │            │   FAILED    │ ◄── Webhook: payment.failed
   └─────────────┘            └─────────────┘
```

### 3.1 Transition Rules & Invariants

1. **Idempotent Transitions**: A duplicate `payment.captured` webhook arriving after the release is already in `CAPTURED` state is an idempotent no-op (recorded in `webhook_inbox` as `IGNORED_DUPLICATE`).
2. **Terminal Invariance**: Once a release reaches `CAPTURED` or `FAILED`, it cannot transition to any other state.
3. **No Retries on Same Release**: If a payment fails, a new release with a distinct attempt sequence and idempotency key must be initiated.

---

## 4. Open Design Decisions

- **Session Expiration Horizon**: STATUS: OPEN DECISION (Default expiration TTL for an `INITIALIZED` or `SNAPSHOT_HELD` session before auto-transitioning to `EXPIRED` — proposed: 15 minutes).
- **Human Approval Channel for `PAUSED` Sessions**: STATUS: OPEN DECISION (Webhook dispatch vs. polling endpoint for operator intervention).
