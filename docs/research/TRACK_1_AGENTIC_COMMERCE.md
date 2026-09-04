# Razorpay Buildathon Track 1 & Agentic Commerce Research

## 1. Razorpay Buildathon 2026 Context

### Track 1: AI Growth & Agentic Commerce

- **Official Prompt**: "Build an agent that grows revenue for a merchant on Razorpay test-mode APIs, or that makes a merchant transactable by an AI buyer end to end."
- **Why Now**: The confluence of NPCI's Unified Authorization Protocol (UAP), global agent payment protocol races (ACP, AP2, x402), and live domestic pilots (Razorpay + NPCI + OpenAI ChatGPT shopping pilot with bigbasket; UPI Reserve Pay live in beta; UPI Circle upcoming).
- **The Bar**: "Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."
- **Evaluation Signals**:
  1. _Problem taste_: Choosing a problem that fundamentally matters to Razorpay's strategic roadmap.
  2. _Build quality_: "Does it run, is it structured, would you trust it."
  3. _AI judgment_: Knowing where to use AI (semantics, intent) and where NOT to use AI (money, math, policy).
  4. _Failure recovery_: Concrete, honest explanation of what broke and how the system recovered.

---

## 2. Razorpay Strategic Direction: "Age of Agentic Payments"

At Sprint 2026, Razorpay announced a company-wide pivot to agentic payments:

- **Agentic Stack & Agentic Platform**: Infrastructure enabling AI agents to act as trusted transacting entities.
- **Agent Studio**: Specialized operational agents (Dispute Responder, Subscription Recovery, RTO Shield, Settlement Insights, Cashflow Forecaster).
- **NPCI & Domestic Pilots**:
  - UPI Reserve Pay: Spend blocks with merchant spend limits.
  - UPI Circle: Delegated secondary payment authorization.

### The Missing Primitive

While Razorpay and its partners are building the rails (UPI Reserve Pay) and the merchant operations agents (Agent Studio), there is an open infrastructure vacuum at the moment of capture:

> **How does a payment gateway prove that an autonomous agent transacting under delegated authorization is charging the right cart, at the right price, according to live merchant state and genuine user intent?**

TrueIntent directly targets this missing verifier primitive.
