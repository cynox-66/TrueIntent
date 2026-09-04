# Capture-Time Verification, Freshness, and TOCTOU in Agentic Commerce

> [!IMPORTANT]
> **§2's "Row-Hashing Solution" was superseded during implementation.** Comparing
> an agent-supplied `sourceRowHash` against the live row hash defends only against
> an _honest_ agent holding stale data: a malicious one reads the current hash and
> sends that, and the check passes while looking like it worked. The implemented
> defence compares **the terms about to be charged against the terms the merchant
> will honour now**, and TrueIntent issues the snapshot rather than accepting one.
> Row hashes remain, computed by us, for drift attribution in the evidence.
> See [ADR-008](../decisions/ADR-008-freshness-proposed-versus-live.md).
>
> **§3's Tier 2 "Advisory Spirit Check" was also narrowed.** It may only restrict a
> verdict, never grant one. See [ADR-009](../decisions/ADR-009-advisory-layer-restriction-only.md).
>
> The framing in §1 — that authorization and capture are separated by minutes of
> agent reasoning, and that the gap is the problem — is what the whole system is
> built on and is unchanged.

## 1. Pre-Authorization vs. Capture-Time Verification

In human commerce, authorization and capture typically happen in near-synchrony: a user reviews a checkout page and clicks "Pay".

In agentic commerce, an agent may:

1. Receive delegated authorization hours or days in advance (e.g. UPI Reserve Pay mandate or AP2 credential).
2. Perform multi-step product discovery, comparison, and negotiation across multiple tools and minutes.
3. Arrive at a final cart that has drifted from the initial authorization terms.

```
TIME ────────────────────────────────────────────────────────►
[User Mandate Created] ──────► [Agent Reasoning/Shopping] ──────► [Capture Request]
       ▲                                                                 ▲
       │                                                                 │
Authorizes ₹800 budget                                        Is this price still ₹800?
at 10:00 AM                                                   Is stock available?
                                                              Did intent drift?
                                                              [TRUEINTENT VERIFICATION]
```

---

## 2. The TOCTOU Problem (Time-of-Check to Time-of-Use)

A Time-of-Check to Time-of-Use race condition occurs when an agent checks a price or stock level at $T_1$, but the merchant's underlying inventory database updates at $T_2$, and the agent submits payment at $T_3$ ($T_1 < T_2 < T_3$).

### The Row-Hashing Solution

TrueIntent solves TOCTOU using cryptographically grounded row hashing:

1. When an agent queries catalog items, each row contains an authoritative `row_hash` computed over:
   $$\text{row\_hash} = H(\text{sku} \parallel \text{price} \parallel \text{stock} \parallel \text{updated\_at})$$
2. The agent includes these observed `sourceRowHash` values in its `CartSnapshot`.
3. At the exact moment `/sessions/authorize_capture` is called, TrueIntent re-queries the merchant's source-of-truth rows.
4. If any live `row_hash` differs from the snapshot hash, or if $\Delta t = (t_{\text{capture}} - t_{\text{observed}}) > W$ (where $W$ is the freshness window, e.g. 30 seconds), the transaction is refused with `STALE_PRICE` or `STALE_INVENTORY`.

---

## 3. Intent Drift Detection

Autonomous agents frequently encounter partial availability or missing items. Without strict intent alignment, an agent attempting to "satisfy the prompt" may substitute items that obey mathematical budget rules but violate user intent.

TrueIntent applies a two-tier evaluation:

- **Tier 1 (Deterministic Floor)**: Hard constraints compiled from user preferences (e.g., maximum budget, dietary restrictions like vegetarian-only, permitted merchant domains).
- **Tier 2 (Advisory Spirit Check)**: Semantic alignment evaluation comparing the original raw intent prompt with the synthesized cart manifest:
  - `ALIGNED`: Cart matches semantic intent. Proceeds if hard constraints pass.
  - `MARGINAL`: Ambiguous substitution (e.g., substituted brand). Triggers `PAUSE` for human review.
  - `DIVERGED`: Fundamental departure from intent. Triggers `DENY`.
