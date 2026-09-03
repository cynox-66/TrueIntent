# Adversarial Threats, Behavioral Trajectories, and Rigorous Evaluation

## 1. Adversarial Agent Behaviors in Autonomous Commerce

Autonomous shopping agents face adversarial interactions from multiple directions:

1. **Adversarial Merchants**: Inserting prompt injection attacks into product listings, metadata, or return policies to force higher-margin purchases.
2. **Compromised Models / Hallucinations**: An agent entering an infinite tool-calling loop, executing rapid retries upon receiving transient errors, or altering user parameters.
3. **Price & Discount Probing**: An agent systematically probing discount endpoints to discover merchant discount ceilings.

### Behavioral Trajectory Guard

CaptureLock models agent actions as a trajectory over time:

- **Velocity Counters**: Per-session tracking of catalog queries, merchant transitions, cart mutations, and capture attempts.
- **Circuit Breakers**: If an agent executes $> 3$ capture retries within 30 seconds or switches merchants $> 2$ times in a single session, CaptureLock trips a trajectory circuit breaker and pauses the session (`TRAJECTORY_RATE_LIMIT_EXCEEDED`).

---

## 2. Exactly-Once Payment Execution Mechanics

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
