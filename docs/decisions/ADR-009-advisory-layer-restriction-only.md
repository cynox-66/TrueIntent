# ADR-009: The advisory layer may only restrict

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: the "Spirit-Check Fallback Semantics" open decision in ADR-001 and `THREAT_MODEL.md`

## Context

Phase 0 described a two-tier intent check: deterministic constraints, then a
semantic "spirit check" returning `ALIGNED`, `MARGINAL` or `DIVERGED`, steering
the verdict. It left open a question that kept recurring: **if the model times
out, do we fail open or fail closed?**

The question is a symptom. Taken literally, the design puts a probabilistic
component inside the money path, which breaks two properties at once: an LLM can
be prompt-injected by the merchant catalogue it is reading, and a decision that
depends on a model cannot be replayed.

## Decision

The advisory layer sits **outside** the deterministic kernel and is a one-way
valve. It may only _restrict_:

```
ALIGNED     → no change
MARGINAL    → ALLOW becomes PAUSE
DIVERGED    → ALLOW or PAUSE becomes DENY
unavailable → no change, recorded as ADVISORY_UNAVAILABLE
```

The floor is enforced by comparing severity ranks: the result is never less
severe than what the kernel decided, whatever the reviewer says.

**The open question dissolves.** A layer that cannot grant anything has no
fail-open mode to design around. An unavailable reviewer simply applies no
restriction, and its absence is recorded.

Three consequences worth stating:

- A compromised or prompt-injected reviewer **cannot approve anything**. The
  worst it can do is refuse a legitimate transaction — an availability problem,
  not a financial one.
- Replay stays exact. The deterministic decision and its hash are recorded for
  replay; the advisory adjustment is recorded beside them, attributed, clearly
  labelled as a judgement rather than a computation.
- The reviewer is the only component that reads `intent.rawText`. Free text is
  exactly where a judgement belongs, and exactly where a deterministic check
  does not.

### What ships

An `AdvisoryReviewer` port and a deterministic `LexicalOverlapReviewer`: does any
meaningful word from what the user asked for appear in what the merchant is
selling? That catches the canonical drift case — "dinner ingredients" answered
with energy drinks — with no inference and complete reproducibility.

It is not a semantic judge and is not presented as one. It exists so the pathway
is real, tested, and demonstrably restriction-only. Swapping in a model-backed
reviewer changes nothing about the guarantees, which is the entire point of the
interface. No live LLM call ships, in line with the scope constraint against
unnecessary AI features.

## Consequences

**Positive.** The prompt-injection threat (F3) is structurally closed rather than
mitigated: a hijacked reviewer has no authority to grant. Determinism and
replayability are preserved exactly.

**Negative.** The advisory layer cannot rescue a transaction the deterministic
constraints wrongly refuse. If constraints are too tight, the fix is to fix the
constraints.

**Honest limitation.** The shipped reviewer is a lexical heuristic. It will miss
semantically distant substitutions that happen to share vocabulary, and it will
flag legitimate ones that do not. It is a placeholder occupying the correct
architectural position, not a working intent classifier.
