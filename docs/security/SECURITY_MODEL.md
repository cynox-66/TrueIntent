# CaptureLock Security Model

## 1. Fundamental Security Principles

CaptureLock enforces five foundational security invariants:

1. **Zero LLM Payment Authority**: LLMs are probabilistic reasoning engines subject to prompt injection, hallucination, and jailbreaks. Under no circumstance does an LLM possess direct execution authority over financial rails.
2. **Deterministic Primacy**: All financial, mathematical, policy, and state decisions are enforced by compiled, deterministic code.
3. **Continuous Freshness**: No authorization token or cart snapshot is trusted without live re-verification against the merchant's authoritative state at the moment of charge.
4. **Exactly-Once Semantics**: All mutations carry composite idempotency keys, and incoming asynchronous webhooks pass through atomic deduplication.
5. **Replayable Evidence Chaining**: Every decision emits an immutable, cryptographically verifiable proof envelope that can be audited offline.

---

## 2. Multi-Layer Defense Architecture

```
Layer 5: Evidence Ledger (Hash-chained audit trail & offline replayability)
   ▲
Layer 4: Exactly-Once Execution (Idempotency keys, webhook inbox deduplication)
   ▲
Layer 3: Behavioral Trajectory Guard (Velocity ceilings, retry circuit breakers)
   ▲
Layer 2: Freshness Revalidator (TOCTOU guard, live row-hash comparison)
   ▲
Layer 1: Deterministic Policy Engine (Discount caps, category rules, budget limits)
   ▲
Layer 0: Input Sanitization & Schema Validation (Strict Zod validation at boundaries)
```

---

## 3. Threat Mitigations in Detail

### 3.1 Prompt Injection Isolation

- **Mechanism**: The buyer agent interacts with external catalogs and user prompts, making its context vulnerable to indirect prompt injection. CaptureLock never parses the agent's internal reasoning or natural language output to authorize payments. Instead, it only receives structured JSON payloads (`CartSnapshot`) containing specific SKUs, quantities, and observed row hashes.
- **Guarantee**: Even if the buyer agent is completely compromised, CaptureLock validates the cart against the user's compiled hard constraints (budget, merchant whitelist, category whitelist) and live catalog truth.

### 3.2 Webhook Signature & Replay Defense

- **Signature Verification**: Every incoming webhook from Razorpay is validated against `RAZORPAY_WEBHOOK_SECRET` using HMAC-SHA256 before any body parsing occurs.
- **Atomic Inbox Deduplication**: Razorpay delivers webhooks with at-least-once semantics. The `webhook_inbox` table enforces `UNIQUE(event_id)`. If an event is received twice, the second attempt conflicts at the database constraint level and is discarded with an acknowledgement.

### 3.3 Secrets & Environment Isolation

- Real merchant credentials and live payment keys are never used.
- Keys must begin with `rzp_test_`. Any attempt to configure keys with `rzp_live_` is actively rejected at the configuration schema level.
- Secrets are loaded strictly via environment variables and never logged.

---

## 4. Open Security Decisions

- **Evidence Envelope Signing Key Management**: STATUS: OPEN DECISION (Selection of key management approach for signing evidence envelopes — local private key in HSM/KMS vs. local environment key for prototype).
- **Public Key Distribution for Offline Replay**: STATUS: OPEN DECISION (Protocol for third-party dispute reviewers to verify envelope signatures).
