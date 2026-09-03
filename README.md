# CaptureLock

> **A capture-time payment execution verification and proof layer for agentic commerce.**  
> Built for the **Razorpay AI Buildathon 2026** (Track 1: AI Growth & Agentic Commerce).

---

## Core Thesis

> _"At the exact moment money moves, verify that the transaction still matches the authorized intent, live commercial state, policy, and execution state."_

As autonomous AI buyer agents negotiate, compose carts, and execute payments, a critical verification void exists between initial user authorization (e.g. UPI Reserve Pay, AP2 mandates) and payment capture.

**CaptureLock** sits between the agent and payment provider rails (demonstrated using Razorpay Test Mode) to guarantee that:

1. **Prices and stock are fresh**: TOCTOU race conditions are prevented by re-verifying live merchant state at capture time.
2. **Intent is preserved**: The transaction matches user desires, not just numerical budget ceilings.
3. **Policies are strictly enforced**: Merchant discount caps, merchant whitelists, and category rules are evaluated deterministically.
4. **Execution is exactly once**: Composite idempotency keys and atomic webhook deduplication prevent double-captures.
5. **Proofs are replayable**: Every decision generates an immutable, hash-chained evidence envelope for offline dispute verification.

```
USER INTENT
    ↓
BUYER AGENT
    ↓
CAPTURELOCK
    ├── Policy verification (Deterministic predicates)
    ├── Intent alignment (Hard constraints + spirit check)
    ├── Freshness verification (TOCTOU guard)
    ├── Behavioral trajectory guard (Rate limits, retry circuit breakers)
    ├── Exactly-once execution protection (Idempotency keys + inbox dedup)
    └── Evidence ledger (Hash-chained replayable proofs)
    ↓
RAZORPAY (TEST MODE ONLY)
```

---

## Important Security Warning: Razorpay Test Mode Only

> [!WARNING]
> **CaptureLock is an engineering prototype and strictly restricted to Razorpay TEST MODE (`rzp_test_`).**
> Real monetary transactions, live API keys, and production credit rails are strictly prohibited. Configuration schemas actively reject keys lacking the `rzp_test_` prefix.

---

## Current Status: Phase 0 Environment Bootstrap

This repository is currently in **Phase 0 (Environment Bootstrap)**:

- [x] Monorepo workspace structure (`apps/*`, `packages/*`).
- [x] TypeScript strict compilation (`NodeNext`).
- [x] Tooling, linting, and formatting pipelines (ESLint 9, Prettier, Vitest).
- [x] Local PostgreSQL 16 container definition via Docker Compose.
- [x] Fastify API scaffold with `/health` and status endpoints.
- [x] Foundational domain schemas, contracts, and interfaces (`@capturelock/core`, `@capturelock/policy`, `@capturelock/evidence`, `@capturelock/integrations`).
- [x] Documentation skeleton and research foundations.
- [ ] _Product implementation (verification pipeline, policy compiler, live Razorpay adapter) will begin in Phase 1 upon review._

---

## Project Structure

```
.
├── apps/
│   ├── api/                  # Fastify HTTP service & webhook handler
│   └── web/                  # Operator console (reserved placeholder)
├── packages/
│   ├── core/                 # Core domain types, schemas, and verdict contracts
│   ├── policy/               # Policy rules, constraints, and compiler contracts
│   ├── evidence/             # Evidence envelope & replayable ledger interfaces
│   └── integrations/         # Razorpay Test Mode & live state provider contracts
├── docs/
│   ├── architecture/         # OVERVIEW, THREAT_MODEL, DATA_MODEL, STATE_MACHINE
│   ├── security/             # SECURITY_MODEL
│   ├── evaluation/           # EVALUATION_PLAN (20 scripted scenarios)
│   ├── research/             # Protocol analysis (ACP/AP2/UCP) & TOCTOU research
│   └── decisions/            # Architecture Decision Records (ADR-001)
├── tests/
│   ├── integration/          # Workspace contract & integration tests
│   ├── adversarial/          # Reserved for adversarial scenario fixtures
│   └── fixtures/             # Deterministic catalogs, policies, and mock webhooks
├── docker/                   # PostgreSQL initialization scripts
├── docker-compose.yml        # Local PostgreSQL 16 infrastructure
├── AGENTS.md                 # 18 non-negotiable rules for AI coding agents
├── CLAUDE.md                 # Quick-reference guide & commands
├── CONTRIBUTING.md           # Development workflow & quality gates
└── package.json              # Monorepo scripts & dependencies
```

---

## Prerequisites

- **Node.js**: `>= 20.0.0` (Node 24 recommended)
- **pnpm**: `>= 9.0.0` (pnpm 11 recommended)
- **Docker & Docker Compose**: For local PostgreSQL 16 service

---

## Quickstart & Available Commands

### 1. Installation

```bash
pnpm install
```

### 2. Environment Configuration

Copy the template configuration:

```bash
cp .env.example .env
```

_(All variables in `.env.example` contain dummy placeholders for local development.)_

### 3. Start Local Database

```bash
pnpm db:up
```

### 4. Run Development Server

```bash
pnpm dev
```

The API server will listen on `http://localhost:3000`. Test the healthcheck endpoint:

```bash
curl http://localhost:3000/health
```

### 5. Quality Gate Commands

```bash
pnpm test          # Run Vitest test suite
pnpm typecheck     # Verify TypeScript project references
pnpm build         # Build all packages and applications
pnpm lint          # Lint codebase with ESLint
pnpm format:check  # Validate Prettier formatting
pnpm format        # Auto-format all code and documentation
```

---

## License

MIT License. Developed for the Razorpay AI Buildathon 2026.
