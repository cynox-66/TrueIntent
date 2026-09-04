# ADR-016: Live capture verification — what was measured, and what was not

- **Status**: Accepted (complete: the full authorize → capture lifecycle was run live)
- **Date**: 2026-09-04
- **Extends**: [ADR-015](ADR-015-razorpay-reality.md), which measured Razorpay's _order_ semantics
- **Environment**: one `rzp_test_` account, Razorpay test mode, 2026-09-03/04

## Context

The Phase 2 report named its own largest gap plainly: order semantics had been
measured against the live API and two documented behaviours turned out to be
false, while the _capture_ half rested entirely on documentation. Phase 3 set
out to close that gap with the same method — run it and see.

Three things were found before a single payment existed, and one of them is
architectural.

## Findings — OBSERVED against the live API

### 1. `payment_capture` was never sent, and its default can bypass the capture gate

`RazorpayTestClient.createOrder` sent `amount`, `currency`, `receipt` and
`notes`. It did **not** send `payment_capture`, so the value fell through to
Razorpay's account-level setting.

If that setting is auto-capture — a common default — a payment moves
`created → captured` when the payer completes checkout and **never passes
through `authorized`**. For CaptureLock that is not a tuning detail. The capture
gate is the gate the product is named after, and it would have nothing left to
gate: the provider would have moved the money before our second verification
ran. The two-gate design would be intact in code and bypassed in practice.

Two supporting observations make the fix safe rather than speculative:

```
POST /v1/orders  {"...","not_a_real_field":true}
  -> HTTP 400 {"error":{"code":"BAD_REQUEST_ERROR",
               "description":"not_a_real_field is/are not required and should not be sent",
               "reason":"extra_field_sent"}}

POST /v1/orders  {"...","payment_capture":0}
  -> HTTP 200, order created
```

The Orders API rejects unknown fields, so acceptance of `payment_capture` proves
it is a genuinely recognised parameter rather than one silently discarded.

**Decision.** Send `payment_capture: 0` on every order, explicitly. A property
the entire architecture depends on must not be inherited from a dashboard toggle
that someone can flip without touching this repository.

### 2. A 4xx from the capture endpoint may carry no Razorpay error envelope

```
POST /v1/payments/pay_NONEXISTENT0000/capture
  -> HTTP 404 {"message":"no Route matched with those values"}

POST /v1/payments/pay_ABCDEFGH12345678/capture     (well-formed, non-existent)
  -> HTTP 404 {"message":"no Route matched with those values"}
```

No `error` object at all. That is the API gateway declining to route, not
Razorpay's payments service refusing a payment.

The adapter mapped any non-2xx to `REJECTED`, and `REJECTED` becomes
`CAPTURE_REJECTED`, which is **terminal**. The same gateway response would
appear if the route were renamed, if the path were built wrongly, or if the
gateway were misconfigured — cases where the payments service never saw the
request and equally may have. Reading it as a definitive refusal would
terminally reject releases whose payments are perfectly fine.

For contrast, a genuine business-level refusal _does_ carry the envelope:

```
GET /v1/payments/pay_NONEXISTENT0000
  -> HTTP 400 {"error":{"code":"BAD_REQUEST_ERROR",
               "description":"The id provided does not exist",
               "reason":"input_validation_failed"}}
```

**Decision.** A 4xx **with** an error envelope reached Razorpay's business logic
and is definitive → `REJECTED`. A 4xx **without** one is a routing response and
tells us nothing → `INDETERMINATE`. This is the same
provably-not-called / possibly-called distinction the release machine already
rests on, applied one layer lower.

### 3. Server-to-server payment creation is not available

```
POST /v1/payments/create/upi
  -> HTTP 400 {"error":{"description":"The requested URL was not found on the server."}}
```

So an authorized payment can only be produced through hosted checkout. That
human step is preserved rather than faked — see
[ADR-014](ADR-014-simulated-payer-authorization.md) for why fabricating one and
calling the result "live verification" would defeat the purpose.

Confirmed working around it: Razorpay Checkout loads against a
`payment_capture: 0` order, displays the correct server-computed amount
(₹4,949.00) and shows Razorpay's own **Test Mode** banner. The webhook is
registered on the account for `payment.authorized`, `payment.captured` and
`payment.failed`, pointing at the tunnel and at the path this API actually
serves (`/v1/webhooks/razorpay`, verified rather than assumed).

### 4. A configuration bug that made live testing silently impossible

`import 'dotenv/config'` resolves `.env` relative to the **current working
directory**, and `pnpm dev` runs the API with cwd `apps/api`, where no `.env`
exists. The server therefore came up reporting `paymentProvider: fake` and
answered every webhook with `WEBHOOKS_NOT_CONFIGURED`, while a fully populated
`.env` sat at the repository root being ignored.

This is worth recording because of its shape: not a crash, but a silent
downgrade to the safe default. A developer would reasonably believe they were
testing against Razorpay while testing against a fake. Both entry points now
resolve `.env` from their own module location.

## Findings — the live lifecycle, OBSERVED end to end

A complete lifecycle was subsequently run against the same test account:

```
order   order_TXpI1qz1g3l8oE      release rel_a547c6daab34449caff591d650a24883
        INR 4,949.00, created by the adapter with payment_capture: 0
```

### 5. `payment_capture: 0` genuinely produces an authorized payment

This was the one that mattered, because parameter acceptance is not behaviour.
Immediately after hosted checkout completed, and **before** CaptureLock's
capture gate ran:

```
GET /v1/payments/pay_TXpKvpNJxmw96z
  -> status: authorized   captured: false   amount: 494900   method: card
GET /v1/orders/order_TXpI1qz1g3l8oE
  -> status: attempted    amount_paid: 0    amount_due: 494900
```

