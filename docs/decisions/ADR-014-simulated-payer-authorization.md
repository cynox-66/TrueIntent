# ADR-014: The simulated payer authorization, and what it proves

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

Nothing in the production code path can drive a release to `PAYMENT_AUTHORIZED`
except a signature-verified webhook from the provider. That is correct — a
release should not advance toward money moving because someone asked nicely —
but it meant the end-to-end flow could not be exercised at all. Every Phase 1
test reached into the repository through a helper and wrote the state directly,
which proves nothing about the path a real payment takes.

The real alternative needs a hosted checkout, a publicly reachable webhook URL,
and a human with a test card. None of that runs headless, in CI, or inside a
scenario engine.

## Decision

`POST /v1/dev/simulate-authorization`, and a matching path in the scenario
harness. It does **not** write state. It:

1. seeds an authorized payment on the fake provider,
2. builds a Razorpay-shaped `payment.authorized` payload,
3. signs it with the **real** webhook secret, over the exact bytes,
4. delivers it to the **real** `/v1/webhooks/razorpay` route.

The signature is verified, the inbox claims the event id, and the state machine
decides whether the transition is legal. The response returned to the caller is
whatever the webhook route said — including `DUPLICATE_IGNORED` or
`OUT_OF_ORDER_IGNORED` — rather than a synthetic success.

Two independent guards: the route is not registered unless the provider is the
fake **and** the environment is not production, and the handler re-checks. One
guard is one thing to accidentally remove.

## What this proves, and what it does not

**Proves.** That webhook signature verification, inbox deduplication, event
correlation to a release, the FSM transition check, and evidence recording all
work on the real code path — because that is the code that runs.

**Does not prove.** That Razorpay's actual `payment.authorized` payload matches
the shape assumed here, that its delivery semantics match, or that a real
hosted checkout produces the payment ids expected. The webhook _envelope_ shape
is taken from Razorpay's published documentation and verified against the
signature scheme; the surrounding integration is not exercised.

Calling this an end-to-end test of Razorpay would be false. It is an end-to-end
test of CaptureLock, with the provider replaced by a double that reproduces its
documented and (for orders) measured semantics.

## Alternatives rejected

- **Writing `PAYMENT_AUTHORIZED` directly in a test helper.** What Phase 1 did.
  Fast, and it exercises none of the code that would actually run.
- **A production-capable "advance release" endpoint.** Any endpoint that can move
  a release toward money without provider evidence is precisely the bypass this
  system exists to prevent, regardless of how it is guarded.
- **Requiring real hosted checkout for all testing.** Correct fidelity,
  unusable in CI or in a scenario suite.

## Consequences

**Positive.** The full lifecycle is executable, repeatable, and headless, and it
runs the production code path.

**Negative.** A development-only route exists. It is unregistered outside
development, double-guarded, and refuses to operate without a webhook secret —
but it exists, and that is a surface to keep an eye on.
