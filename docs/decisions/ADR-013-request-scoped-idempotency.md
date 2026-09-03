# ADR-013: Request-scoped idempotency, alongside release-scoped

- **Status**: Accepted
- **Date**: 2026-09-03
- **Extends**: [ADR-006](ADR-006-idempotency-model.md)

## Context

ADR-006 established two layers: an agent-chosen client key that deduplicates
_requests_, and a server-derived receipt plus a partial unique index that bounds
_money movement_. Both live on the `releases` row.

That covers endpoints which create a release. It does not cover:

- **a crash mid-request.** The client key is written as part of the release row.
  A process that dies before that write leaves no marker at all, so a retry is
  indistinguishable from a first attempt.
- **capture.** Duplicate capture is prevented by the state machine, which is the
  right mechanism — but a client that times out has no way to learn what
  happened other than to ask again and interpret an error.
- **every other mutating endpoint.**

## Decision

A third layer, `idempotency_records`, applied at the HTTP boundary.

|                              | release-scoped (ADR-006)                          | request-scoped (this)                |
| ---------------------------- | ------------------------------------------------- | ------------------------------------ |
| question                     | has this authorization been spent under this key? | has this HTTP request been answered? |
| read by                      | the kernel's execution stage                      | the route                            |
| enforced by                  | `UNIQUE` + partial unique index                   | `PRIMARY KEY` on the key             |
| covers                       | release-creating endpoints                        | every mutating endpoint              |
| survives a crash mid-request | no                                                | yes                                  |

Both are kept. Dropping the release-scoped layer would let a caller vary its key
to get a second charge; dropping this one would leave a timed-out client unable
to learn the outcome.

### Semantics

| case                                  | behaviour                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| same key, same fingerprint, completed | replay the stored response **verbatim**                                                                                    |
| same key, different fingerprint       | `409`, never answered from cache                                                                                           |
| same key, still in flight             | `409 REQUEST_IN_FLIGHT`                                                                                                    |
| crash while in flight                 | the row stays `IN_FLIGHT`; the release sweeps resolve the work, and the stale claim is released on the next failed attempt |

The fingerprint covers the route, the body, **and the authenticated principal**:
the same key presented by a different user is a different request and must not
replay someone else's answer.

Returning `409` for an in-flight duplicate rather than blocking is deliberate.
Waiting would hold a connection open on a request whose outcome we cannot
predict, and a client is better placed than we are to decide how long to wait.

### Called explicitly, not as middleware

`withIdempotency(...)` is invoked by each route. Burying replay semantics in a
plugin would make the most security-relevant behaviour in a money route
invisible at the call site.

## The deliberate non-goal

**This does not make a provider call idempotent.** Razorpay's capture is not
idempotent, and — as [ADR-015](ADR-015-razorpay-reality.md) records — its order
`receipt` does not reject duplicates by default either. No amount of application
bookkeeping changes what the provider does. The release state machine and the
database constraints are what prevent a double capture; this table only prevents
a duplicate _answer_.

## Consequences

**Positive.** Uniform semantics across every mutating endpoint, surviving a
restart. A retrying client gets the same bytes rather than a plausible
reconstruction.

**Negative.** A third layer to reason about, and a stored response per request.
An `IN_FLIGHT` row left by a crashed process blocks that exact key until the
next attempt clears it — acceptable, since the alternative is a duplicate.

**Honest limitation.** The stored response is a snapshot. If a release's state
changes after the response was recorded, a replay returns the older view. That
is the correct idempotency semantic — the same request gets the same answer —
but a client wanting current state should read the release, not replay a POST.
