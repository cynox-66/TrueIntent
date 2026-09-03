# CaptureLock Architectural Overview

## 1. System Mission

**CaptureLock** is an independent, protocol-agnostic capture-time verification and proof layer designed for agentic commerce. It operates directly at the critical boundary where autonomous buyer agents request payment execution.

```
USER INTENT
    ↓
AGENT (Autonomous Buyer)
    ↓
CAPTURELOCK
    ├── Policy Verification (Deterministic predicates)
    ├── Intent Alignment (Hard-floor constraints + advisory spirit-check)
    ├── Freshness / Live-State Verification (TOCTOU guard)
    ├── Behavioral / Trajectory Protection (Rate limits, retry boundaries)
    ├── Exactly-Once Execution Control (Idempotency + inbox deduplication)
    └── Evidence Ledger (Append-only, replayable proof artifact)
    ↓
RAZORPAY TEST MODE (Orders, Hosted Checkout / Links, Webhooks)
```

---

## 2. Core Problem: The Capture-Time Void

Existing delegated payment protocols (such as AP2, ACP, and UCP) and emerging payment rails (UPI Reserve Pay, UPI Circle) establish authorization primitives:

- A user or bank authorizes a mandate, budget limit, or checkout token.
- Digital signatures bind an agent to an initial authorization context.

However, existing frameworks stop short of answering the decisive question at charge time:

> **"At the exact moment money moves, does this specific cart still match the authorized intent, live commercial reality, merchant policy, and a sane execution trajectory?"**

Between authorization and capture, four major failures occur:

1. **TOCTOU / Stale Commercial State**: Prices, discounts, or stock levels change while the agent reasons or negotiates.
2. **Semantic Intent Drift**: An agent adheres to broad numerical constraints (e.g. "under ₹800") but drifts entirely from user intent (e.g. substituting groceries for bulk energy drinks).
3. **Behavioral Trajectory Anomalies**: Agents caught in retry storms or adversarial prompt injections rapidly fire mutating payment attempts.
4. **Duplicate Execution / Webhook Replays**: Flaky networks and retried webhooks risk double-charging or corrupting order state.

---

## 3. High-Level Component Boundaries

### 3.1 API Service (`apps/api`)

Lightweight Fastify service exposing structured endpoints:

- `POST /sessions/start`: Records initial user intent, budget ceilings, and session context.
- `POST /sessions/snapshot`: Accepts the agent's proposed cart with row hashes and observed timestamps.
- `POST /sessions/authorize_capture`: Coordinates the verification pipeline and returns an authoritative decision (`ALLOW`, `PAUSE`, `DENY`) along with an `envelope_id`.
- `POST /webhooks/razorpay`: Verifies signatures and idempotently processes payment events.

### 3.2 Policy Engine (`packages/policy`)

- Compiles declarative merchant and user constraints into strict, deterministic predicates.
- Enforces hard ceilings on discounts, maximum quantities, allowed categories, and merchant domains.
- Produces plain-language policy explanations for why actions were permitted or rejected.

### 3.3 Freshness Revalidator (`packages/integrations` & `packages/core`)

- Re-queries the live merchant data store at the moment of capture.
- Compares live price and stock row-hashes against snapshot hashes.
- Enforces a strict time-to-live freshness window $W$ (default: 30 seconds).

### 3.4 Exactly-Once Execution Controller (`apps/api` & `packages/integrations`)

- Generates composite idempotency keys derived from session context, cart digest, and attempt sequence.
- Maintains a dedicated `webhook_inbox` with unique event constraints to defeat webhook duplication.

### 3.5 Evidence Ledger (`packages/evidence`)

- Appends an immutable proof envelope for every charge attempt.
- Emits cryptographic proof chaining (`previousEnvelopeHash` → `currentEnvelopeHash`).
- Supports offline replay via CLI or verifier tools.

---

## 4. Open Architectural Decisions

> [!NOTE]
> Detailed technical selections currently open for future phases:

- **Evidence Ledger Storage Backend**: STATUS: OPEN DECISION (PostgreSQL append-only table vs. dedicated cryptographic log store).
- **Advisory Spirit-Check Orchestration**: STATUS: OPEN DECISION (Direct Claude 3.5 Sonnet prompt invocation vs. local lightweight classifier).
- **Merchant State Revalidation Protocol**: STATUS: OPEN DECISION (Direct DB query adapter vs. signed HTTP merchant probe endpoint).
