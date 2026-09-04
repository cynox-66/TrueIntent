# ADR-018: What an operator approval means, and how far a signed webhook is trusted

- **Status**: Accepted
- **Date**: 2026-09-04
- **Context**: pre-demo red-team and reliability pass over the complete system

## Context

The system was reviewed as a whole against a malicious agent, an unreliable
provider, and a hostile browser. Most attack classes were already closed and are
listed at the end. Two things were not, and both were reachable in the committed
code rather than hypothetical.

## 1. An operator approval did nothing

**The defect.** `ReviewService.resolve` moved a `PAUSED` release to
`CAPTURE_VERIFYING` and appended an evidence envelope. Nothing else happened.
The verification kernel had no notion of a review: `VerificationContext` carried
no approval, so re-verification recomputed the identical findings and returned
the identical `PAUSE`. The release paused again, a fresh review was opened, and
the loop had no exit.

Both retry routes were closed independently:

- **Same idempotency key** — the HTTP idempotency record replayed the stored
  `PAUSE` response verbatim, so the request never reached the domain at all.
- **A different key** — `insert` refused with `AUTHORIZATION_BUSY`, surfaced as
  `AUTHORIZATION_HAS_ACTIVE_RELEASE`, because a non-terminal release already
  held the authorization's only active-release slot.

And for a release paused at **gate 1** there was a third problem underneath
both: `REVIEW_APPROVED` sent every pause to `CAPTURE_VERIFYING`, but a gate-1
pause has no order and therefore no payment, so the capture gate refused with
`INVALID_RELEASE_STATE_FOR_GATE` and the release went to `DENIED`. An operator's
approval produced a permanent denial.

The operator console shipped in `a967c50` presented all of this as a working
workflow. It was not one.

**Decision.** An approval is now a fact the kernel consumes, bounded four ways:

```
verdict is PAUSE (never DENY)
  AND an APPROVED review exists for this release
  AND its binding equals this request's fingerprint
  AND every PAUSE-severity finding is one the reviewer saw
    ⇒ ALLOW, with REVIEW_APPROVAL_APPLIED recorded
```

Each condition earns its place:

- **Never a DENY.** `approvalCovers` filters DENY findings explicitly even
  though it is only reached on a PAUSE. Relying on a caller's precondition for a
  security property is how that property gets lost.
- **Bound to the request fingerprint** — a hash over authorization, snapshot and
  gate. A re-quote produces a new snapshot and a new fingerprint, so an approval
  cannot follow a cart the reviewer never saw; and a gate-1 approval does not
  carry to gate 2, where they saw nothing. (`ReviewRecord` stores this value in
  a field named `snapshotHash`. The name predates the fingerprint; the value has
  always been the fingerprint, and the misleading name is recorded here rather
  than renamed, because the column is written by code paths this pass did not
  need to touch.)
- **Every pause finding must be covered.** A price that moved while the human
  deliberated is a new fact they did not consent to, and still pauses. Consent
  to one finding is not a blanket waiver.
- **Latest approval only.** A release can pause more than once; the current
  decision is the one that counts.

Supporting changes, each the smallest that made the property reachable:

- `REVIEW_APPROVED_AT_ORDER_GATE` (`PAUSED → VERIFYING`) alongside the existing
  `REVIEW_APPROVED` (`PAUSED → CAPTURE_VERIFYING`). `ReviewService` picks by
  `providerOrderId === null`, which is set by the order gate and by nothing else.
- `requestOrderCreation` no longer replays a stored answer when the release is
  back in `VERIFYING`. There is no concluded answer to replay in that state, so
  this is not a weakening of idempotency but the absence of anything to be
  idempotent about; concurrency is still handled by the compare-and-set
  transitions.
- `IdempotencyStore.forget`, called by the review-resolution route for that
  release's own client key after a resolution it just performed. Narrower than
  `abandon`: it discards a _completed_ response deliberately, because an
  operator has overruled it. Every other key's replay protection is untouched.

**What is deliberately NOT checked:** whether the operator _should_ have
approved. That is their judgement. The system's job is to bind it to one cart,
one gate and one set of reasons, and to record who did it — not to second-guess
it.

