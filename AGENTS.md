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

- **Phase 0 (complete)**: Environment bootstrap, project structure, tooling, documentation skeleton.
- **Phase 1 (complete)**: The verification kernel. Deterministic pipeline, policy engine,
  release state machine, capture-time freshness, two-layer idempotency, signed evidence ledger,
  Razorpay test-mode adapter boundary, HTTP surface, and the baseline-versus-CaptureLock harness.
- **Phase 2 (complete)**: The real, persistent end-to-end flow. Postgres as the source of
  truth, a unit of work with explicit transaction boundaries, the grant enforced as a
  capability at the provider port, separated HTTP authority, request-scoped idempotency,
  two recovery sweeps, and an end-to-end scenario engine.
- **Phase 3 (next)**: See "Recommended next phase" in the Phase 2 engineering report.

### Corrections made in Phase 1 that supersede earlier guidance

Three Phase 0 contracts were found to be unsound and were replaced. An agent
reading the older documents should treat these as authoritative:

1. **The verification request must not carry intent, policy version, or a
   timestamp.** The agent supplies identifiers and its own idempotency key;
   everything authoritative is server-resolved. See
   `docs/decisions/ADR-004-authorized-intent-and-untrusted-input.md`.
2. **Freshness compares proposed terms against live terms**, not an
   agent-supplied row hash against a live one. See
   `docs/decisions/ADR-008-freshness-proposed-versus-live.md`.
3. **The merchant is authoritative but adversarial**, not trusted. See
   `docs/architecture/THREAT_MODEL.md`.

### Corrections made in Phase 2

Two more Phase 1 claims were found to be false and are now fixed. An agent reading
the older documents should treat these as authoritative:

4. **The capture path was NOT one transaction**, despite ADR-005 saying so. It was
   several autocommits, and a crash mid-chain stranded the release in a state no
   sweep could see — permanently bricking the authorization, because the
   one-active-release index held its slot. See
   `docs/decisions/ADR-011-unit-of-work-and-stranded-releases.md`.
5. **Two documented Razorpay behaviours are false on a default account**: duplicate
   receipts are _accepted_, and the order-by-receipt lookup is _eventually
   consistent_. The second was a live bug. Measured, not assumed — see
   `docs/decisions/ADR-015-razorpay-reality.md`.

### Additional non-negotiables established in Phase 2

25. **Multi-write sequences go through `unitOfWork.withTransaction`.** Evidence and
    the state change it justifies must commit together. A repository reached from
    outside the callback runs on a different connection and commits independently.
26. **Never widen a compare-and-set's source-state list to make a transition
    succeed**, and never add an edge from an indeterminate state back into an
    in-flight one. That edge is a blind retry.
27. **An agent must never hold issuer or operator authority.** If a new endpoint can
    create a mandate, resolve a review, or change recorded state, it needs one of
    those keys — the kernel enforces whatever mandate it is given and cannot help here.
28. **Verify provider behaviour against the live API before designing recovery on
    it.** The documentation was wrong twice. `pnpm smoke:razorpay` exists to be re-run.
29. **A new non-terminal release state must be classified** as transient (provider
    provably not called → the liveness sweep may abort it) or indeterminate (provider
    may have acted → only reconciliation may resolve it). An unclassified state is
    invisible to both sweeps and will strand releases.

### Additional non-negotiables established in Phase 1

20. **The verification kernel must stay a pure function.** No I/O, no clock, no
    randomness inside `packages/kernel/src/stages/**`, `kernel.ts` or
    `combine.ts`. An ESLint rule and an architecture test enforce this. Purity is
    what makes a decision replayable from evidence; breaking it silently breaks
    the audit story.
21. **A verification stage may never approve anything.** Stages emit findings;
    one combiner decides. Any new stage must be added to `MANDATORY_STAGES`.
22. **Duplicate prevention belongs in the database.** New money-moving paths
    must rest on a constraint or a compare-and-set, never on an application-level
    check that a concurrent transaction could race past.
23. **A probabilistic component may only restrict a verdict, never raise one.**
24. **Do not widen a compare-and-set's source-state list to make a transition
    succeed.** If a transition is being refused, the state machine is telling you
    something.
