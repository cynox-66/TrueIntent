# Contributing to CaptureLock

Thank you for contributing to CaptureLock! This document outlines our development process, code quality standards, and contribution workflow.

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

Before creating a commit or PR, run the local quality checks:

```bash
# Verify TypeScript types
pnpm typecheck

# Run tests
pnpm test

# Check lint rules
pnpm lint

# Check formatting
pnpm format:check
```

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