## 2. A signed webhook was trusted about more than the signature proves

**The defect.** The HMAC proves the sender holds the webhook secret. It does not
prove the entity inside belongs to the release it addresses, and the ingest path
conflated the two: it adopted whatever `payment_id` the event carried and would
even rewrite `providerOrderId` from the event
(`providerOrderId: event.orderId ?? release.providerOrderId`). The amount was
never read at all.

The capture gate later presents `release.providerPaymentId` to the provider with
**this release's** amount, read off the grant. So a misrouted, duplicated or
mis-serialized event would bind a payment CaptureLock never created an order
for. In the benign case the provider refuses on an amount mismatch and a
perfectly good release becomes terminally `CAPTURE_REJECTED`; in the case where
the amounts happen to agree, CaptureLock captures a payment belonging to
something else.

This is squarely inside the stated threat model — "assume Razorpay behaves
unexpectedly … provider IDs that do not match the expected release" — and needs
no attacker who can forge a signature.

**Decision.** Before applying any event, the release's own recorded identifiers
are the authority. An event whose order id, payment id, amount or currency
contradicts the release is recorded with `WEBHOOK_ENTITY_MISMATCH` and refused.
`providerOrderId` is now only ever set, never rewritten.

Tolerant of absence, intolerant of contradiction: a field the provider did not
send cannot be checked and is not treated as a mismatch, because refusing
legitimate events is its own failure mode.

## 3. Unbounded nonce retention (minor)

`GuardedPaymentExecutor` retained every consumed grant nonce for the life of the
process. Expiry is checked _before_ the consumed set, so a nonce past its expiry
was already unusable and retaining it bought nothing — it was a slow leak in a
service meant to run for months. Entries are now evicted once expired, swept on
write so the executor owns no background work. Single-use enforcement for live
grants is unchanged and still tested.

## Consequences

**Positive.** The operator workflow the console was built around now functions,
and its authority is bounded and recorded. The provider boundary no longer
extends trust from "this sender knows the secret" to "this payload is about this
release."

**Negative.** `combine` now takes options and is no longer a pure function of
stage results alone. That is a real loss of simplicity in the most
security-sensitive file in the repository, accepted because the alternative was
an approval mechanism that could not work. The downgrade is confined to one
function, `approvalCovers`, which is written to be read in one sitting.

**Replay compatibility.** The approval is serialized into the evidence context,
so an approved decision reproduces on replay; without that, every
operator-approved ALLOW would fail its own replay check and look like tampering.
Envelopes written before this change carry no `approvedReview`, and
deserialization normalizes the absent field to `null` — which is exactly what
those decisions assumed — so historical evidence still replays.

## Attack classes reviewed and already closed

Verified against the code rather than assumed, and left unchanged:

- An agent cannot mint its own authorization (issuer authority, header-borne).
- An agent cannot resolve its own review or force reconciliation (operator
  authority); attribution is read from the authenticated header and a
  body-supplied `resolvedBy` is rejected by a strict schema.
- An agent cannot reach the provider: `ExecutionGrant`'s brand is a
  module-private `unique symbol`, `mintGrant` returns `null` for anything but
  ALLOW, and the raw provider is private to `GuardedPaymentExecutor`. Amount and
  receipt are read off the grant, never the caller's request.
- An agent cannot act on another user's authorization (`USER_MISMATCH` /
  `SESSION_MISMATCH` in the authority stage, both gates).
- Duplicate capture is prevented by the state machine, not by the idempotency
  key: after a capture the release is not in a state the capture gate may run
  from.
- Indeterminate provider outcomes stay recoverable and are never converted to
  terminal failure; a 4xx without a Razorpay error envelope is INDETERMINATE.
- Evidence append serializes per chain under an advisory transaction lock with
  `UNIQUE (chain_id, sequence)` behind it, and the schema rejects UPDATE and
  DELETE by trigger.
- Every request schema is `.strict()`, so unknown fields are rejected rather
  than ignored.
- The console renders backend strings through React's escaping with no
  `dangerouslySetInnerHTML` anywhere, and never logs or stores the operator key.
