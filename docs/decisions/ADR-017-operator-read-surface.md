# ADR-017: The operator read surface

- **Status**: Accepted
- **Date**: 2026-09-04
- **Context**: Phase 4 backend foundation, ahead of the operator console

## Context

Everything an operator can _do_ already existed: `POST /v1/reviews/:id/resolve`
and `POST /v1/releases/:id/reconcile`, both behind operator authority, both
taking attribution from an authenticated header rather than the request body.

Nothing an operator needs to _see_ existed. There was no way to ask "which
releases need a human", and no way to read an evidence chain as a sequence —
only to verify it, or to fetch one envelope by id. An operator could act on a
release whose id they already knew, and had no way to learn the id.

## Decisions

### 1. "Needs an operator" is derived, not restated

`OPERATOR_ATTENTION_RELEASE_STATES` is composed from the existing domain sets:

```ts
export const OPERATOR_ATTENTION_RELEASE_STATES = [
  'PAUSED',
  ...INDETERMINATE_RELEASE_STATES,
] as const satisfies readonly ReleaseState[];
```

Writing the five state names out by hand would have created a second list to
keep in step with the state machine, and the failure mode of that drift is
silent: a state added to the machine simply never appears in the queue, and the
release waits forever because nobody is told about it. A test asserts the exact
membership, so adding a state to the domain set fails loudly here.

### 2. The queue is not `findRequiringReconciliation`

The obvious shortcut was to reuse the sweeper's query. It is the wrong question.

`findRequiringReconciliation` is time-based — "stuck long enough to chase
automatically" — and it excludes `PAUSED` entirely, correctly, because a paused
release is not stuck: it is waiting exactly as designed. An operator queue built
on it would have shown reconciler backlog and hidden every review, which is the
one thing the console exists to surface.

So `listRequiringOperatorAttention(limit)` is a separate port method with no age
threshold. An operator looking at the queue wants a paused release the moment it
pauses, not after a sweep interval.

### 3. Ordering is total, because the queue is capped

`ORDER BY updated_at ASC, release_id ASC`, and the in-memory implementation
sorts the whole set before slicing rather than taking the first _n_ in insertion
order.

The tiebreak is not decoration. Several releases can pause in the same
millisecond under load; without a total order Postgres may return colliding rows
in any order, and a capped query would then drop a different one on each
refresh — an item could vanish from the queue and reappear without anything
having changed. Both suites assert stability across repeated calls.

`OPERATOR_QUEUE_LIMIT` is 200 and there is deliberately no pagination. A queue
longer than that means the operators are already underwater and the honest fix
is fewer paused releases, not a second page. The cap exists so one enormous
backlog cannot turn a console refresh into an unbounded query.

### 4. The queue is an index, not a detail view

Each row carries what is needed to triage and to navigate — state, `waitingOn`,
amount, reason codes, timestamps, the open review's id and reason codes — and
nothing more. The caller follows `releaseId` and `authorizationId` to the
existing detail and evidence endpoints.

Copying whole release, authorization or evidence records into the queue would
give the console a second source of truth that ages badly, and would make the
queue's response shape change every time an unrelated record gained a field.

`waitingOn` is `REVIEW` or `RECONCILIATION`. The two kinds of waiting are not
interchangeable: one is resolved by a human decision, the other by asking the
provider what happened. Conflating them would put the wrong action in front of
the operator.

### 5. `/v1/operator/*` requires operator authority

`GET /v1/operator/queue` uses the existing `hasAuthority` helper and the existing
`x-capturelock-operator-key`. No new authentication mechanism.

The reasoning differs from the other operator routes. `reconcile` and `resolve`
are protected because they **act**. The queue is protected because it
**enumerates**: a lookup by opaque release id reveals one release to somebody who
already had its id, whereas a queue hands over the entire live worklist —
what is paused, why, and for how long. That is precisely the map an attacker
would want, and precisely the map the party being checked should not hold.

Tests assert that a principal, an issuer key, a wrong key, and an operator name
supplied in the query string are each refused.

### 6. Read-by-id endpoints keep their existing semantics

`GET /v1/releases/:id`, `GET /v1/authorizations/:id`, `GET /v1/evidence/:id` and
`GET /v1/evidence/chain/:id/verify` remain unauthenticated, as they were.

This is recorded as a **known gap, not an endorsement**. Their safety currently
rests on release and authorization ids being unguessable, which is a weaker
property than an authority check and is not one the code states anywhere.
Tightening them is a repository-wide authorization change with its own blast
radius — every existing caller, the eval harness, the scenarios — and bundling
it into the operator surface would have made this change hard to review. It
should be addressed on its own.

`GET /v1/evidence/chain/:id` joins them at the same level rather than being
protected while its neighbours are not, which would have been an inconsistency
pretending to be a boundary.

### 7. The evidence timeline serializes; it does not reinterpret

`GET /v1/evidence/chain/:id` returns `listByChain` output directly, plus the
chain head. The envelope **is** the record: a console rendering a UI-shaped
projection would be rendering a claim about the evidence rather than the
evidence, and the hash linkage that makes it a chain would be something the
frontend asserted rather than something the reader can check.

Replay and verification are not duplicated. `GET /v1/evidence/:id` remains the
only replay implementation and `.../verify` the only verification. A test asserts
the two endpoints agree on the head hash and the envelope count — if they ever
disagree, one of them is lying.

An unknown chain returns an empty list, not a 404: "this authorization has
produced no evidence yet" is true and useful, and it is the same answer the
verify route already gives.

## A parity bug this work found

The Postgres suite failed on first run with:

```
duplicate key value violates unique constraint "reviews_one_open_per_release"
```

Postgres carries a partial unique index — `ON review_requests (release_id) WHERE
state = 'OPEN'` — that `InMemoryReviewRepository.insert` did not model. The fake
happily accepted a second open review for the same release; production cannot
hold that state.

The shape is the same one Phase 3 hit with `payment_capture`: a fake that agrees
with our expectations while the real store disagrees, so tests exercise a world
that does not exist. Two open reviews for one release would mean two live
decisions, and resolving either would leave the other dangling.

The in-memory repository now raises on that insert, matching Postgres, and both
suites assert it. `InMemoryReleaseRepository` already modelled its equivalent
index (`releases_one_active_per_authorization`); the review repository had simply
been missed.

This is also the argument for writing the Postgres tests at the same time as the
in-memory ones rather than afterwards. The in-memory suite passed throughout.

## Consequences

**Positive.** The console can be built against real contracts. The queue's
membership is tied to the state machine rather than to a list someone must
remember to update. One genuine fake-vs-Postgres divergence is closed.

**Negative.** `/v1/operator/queue` issues one `findOpenByRelease` per queued
release. Bounded by `OPERATOR_QUEUE_LIMIT`, so at most 200 small indexed lookups,
and correct by construction because it reuses the existing accessor — but it is
N+1, and if the cap ever rises it should become a single query.

**Known gaps.**

- Read-by-id endpoints remain unauthenticated (§6).
- No pagination (§3). Deliberate, and revisit only if a real backlog exceeds the
  cap.
- The queue reports what is waiting, not what reconciliation currently believes
  about it. An operator can force reconciliation and read the outcome, but the
  queue itself does not carry the reconciler's last finding.
