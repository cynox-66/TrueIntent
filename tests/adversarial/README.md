# Adversarial Test Suite (Reserved for Phase 3)

This directory is designated for adversarial evaluation scenarios proving that TrueIntent deterministically prevents unauthorized money execution.

Planned test scenarios:

1. `stale-price-toctou`: Merchant updates price mid-flight; stale snapshot is rejected.
2. `inventory-exhaustion`: Stock depleted between quote and capture; execution blocked.
3. `intent-drift`: Agent wanders from initial intent (e.g. dinner ingredients -> energy drinks); detected and denied.
4. `policy-ceiling-breach`: Agent negotiates discount above category ceiling; hard vetoed.
5. `concurrent-webhook-replay`: 10 identical webhook deliveries result in exactly one execution.
6. `retry-storm-protection`: Repeated failed attempts trigger velocity circuit-breaker.
