# ADR-019: Making an operator approval actionable at the capture gate

- **Status**: Accepted
- **Date**: 2026-09-04
- **Extends**: [ADR-018](ADR-018-operator-approval-and-provider-trust.md), which made a gate-1 approval actionable
- **Supersedes nothing.** The gate-1 half of ADR-018 is unchanged.

## Context

Phase 4 found and fixed a defect in which an operator's approval of a release
paused at the **order** gate was unactionable: the agent's retry replayed the
stored `PAUSE` and the order was never created. The fix was correct.

The **capture** gate had the same class of defect, in three independent places,
and none of them was covered by a test. A release that paused at gate 2 could
never be captured — by anyone, ever — regardless of what an operator decided.
The approval flow simply had no terminating path once the pause happened after
the order existed.

The three faults compounded, so fixing any one of them alone changed nothing
observable. That is why they survived a hardening pass: each was individually
invisible.

### 1. The capture gate could not be re-entered

`REVIEW_APPROVED` moves an approved release `PAUSED → CAPTURE_VERIFYING`. But
`CAPTURE_REQUESTED` was declared only `from: ['PAYMENT_AUTHORIZED']`, so the
agent's retry lost the compare-and-set, was reported
`CONCURRENT_RELEASE_IN_PROGRESS`, and the release sat in `CAPTURE_VERIFYING`
until the liveness sweep aborted it.

### 2. The review recorded a binding no capture request could present

`ReviewRecord.snapshotHash` holds a _request fingerprint_ (the name is a known
wart, kept because renaming a persisted field is not worth the churn). It was
populated from `release.requestFingerprint` — the fingerprint computed at the
**order** gate, which never changes for the life of the release.

A fingerprint names the gate as well as the authorization, snapshot and
principal. So a review opened at the capture gate recorded a binding that no
capture request could ever present, `approvalCovers` compared the two, found
them different, and correctly refused to apply an approval that was, by its own
record, for something else.

### 3. The kernel asked for the wrong approval

`findLatestApprovedByRelease` selected by recency. A release that paused at both
gates carries two approvals; "latest" is a proxy for "the one that applies", and
in the flow above it returned the **order-gate** approval to the capture gate
while a valid capture-gate approval sat unused.

A fourth, smaller fault sat underneath: reviews were given ids derived from the
release (`rev_${releaseId.slice(4)}`), so a second review for the same release
collided with the first. Postgres has `ON CONFLICT (review_id) DO NOTHING` and
silently dropped it — the queue then showed a `PAUSED` release with no review to
resolve. The in-memory store overwrote instead, destroying a resolved review's
record and diverging from Postgres on an audited path.

## Decision

**1. Declare `CAPTURE_VERIFYING` as a source of `CAPTURE_REQUESTED`.**

This is a re-entry, not a retry, and the distinction is the one the release
machine already rests on. Non-terminal states are classified as _transient_
(provider provably not called) or _indeterminate_ (provider may have acted);
`CAPTURE_VERIFYING` is transient, because the write-ahead commit that precedes
any capture moves out of `CAPTURE_APPROVED`. Rule 26 ("never widen a
compare-and-set's source-state list") is about the indeterminate case, and does
not reach this one.

At-most-once execution is unaffected. It never rested on the gate-entry
compare-and-set; it rests on `CAPTURE_ALLOWED` and `CAPTURE_CALL_STARTED`, both
of which still admit exactly one caller. The execution stage already listed
`CAPTURE_VERIFYING` among the states the capture gate may run from — the machine
and the stage agreed all along, and only the service disagreed.

**2. Bind a review to the fingerprint of the request that actually paused.**

Not to the release's stored one. This is also the narrower rule: an approval
applies to a retry of exactly the request a human was shown, at the gate they
were shown it at, and to nothing else. Re-quoting or moving gate invalidates it,
which is what an approval being _bound_ is supposed to mean.

**3. Look approvals up by binding, not by recency.**

`findLatestApprovedByRelease` is replaced by
`findApprovedByReleaseAndBinding(releaseId, boundTo)`. The kernel's question is
"is there an approval for _this_ request?", and asking it directly cannot return
an approval for a different one. `approvalCovers` still re-checks the binding: a
security property that rests on a caller's query being written correctly is one
refactor away from being lost.

**4. Give each review its own id**, from `newReviewId()`.

## Consequences

- An operator approval at the capture gate now results in a capture, and the
  kernel still runs a third time against fresh live state before money moves. A
  price that changed while the operator deliberated still refuses the capture —
  asserted by `9-operator-approval-does-not-override-reality`.
- An approval no longer travels between gates, and the mechanism that stops it
  is now the recorded binding rather than an accident of which fingerprint was
  stored.
- A release that pauses twice carries two reviews, two approvals and two
  attributed operators in evidence, and both survive.
- `findLatestApprovedByRelease` is gone rather than deprecated. Leaving an
  accessor that returns "an approval, which may not be the applicable one" is
  the kind of convenience helper that reintroduces this defect.

## What this did not change

- No stage was added, removed or reordered; the kernel is untouched.
- No verdict was weakened. The approval mechanism is exactly as narrow as it
  was — `approvalCovers` still requires a matching fingerprint, still requires
  every pause finding to have been one the reviewer saw, and still refuses to
  downgrade anything in the presence of a DENY.
- Persisted field and column names are unchanged.

## Related, found in the same pass

- **The attempt counter double-counted.** `attemptsInWindow` was
  `attemptCount + 1`, but both gates commit their entry transition with
  `incrementAttempt` _before_ the kernel runs, so the current attempt was
  counted twice. A release's first request reported two attempts, and the
  default limit of three was reached an attempt early — which made this very
  flow trip `RETRY_VELOCITY_EXCEEDED` on the approved retry, pausing again for a
  finding no operator had been shown.
- **`RETRY_VELOCITY_EXCEEDED` is not a rate limit** and its description said it
  was. No per-attempt timestamps are persisted, so `velocityWindowSeconds`
  bounds nothing. The code keeps its name — the vocabulary is closed and codes
  are never repurposed — and its description now says what it measures. Making
  it a real sliding window needs per-attempt timestamps, which is a schema
  change and a separate decision.
- **The refusal override could soften a DENY.** It exists to stop a caller that
  lost a race being told `ALLOW`; applied unconditionally, it also rewrote the
  kernel's `DENY` into a `PAUSE`, so a duplicate capture of an already-captured
  release answered `202 Accepted`. To a client reading status codes, "accepted,
  pending" invites the retry the state machine had just refused. The override
  now lowers a verdict and never softens one.