The payment stopped at `authorized` and no money had moved. The two-gate design
is therefore reachable in practice, not merely in code: Razorpay held the funds
and waited for us. Had the account default applied, this read would have said
`captured` and the capture gate would have had nothing left to gate.

### 6. The capture gate runs before the provider call, and exactly once

The gate then ran and allowed the capture. The evidence chain for the
authorization records the ordering directly:

| seq | kind             | gate           | verdict |
| --- | ---------------- | -------------- | ------- |
| 0   | DECISION         | ORDER_CREATION | ALLOW   |
| 1   | PROVIDER_OUTCOME | ORDER_CREATION |         |
| 2   | WEBHOOK          |                |         |
| 3   | DECISION         | CAPTURE        | ALLOW   |
| 4   | WEBHOOK          |                |         |
| 5   | PROVIDER_OUTCOME | CAPTURE        |         |
| 6   | DECISION         | CAPTURE        | DENY    |

Exactly one `CAPTURE` decision allowed money to move (seq 3), and the provider
outcome that recorded it (seq 5) comes after it, never before. Chain
verification returned `valid: true` over all seven envelopes with no defects,
and replaying the capture decision reproduced its hash (`reproduced: true`).
Final provider truth: `order.status: paid`, `amount_paid: 494900`,
`amount_due: 0`, `attempts: 1`.

The second capture attempt (seq 6) was refused by the state machine with
`AUTHORIZATION_ALREADY_CONSUMED` and `INVALID_RELEASE_STATE_FOR_GATE`, and never
reached the provider.

### 7. The exact duplicate-capture wording — the prose-matching risk, closed

Re-capturing the payment directly, at the provider:

```
POST /v1/payments/pay_TXpKvpNJxmw96z/capture
  -> HTTP 400 {"error":{"code":"BAD_REQUEST_ERROR",
               "description":"This payment has already been captured",
               "source":"NA","step":"NA","reason":"NA",
               "metadata":{"payment_id":"TXpKvpNJxmw96z"}}}
```

`source`, `step` and `reason` are all the literal string `"NA"`, so none of them
distinguishes this from any other `BAD_REQUEST_ERROR`. The description prose
really is the only signal, which vindicates the adapter's approach and the
warning attached to it. The observed text matches the first marker the adapter
already carried; it maps to `ALREADY_CAPTURED`, and a follow-up read confirmed
the amount did not move twice. Pinned as a regression fixture in
`razorpay-live-responses.test.ts`.

### 8. The published generic test card is refused by a domestic-only account

The first live attempt failed, and the reason is worth recording because the
number is widely copied:

```
GET /v1/payments/pay_TXobQg0wCMJMJy
  -> status: failed   international: true
     error_reason: international_transaction_not_allowed
     error_source: business
     error_description: "...this business accepts domestic (Indian) card
                        payments only. Try another payment method."
```

`4111 1111 1111 1111` is not on Razorpay's published test-card list at all;
their BIN table classifies it `international: true`, and accounts configured for
domestic acceptance refuse it before authorization. The harness now names
Razorpay's published **domestic** card, `4100 2800 0000 1007`.

This also exercised a real path usefully: the failure arrived as a signed
`payment.failed` webhook, was verified and recorded in the inbox, and drove the
release to `FAILED`.

### 9. The default snapshot TTL makes a human checkout structurally impossible

The first successful authorization was then **denied** at the capture gate:

```
verdict DENY   state DENIED   money moved false   reasonCodes ["SNAPSHOT_EXPIRED"]
```

`SNAPSHOT_TTL_SECONDS` defaults to 30 seconds. Hosted checkout takes minutes,
so the snapshot expires while the payer is still typing, and every live run
would deny at gate 2 no matter how correct everything else was.

This is the freshness guard working exactly as designed — it refused to capture
against a stale price, and the authorized payment was left uncaptured for
Razorpay to void — so nothing here argues for weakening it. But 30 seconds is a
window chosen for machine-speed flows, and it is a policy value, not a safety
invariant. The live run set `SNAPSHOT_TTL_SECONDS=900`, which stays inside the
authorization's own `maxSnapshotAgeSeconds: 3600`; the stage still runs and
still enforces whatever window it is given. **No code was changed for this.**

Worth noting that this denial is itself a result: a live, genuinely authorized
payment was refused by gate 2 and the money did not move.

## Consequences

**Positive.** Two real defects fixed before they could reach anything. The
capture-gate bypass in particular would have been invisible in every test,
because the fake provider does exactly what we intended rather than what the
account setting dictates.

**Negative.** Live capture verification cannot run unattended: hosted checkout
is the only route to an authorized payment, and Razorpay's card fields sit in a
nested PCI iframe that browser automation cannot type into. One human step per
live run is therefore structural, not a gap to be closed later.

**Honest limitations.**

- Observed on **one account, on one day**. Account-level settings differ, and
  the `payment_capture` default is precisely such a setting.
- **Test mode is not production.** Nothing here justifies a claim about live
  Razorpay behaviour.
- The gateway-404 reading is a judgement about an _ambiguous_ response, chosen
  because the alternative failure is worse. If Razorpay later returns a proper
  envelope for a non-existent payment, that case becomes definitive and the
  mapping should tighten.
- **One lifecycle is not a guarantee.** The capture path was exercised once,
  with one card, on one account. It establishes that the design works against
  the real provider; it does not establish a rate, a distribution of failure
  modes, or behaviour under any other account configuration.
- A capture with the **wrong amount** remains documented but unobserved: the
  payment was terminal by the time that probe would have run.
- The `INDETERMINATE` returned for a gateway 404 is labelled
  `cause: 'UNKNOWN_5XX'`. The state-machine outcome is correct; only the cause
  label is imprecise, and it is cosmetic.
