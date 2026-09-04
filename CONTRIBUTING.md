# Contributing to TrueIntent

Thank you for contributing to TrueIntent! This document outlines our development process, code quality standards, and contribution workflow.

---

## Code of Conduct & Development Principles

1. **Security & Secrets**: Never commit real credentials, API keys, or live credentials. All Razorpay testing MUST use Test Mode.
2. **Quality Gates**: All code submissions must pass linting, typechecking, formatting, and unit tests before merging.
3. **Deterministic First**: Logic handling money, policy, or state validation must be deterministic and testable.

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0 (Node 24 recommended)
- pnpm >= 9.0.0 (pnpm 11 recommended)
- Docker & Docker Compose (for local PostgreSQL)

### Local Setup

```bash
# 1. Clone repository & install dependencies
git clone <repo-url>
cd Razorpay
pnpm install

# 2. Configure environment
cp .env.example .env

# 3. Start local PostgreSQL
pnpm db:up

# 4. Verify setup
pnpm typecheck
pnpm test
pnpm dev
```

---

## Quality Gates

All of these must pass before a commit or PR:

```bash
pnpm typecheck      # tsc -b, plus a separate pass over test files
pnpm build
pnpm lint
pnpm format:check
pnpm test           # 412 tests, offline, no Docker, no network
```

Two further suites are opt-in but should be run when touching what they cover:

```bash
pnpm db:up && pnpm test:db   # concurrency and DB constraints against real Postgres
pnpm eval                    # baseline vs TrueIntent; exits non-zero on a regression
```

### Which suite proves what

`pnpm test` runs against in-memory repositories. They model the database's
semantics faithfully, but on a single-threaded event loop they cannot prove
anything about several API instances sharing a database. If you are changing
anything about idempotency, state transitions, webhook deduplication or the
evidence chain, **run `pnpm test:db`** — that is the suite that exercises real
contention. See `docs/decisions/ADR-010-test-topology-and-persistence.md`.

### Things the tooling will stop you doing

- **Reading a clock or a random source inside the verification kernel.** An
  ESLint rule scoped to `packages/kernel/src/stages/**`, `kernel.ts` and
  `combine.ts` refuses it, and an architecture test checks it again. The kernel's
  purity is what makes decisions replayable from evidence.
- **Importing Fastify, a database driver, or a payment provider into
  `packages/kernel`.** An architecture test asserts the dependency boundary.
- **Constructing a payment provider outside the composition root**, or importing
  one into a route module.
- **Adding a reason code without using it**, or using one that is not declared.

### If you add a verification stage

Add it to `MANDATORY_STAGES` in `packages/kernel/src/combine.ts`. A stage that is
not in that list does not gate money, and the fail-closed tests will notice the
inconsistency. Stages emit findings; they never decide a verdict.

---

## Branching & Commit Hygiene

- Branch naming:
  - `feat/<feature-name>`
  - `fix/<bug-name>`
  - `docs/<doc-name>`
  - `chore/<chore-name>`
- Commit messages should be concise, present-tense, and descriptive:
  - `feat(policy): add budget cap predicate compiler`
  - `fix(webhook): resolve idempotency key collision on duplicate event`
  - `docs(adr): record ADR-001 initial architecture`

---

## Architecture Decision Records (ADRs)

If you introduce architectural modifications, new dependencies, or protocol adaptations, document them in `docs/decisions/` following the ADR format.
