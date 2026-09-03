# AGENTS.md - Operational Guardrails for AI Coding Agents

This document defines the strict, non-negotiable operating principles and guidelines for any AI coding agent working in the **CaptureLock** repository.

---

## Core Mission & Architectural Role

CaptureLock is a **capture-time payment execution verification layer** for agentic commerce, designed for the Razorpay AI Buildathon 2026 (Track 1: AI Growth & Agentic Commerce).

It sits at the boundary between an AI buyer agent and payment rails:

```
USER INTENT → BUYER AGENT → CAPTURELOCK → RAZORPAY (TEST MODE ONLY)
```

The core thesis is:

> **"At the exact moment money moves, verify that the transaction still matches the authorized intent, live commercial state, policy, and execution state."**

---

## Non-Negotiable Project Rules

Every agent operating in this repository must strictly adhere to the following rules:

1. **Never invent external API behavior.**  
   Do not hallucinate or guess endpoints, response shapes, or webhook contracts for Razorpay, ACP, AP2, or UCP. Always verify against official documentation or established schemas in `packages/integrations`.

2. **Never use Razorpay live mode.**  
   All Razorpay integrations, test fixtures, environment variables, and scripts MUST use **TEST MODE ONLY** (`rzp_test_`). Real monetary transactions are strictly forbidden.

3. **Never commit secrets.**  
   Never commit `.env` files, actual API keys, private keys, or webhook secrets. All templates must reside in `.env.example` with clear dummy placeholders.

4. **Never allow an LLM to directly authorize payment execution.**  
   An LLM may propose or assist with semantic alignment ("spirit check"), but the execution of payments is strictly gated by deterministic policy predicates and cryptographic proofs. The LLM cannot call payment capture APIs directly.

5. **Deterministic checks must remain deterministic.**  
   Prices, stock counts, discount ceilings, category restrictions, and idempotency must be evaluated via strict, deterministic code—never delegated to probabilistic model inference.

6. **Security-critical decisions must be testable and reproducible.**  
   Every verification decision (ALLOW, PAUSE, DENY) must produce an auditable trace with exact inputs, source hashes, and evaluated predicates.

7. **Every major security-sensitive behavior requires tests.**  
   Do not introduce or modify policy rules, freshness checks, or release state transitions without accompanying automated tests in `tests/` or package test suites.

8. **Prefer explicit state machines over implicit behavior.**  
   State transitions (e.g. `PENDING → VERIFIED → CAPTURED / FAILED`) must be modeled with explicit, finite state machines and atomic persistence.

9. **Do not bypass CaptureLock in demos/tests merely to make something pass.**  
   If a test or demo scenario fails, diagnose the underlying rule, state mismatch, or race condition. Never disable validation middleware or hardcode approvals.

10. **Do not add unnecessary dependencies.**  
    Keep the footprint lightweight. Do not add heavy frameworks, complex ORMs, or unvetted libraries when standard TypeScript or existing workspace packages suffice.

11. **Document architectural decisions.**  
    Any structural change, new component, or protocol adjustment must be recorded in `docs/decisions/` as an Architecture Decision Record (ADR).

12. **Do not claim production-grade security from a prototype.**  
    CaptureLock is an engineering-heavy prototype and research proof-of-concept. Be precise and honest about security assumptions and prototype boundaries.

13. **Every external integration should have a mock/fake implementation for deterministic tests.**  
    Tests must never depend on live external networks. Provide deterministic in-memory fakes for Razorpay APIs and merchant catalog feeds.

14. **Idempotency must be treated as a first-class concern.**  
    All money-moving and order-initiating operations must use deterministic idempotency keys and an inbox deduplication pattern.

15. **Failure paths are as important as happy paths.**  
    Test and handle stale prices, depleted inventory, duplicate webhooks, network drops, and intent drift with equal rigor to successful checkouts.

16. **Never silently swallow payment or verification errors.**  
    All exceptions must be caught, categorized with standard `ReasonCode`s, logged to the audit ledger, and propagated with informative error envelopes.

17. **Do not use an LLM where a deterministic rule is sufficient.**  
    Use AI only for semantic intent ambiguity; use deterministic TypeScript/SQL for math, logic, policy, and state verification.

18. **Keep the core verification engine provider/protocol agnostic where practical.**  
    Core verification logic in `packages/core` and `packages/policy` must not depend on Razorpay-specific primitives. Provider adaptations belong in `packages/integrations`.

19. **Documentation First.**  
    Before modifying architecture or security-critical code, agents must inspect the relevant documentation under `docs/` (`OVERVIEW.md`, `THREAT_MODEL.md`, `DATA_MODEL.md`, `STATE_MACHINE.md`, `SECURITY_MODEL.md`).

---

## Phase Boundaries & Current Scope

- **Phase 0 (Current)**: Environment bootstrap, project structure, tooling, and documentation skeleton ONLY.
- **Phase 1 (Next)**: Core state machines, Drizzle ORM schema, and deterministic policy engine.
- **Phase 2**: Freshness revalidator (TOCTOU guard) and Razorpay test-mode adapter.
- **Phase 3**: Replayable evidence ledger, adversarial evaluation harness, and operator UI.

Agents must not implement future phase deliverables ahead of scheduled alignment.
