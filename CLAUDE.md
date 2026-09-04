# CLAUDE.md - TrueIntent Project Guide

## Overview

TrueIntent is a capture-time payment execution verification layer for agentic commerce (Razorpay AI Buildathon 2026, Track 1).

## Common Commands

```bash
# Setup & Installation
pnpm install

# Development
pnpm dev             # Start API in watch mode
pnpm db:up           # Start PostgreSQL container via Docker Compose
pnpm db:down         # Stop PostgreSQL container

# Quality Gates
pnpm build           # Build all packages & apps
pnpm test            # Run Vitest test suite
pnpm typecheck       # Run TypeScript project reference typecheck
pnpm lint            # Lint codebase with ESLint
pnpm format          # Format files with Prettier
pnpm format:check    # Verify Prettier compliance in CI
```

## Key Architecture Principles

1. **Never use Razorpay live mode**: TEST MODE ONLY (`rzp_test_`).
2. **Never allow LLMs to directly execute payments**: Deterministic code gates money movement.
3. **Deterministic verification**: Math, policy ceilings, price checks, and freshness revalidations must be 100% deterministic code.
4. **Idempotency first**: Every mutating order or release requires an idempotency key and dedup inbox.
5. **Replayable proofs**: Decisions must be recorded in an append-only, verifiable evidence ledger.

## Coding Standards & Conventions

- **TypeScript**: Strict mode enabled (`NodeNext` modules). Do not use `any`; use typed Zod schemas.
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions, UPPER_SNAKE_CASE for constants.
- **Error Handling**: Use structured `ReasonCode`s. Never swallow errors or log raw secrets.
- **Testing**: Vitest for all unit, integration, and adversarial tests. Every new security behavior requires a test.
- **Documentation**: Record architectural changes in `docs/decisions/` (ADRs). Consult `docs/` before altering security logic.

## NEVER PUT YOURSELF AS CO-AUTHOR IN ANY COMMITS OR PUSHES
