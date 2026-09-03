# ADR-001: Initial Architecture & Phase 0 Environment Foundation

- **Status**: Accepted
- **Date**: 2026-09-03
- **Author**: CaptureLock Engineering Team
- **Target Milestone**: Razorpay AI Buildathon 2026 (Track 1)

---

## 1. Context & Problem Statement

As autonomous AI agents acquire the capability to browse catalogs, negotiate offers, and execute transactions on behalf of users, the financial payment boundary faces new classes of systemic risk.

Current delegated payment initiatives (such as AP2, ACP, UCP, UPI Reserve Pay, and UPI Circle) provide primitives for delegated spending authority and digital signatures. However, they lack a dedicated capture-time verification primitive that answers:

> "At the exact moment money moves, can we prove that the transaction still matches the user's intent, the merchant's live state, the encoded policy, and a safe execution trajectory?"

Without this primitive, transactions suffer from:

1. **TOCTOU (Time-of-Check to Time-of-Use)** price and stock changes.
2. **Semantic intent drift** away from user desires.
3. **Indirect prompt injection** via merchant catalogs.
4. **Duplicate charges** from webhook replays or agent retry storms.
5. **A lack of replayable evidence** for post-transaction dispute resolution.

CaptureLock is designed as an infrastructure-grade capture-time verifier that sits between buyer agents and payment gateways (demonstrated using Razorpay Test Mode).

---

## 2. Decision & Initial Architecture Direction

We adopt a modern, TypeScript-first monorepo architecture:

1. **Package Manager & Monorepo Structure**:
   - `pnpm` workspaces for fast, disk-efficient dependency management.
   - Distinct boundary separation:
     - `apps/api`: Fastify HTTP verification service and webhook handler.
     - `apps/web`: Reserved placeholder for the future operator console.
     - `packages/core`: Protocol-agnostic domain models and schemas.
     - `packages/policy`: Declarative constraint compiler and predicate evaluators.
     - `packages/evidence`: Replayable proof envelopes and cryptographic ledger.
     - `packages/integrations`: Razorpay Test Mode adapter and live state providers.

2. **Core Technologies**:
   - **TypeScript**: Strict mode with `NodeNext` resolution across all packages.
   - **Fastify**: High-throughput, low-overhead HTTP engine.
   - **PostgreSQL 16**: Primary data store with Docker Compose for local development.
   - **Drizzle ORM**: Type-safe SQL mapping with explicit schema control.
   - **Zod**: Boundary validation for API inputs, envelopes, and configs.
   - **Vitest**: Fast, native TypeScript test runner.
   - **ESLint & Prettier**: Code hygiene, formatting, and static analysis.

3. **Strict Separation of Concerns**:
   - **Probabilistic vs. Deterministic**: The LLM proposes; deterministic TypeScript predicates and database constraints decide. The LLM is never given direct authority over money.
   - **Razorpay Test Mode Only**: Real money movement is strictly forbidden. All configurations require the `rzp_test_` key prefix.

---

## 3. Deliberately Out of Scope for Phase 0

To maintain absolute rigor and avoid speculative implementation:

- No verification logic, intent parser, or policy compiler implementation.
- No live network calls to Razorpay APIs or live merchant feeds.
- No frontend UI or dashboard implementation.
- No automated migration scripts or complex database tables.
- No claims of production-grade compliance or protocol certification.

Phase 0 is strictly limited to establishing a working, tested, typed, and clean development environment.

---

## 4. Unresolved Architectural Questions

The following decisions are deliberately deferred to subsequent phases:

1. **Evidence Ledger Cryptographic Primitive**:
   - _Status_: STATUS: OPEN DECISION
   - _Options_: HMAC-SHA256 chained hashes vs. Ed25519 asymmetric signatures per envelope.
2. **Spirit-Check Fallback Semantics**:
   - _Status_: STATUS: OPEN DECISION
   - _Options_: Fail-closed (`PAUSE`) on LLM timeout vs. fail-open (`ALLOW` if all deterministic rules pass).
3. **Merchant Live-State Ingestion**:
   - _Status_: STATUS: OPEN DECISION
   - _Options_: Direct SQL database read replica adapter vs. signed HTTP merchant probe endpoint.
4. **Idempotency Key Scope**:
   - _Status_: STATUS: OPEN DECISION
   - _Options_: Global unique key vs. tenant-scoped compound key.

---

## 5. Consequences

### Positive

- A single command (`pnpm test`, `pnpm build`, `pnpm dev`) verifies the entire workspace.
- Clear separation ensures any incoming agent or engineer can build components independently without architectural ambiguity.
- Complete alignment with Razorpay's published engineering values (bounded agency, safety-first systems, honest evaluation).

### Negative / Trade-offs

- Setting up a strict monorepo requires initial boilerplate and explicit project references in `tsconfig.json`.
- Strict typing and Zod schemas require upfront schema definitions before writing logic.
