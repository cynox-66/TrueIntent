# ADR-011: Transaction boundaries, and the liveness hazard the safety index creates

- **Status**: Accepted
- **Date**: 2026-09-03
- **Corrects**: the atomicity claim in [ADR-005](ADR-005-release-state-machine.md) §"Write-ahead before every provider call"

## Context

ADR-005 described the capture path as one transaction:

> `tx: CAS CAPTURE_APPROVED → CAPTURE_IN_FLIGHT, persist receipt + inFlightSince` / `COMMIT`

It was not. The implementation performed **three sequential** `transition()` calls
(`PAYMENT_AUTHORIZED → CAPTURE_VERIFYING → CAPTURE_APPROVED → CAPTURE_IN_FLIGHT`),
each its own autocommit, plus separate evidence and evaluation appends. No domain
port exposed a transaction at all. The document described an intention; the code
did something else.

With in-memory repositories that was invisible. Against Postgres it is a real
defect, and the consequence is worse than partial writes.

### The stranding hazard

A crash mid-chain leaves the release in `CAPTURE_VERIFYING` or
`CAPTURE_APPROVED`. Neither is in `INDETERMINATE_RELEASE_STATES`, so
`findRequiringReconciliation` can never see it. Nine states are non-terminal and
unreachable by reconciliation; five of them are transient and reachable by a
crash.

And then the second-order effect. The partial unique index from
[ADR-006](ADR-006-idempotency-model.md) permits **one non-terminal release per
authorization** — the constraint that gives us at-most-once. A stranded release
holds that slot forever, so the mandate can never be spent again. **The safety
property creates the liveness bug.** Not theoretical: a single unlucky crash
permanently bricks a user's authorization with no path to recovery.

## Decision

### 1. A real unit of work

`UnitOfWork.withTransaction(fn: (repos: Repositories) => Promise<T>)`, in
`packages/kernel/src/services/unit-of-work.ts`.

The callback receives **transaction-scoped repositories**, not a `tx` handle
threaded through every method signature. A handle is trivially forgotten at one
call site, and the one that matters is the one that moves money. Binding the
repositories makes the mistake unavailable: a repository built on the pool
cannot be reached from inside the block.

`InMemoryUnitOfWork` snapshots each backing map and restores on throw. A double
that silently committed partial work would let an atomicity test pass for the
wrong reason.

### 2. Three commits, and why not one

```
tx A   move into the verifying state                          commit
       resolve context, evaluate                              pure; no I/O
tx B   record evidence + evaluation, CAS into the in-flight
       state, persisting the receipt                          commit
       ── the provider call; money is at risk ──
tx C   CAS out of the in-flight state, record the outcome     commit
```

One transaction spanning the provider call is impossible: the call is not
transactional. So the durable record that we are _about to_ call has to commit
first. That is what converts an invisible crash into a recoverable one.

Committing tx A separately also fixed a Phase 1 quirk that had been patched
over: a capture refusal could not use the `VERIFICATION_DENIED` edge, which
starts from `CAPTURE_VERIFYING`, because the release was still in
`PAYMENT_AUTHORIZED`. It fell back to a same-state write that only persisted
reason codes. The source state is now correct.

### 3. A liveness sweep for transient states

`TRANSIENT_RELEASE_STATES` = `DRAFT`, `VERIFYING`, `VERIFIED`,
`CAPTURE_VERIFYING`, `CAPTURE_APPROVED`. `sweepAbandoned()` aborts any that has
sat past `abandonTransientAfterSeconds`, freeing the authorization.

**Why aborting is safe, precisely.** Each transient state is _entered before_ a
write-ahead commit and _left by_ one. A release sitting in `CAPTURE_APPROVED`
means the commit into `CAPTURE_IN_FLIGHT` did not happen — and that commit
precedes the provider call. So no provider call was made from any of these
states, and there is nothing to reconcile. This is the argument that makes an
unattended abort defensible; without it, aborting would risk discarding a
release whose money had already moved.

The distinction from reconciliation is the whole point:

|                  | transient    | indeterminate    |
| ---------------- | ------------ | ---------------- |
| provider called? | provably not | possibly         |
| safe action      | abort        | ask the provider |
| what it fixes    | liveness     | correctness      |

## Consequences

**Positive.** A crash anywhere in the capture sequence is now recoverable by one
of two sweeps, and which one is determined by a property we can reason about
rather than by guesswork. Evidence and state changes commit together, so there
is no half-recorded decision.

**Negative.** More machinery, and a second background sweep. The in-memory unit
of work's rollback is a snapshot-and-restore, which is correct but would not
scale to a large store — acceptable, since it exists only for tests.

**Honest limitation.** `InMemoryUnitOfWork` is atomic with respect to other
tasks in one process. It cannot model a lock timeout, a serialization failure,
or a partial network write. Only the Postgres suite tests those, and only from a
single process.
