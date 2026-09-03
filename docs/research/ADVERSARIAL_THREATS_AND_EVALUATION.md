# Adversarial Threats, Behavioral Trajectories, and Rigorous Evaluation

## 1. Adversarial Agent Behaviors in Autonomous Commerce

Autonomous shopping agents face adversarial interactions from multiple directions:

1. **Adversarial Merchants**: Inserting prompt injection attacks into product listings, metadata, or return policies to force higher-margin purchases.
2. **Compromised Models / Hallucinations**: An agent entering an infinite tool-calling loop, executing rapid retries upon receiving transient errors, or altering user parameters.
3. **Price & Discount Probing**: An agent systematically probing discount endpoints to discover merchant discount ceilings.

### Behavioral Trajectory Guard

CaptureLock models agent actions as a trajectory over time:

- **Velocity Counters**: Per-session tracking of catalog queries, merchant transitions, cart mutations, and capture attempts.
- **Circuit Breakers**: Implemented as a per-authorization attempt velocity guard
  (`RETRY_VELOCITY_EXCEEDED`, default 3 attempts per 60s), which yields **PAUSE**
  rather than DENY — a retry storm may sit on top of a perfectly legitimate
  transaction, and a human should decide. Merchant-switch counting was not
  implemented: the merchant allowlist in the authorized intent already refuses an
  unapproved merchant outright, which is a stronger control than counting
  switches.

---

## 2. Exactly-Once Payment Execution Mechanics

> [!IMPORTANT]
> **The sequence diagram below is wrong for Razorpay specifically, and the
> heading overstates the guarantee.**
>
> It shows a retried request returning the cached order. Razorpay's Orders API
> rejects a duplicate `receipt` rather than returning the existing order, and its
> capture endpoint is not idempotent at all — a second capture returns HTTP 400.
> So recovery is a _lookup_, never a retry: `GET /v1/orders?receipt=` and
> `GET /v1/payments/:id`.
>
> What is actually implemented and claimed: **at-most-once money movement**, plus
> **eventually-consistent knowledge of settlement**. Not exactly-once end to end —
> after an indeterminate capture, whether money moved is unknown until
> reconciliation succeeds.
> See [ADR-005](../decisions/ADR-005-release-state-machine.md) and
> [ADR-006](../decisions/ADR-006-idempotency-model.md).

In distributed financial architectures, networks are inherently unreliable:

- Client drops connection after capture request dispatched.
- Payment gateway executes charge successfully, but acknowledgment drops.
- Payment gateway dispatches duplicate webhook events across multiple servers.

```
CLIENT / AGENT                         CAPTURELOCK                         RAZORPAY
      │                                     │                                  │
      │── POST /authorize_capture ─────────►│                                  │
      │   (idempotency_key = K1)            │── POST /orders (key = K1) ──────►│
      │                                     │◄── Order Created (order_123) ────│
      │◄── Response (Order ID) ─────────────│                                  │
      │                                     │                                  │
      │ [Network Flake / Client Retry]      │                                  │
      │── POST /authorize_capture (K1) ────►│                                  │
      │                                     │ [Idempotent match in releases]   │
      │◄── Cached Order (order_123) ────────│ (No new Razorpay order created)  │
      │                                     │                                  │
      │                                     │◄── Webhook: payment.captured ────│
      │                                     │    (event_id = evt_abc)          │
      │                                     │ [Inserted into webhook_inbox]    │
      │                                     │ [Release status -> CAPTURED]     │
      │                                     │                                  │
      │                                     │◄── Webhook Replay: (evt_abc) ────│
      │                                     │ [Unique constraint violation!]   │
      │                                     │ [Ignored duplicate - 200 OK]     │
```

---

## 3. Replayable Evidence Ledgers

Post-transaction disputes in agentic commerce require non-repudiation:

- Did the agent alter the order, or did the merchant alter the price?
- What was the exact user prompt at the time of authorization?
- What were the merchant's exact catalog values when the payment moved?

CaptureLock answers this via **hash-chained evidence envelopes**:
$$E_n = \text{Envelope}(S_n, H(E_{n-1}), \text{IntentSnapshot}, \text{CartSnapshot}, \text{LiveDigest}, \text{Verdict})$$
$$H(E_n) = \text{SHA-256}(\text{CanonicalJSON}(E_n))$$

Any dispute reviewer or auditor can run an offline replay tool (`capturelock verify <envelope_id>`) to re-evaluate the inputs against the compiled policy and verify that the verdict is mathematically reproducible.
