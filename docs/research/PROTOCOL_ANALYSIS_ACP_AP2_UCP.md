# Comparative Protocol Analysis: ACP, AP2, UCP, and Capture-Time Gaps

## 1. Protocol Comparison Matrix

| Protocol / Tool                       | Focus Area                           | What it Solves                                                                      | What it Leaves Open (The Gap)                                                                                                     |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **ACP (Agentic Commerce Protocol)**   | Delegated Commerce Feeds & Endpoints | Shared Payment Tokens, catalog discovery, cart initialization.                      | Freshness contracts (Issue #294: mutating requests lack mandatory freshness signatures), MCP idempotency gaps (Issue #295).       |
| **AP2 (Agent Payments Protocol)**     | Cryptographic Mandates               | Signed Checkout Mandates & Payment Mandates as digital credentials.                 | State binding beyond static hashes; does not re-verify live cart state against merchant truth at charge time.                     |
| **UCP (Universal Commerce Protocol)** | Wire-Level Discovery & Transport     | Standardized cart/checkout lifecycles, REST & MCP bindings.                         | Cross-capability state projection across Cart → Checkout (Issue #788), state-bound offer revalidation (Issue #738).               |
| **Cycles AP2 Guard**                  | Mandate Budget Authority             | Reserve / Commit / Release runtime authority; prevents double-consumption.          | Does not verify semantic intent, product prices, catalog freshness, or emit PSP-verifiable proof envelopes.                       |
| **Lasso Intent Deputy**               | Enterprise AI Agent Security         | Behavioral monitoring of tool calls across MCP sessions to catch prompt injections. | Generic enterprise agent focus; unaware of payment carts, merchant DB state, PSP webhook lifecycles, or financial proof chaining. |

---

## 2. AP2 Security Analysis (arXiv:2608.23858)

The peer-reviewed security analysis of AP2 v0.2 identifies critical attack vectors that signatures alone cannot solve:

1. **Semantic Manipulation (F1)**: Valid mandate signatures alone do not prevent an agent from executing a transaction whose real-world commercial semantics diverge from what the user intended (e.g. altered items, hidden fees).
2. **State-Binding Failures (F4)**:
   - _T-31_: Replaying closed mandates or fanning out open mandates.
   - _T-32_: Mutating cart state after user review but before signature.
   - _T-37_: Settling lapsed authorizations with stale receipts.
3. **Core Conclusion (§9.1.1)**:
   > _"Agentic authorization must bind operational context, not only signed intent... Protocols should bind relevant pre-signature context to issued artifacts or reject execution paths that do not produce such bindings."_

---

## 3. The Role of CaptureLock

CaptureLock provides the missing contextual verifier:

- Evaluates live merchant state ($row\_hash$, stock, price) at the exact moment of charge.
- Verifies that pre-signature intent matches post-negotiation cart state.
- Binds operational context, execution trajectory, and payment idempotency into a single verifiable proof artifact.
