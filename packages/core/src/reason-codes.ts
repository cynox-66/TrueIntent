/**
 * The closed vocabulary of reasons TrueIntent can give for a decision.
 *
 * A reason code is part of the public contract: it appears in API responses, in
 * evidence envelopes, and in the adversarial suite's expectations. Codes are
 * therefore never renamed or repurposed, only added.
 *
 * Each code declares a default severity. Severity is fixed for every stage
 * except the policy stage, where an operator-authored rule may declare its own
 * severity (for example "a tip over the cap should ask a human rather than
 * refuse outright"). That freedom is confined to policy because the policy is
 * server-side and bound to the authorization at issuance — the agent cannot
 * choose it. Structural, authority, snapshot, freshness and execution findings
 * keep their fixed severity so no configuration can weaken them.
 */

export type Severity = 'DENY' | 'PAUSE' | 'INFO';

export type ReasonStage =
  | 'STRUCTURAL'
  | 'AUTHORITY'
  | 'SNAPSHOT'
  | 'INTENT'
  | 'POLICY'
  | 'FRESHNESS'
  | 'EXECUTION'
  | 'KERNEL'
  | 'ADVISORY'
  | 'SESSION'
  | 'AGENT'
  | 'INFORMATIONAL';

interface ReasonDefinition {
  readonly stage: ReasonStage;
  readonly severity: Severity;
  readonly description: string;
}

function def(stage: ReasonStage, severity: Severity, description: string): ReasonDefinition {
  return { stage, severity, description };
}

export const REASON_CODE_DEFINITIONS = {
  // ---------------------------------------------------------------- structural
  MALFORMED_REQUEST: def('STRUCTURAL', 'DENY', 'Request failed schema validation at the boundary.'),
  EMPTY_CART: def('STRUCTURAL', 'DENY', 'Proposed cart contains no line items.'),
  CART_TOO_LARGE: def('STRUCTURAL', 'DENY', 'Proposed cart exceeds the maximum line-item count.'),
  DUPLICATE_LINE_ITEM: def('STRUCTURAL', 'DENY', 'The same SKU appears in more than one line.'),
  CART_ARITHMETIC_MISMATCH: def(
    'STRUCTURAL',
    'DENY',
    'Agent-declared total does not equal the total recomputed from line items and adjustments.',
  ),
  CART_CURRENCY_INCONSISTENT: def(
    'STRUCTURAL',
    'DENY',
    'Line items or adjustments mix currencies within one cart.',
  ),
  NEGATIVE_EFFECTIVE_TOTAL: def(
    'STRUCTURAL',
    'DENY',
    'Adjustments drive the cart total below zero.',
  ),

  // ----------------------------------------------------------------- authority
  AUTHORIZATION_NOT_FOUND: def('AUTHORITY', 'DENY', 'No authorization exists for the given id.'),
  AUTHORIZATION_EXPIRED: def('AUTHORITY', 'DENY', 'The authorization validity window has passed.'),
  AUTHORIZATION_NOT_YET_VALID: def(
    'AUTHORITY',
    'DENY',
    'The authorization validity window has not begun.',
  ),
  AUTHORIZATION_REVOKED: def('AUTHORITY', 'DENY', 'The authorization was revoked by the user.'),
  AUTHORIZATION_ALREADY_CONSUMED: def(
    'AUTHORITY',
    'DENY',
    'The authorization was already spent by a settled release; this is a replay.',
  ),
  USER_MISMATCH: def(
    'AUTHORITY',
    'DENY',
    'The requesting principal does not own this authorization.',
  ),
  INTENT_HASH_MISMATCH: def(
    'AUTHORITY',
    'DENY',
    'The stored intent does not hash to the value recorded at issuance; the authorization was altered.',
  ),
  SESSION_MISMATCH: def(
    'AUTHORITY',
    'DENY',
    'The presented session does not match the one bound to this authorization.',
  ),

  // ------------------------------------------------------------------ snapshot
  SNAPSHOT_NOT_FOUND: def('SNAPSHOT', 'DENY', 'No verified snapshot exists for the given id.'),
  SNAPSHOT_HASH_MISMATCH: def(
    'SNAPSHOT',
    'DENY',
    'Recomputed snapshot hash differs from the stored hash; the snapshot was altered.',
  ),
  SNAPSHOT_NOT_BOUND_TO_AUTHORIZATION: def(
    'SNAPSHOT',
    'DENY',
    'The snapshot belongs to a different authorization.',
  ),
  SNAPSHOT_ALREADY_REDEEMED: def(
    'SNAPSHOT',
    'DENY',
    'The snapshot was already redeemed by another release.',
  ),
  SNAPSHOT_EXPIRED: def(
    'SNAPSHOT',
    'DENY',
    'The snapshot freshness window elapsed before execution.',
  ),
  SNAPSHOT_TOTALS_INCONSISTENT: def(
    'SNAPSHOT',
    'DENY',
    'The totals stored on the snapshot disagree with the totals its own line items imply.',
  ),
  PROPOSAL_DIVERGES_FROM_SNAPSHOT: def(
    'SNAPSHOT',
    'DENY',
    'The proposed cart does not match the server-issued snapshot it claims to redeem.',
  ),

  // -------------------------------------------------------------------- intent
  INTENT_ATTRIBUTE_MISSING: def(
    'INTENT',
    'DENY',
    'A required product attribute is absent from the live item.',
  ),
  INTENT_ATTRIBUTE_FORBIDDEN: def(
    'INTENT',
    'DENY',
    'The live item carries an attribute the user excluded.',
  ),
  INTENT_CATEGORY_MISMATCH: def(
    'INTENT',
    'DENY',
    'The live item is not in a category the user authorized.',
  ),
  INTENT_QUANTITY_OUT_OF_BAND: def(
    'INTENT',
    'DENY',
    'Quantity falls outside the authorized minimum/maximum band.',
  ),
  INTENT_UNIT_PRICE_EXCEEDED: def(
    'INTENT',
    'DENY',
    'A unit price exceeds the per-item ceiling the user authorized.',
  ),
  INTENT_TOTAL_EXCEEDED: def(
    'INTENT',
    'DENY',
    'The transaction total exceeds the ceiling the user authorized.',
  ),
  INTENT_FEE_EXCEEDED: def('INTENT', 'DENY', 'A fee exceeds the ceiling the user authorized.'),
  INTENT_CURRENCY_MISMATCH: def(
    'INTENT',
    'DENY',
    'The transaction currency is not the one the user authorized.',
  ),
  MERCHANT_NOT_AUTHORIZED: def(
    'INTENT',
    'DENY',
    'The merchant is not permitted by the authorized intent.',
  ),
  SUBSCRIPTION_NOT_AUTHORIZED: def(
    'INTENT',
    'DENY',
    'The transaction is recurring but the user authorized a one-time purchase.',
  ),
  SHIP_TO_NOT_AUTHORIZED: def(
    'INTENT',
    'DENY',
    'The shipping destination is outside the authorized geography.',
  ),
  AGENT_MISREPRESENTED_ITEM: def(
    'INTENT',
    'DENY',
    'Item details asserted by the agent contradict the live merchant record.',
  ),

  // -------------------------------------------------------------------- policy
  TOTAL_EXCEEDS_LIMIT: def('POLICY', 'DENY', 'Cart total exceeds the policy ceiling.'),
  UNIT_PRICE_EXCEEDS_LIMIT: def('POLICY', 'DENY', 'A unit price exceeds the policy ceiling.'),
  QUANTITY_EXCEEDS_LIMIT: def('POLICY', 'DENY', 'A line quantity exceeds the policy ceiling.'),
  LINE_ITEM_COUNT_EXCEEDS_LIMIT: def(
    'POLICY',
    'DENY',
    'The cart has more distinct line items than policy allows.',
  ),
  CURRENCY_NOT_ALLOWED: def('POLICY', 'DENY', 'The transaction currency is not permitted.'),
  MERCHANT_NOT_IN_ALLOWLIST: def('POLICY', 'DENY', 'The merchant is not on the policy allowlist.'),
  MERCHANT_IN_DENYLIST: def('POLICY', 'DENY', 'The merchant is on the policy denylist.'),
  FEE_EXCEEDS_LIMIT: def('POLICY', 'DENY', 'A fee adjustment exceeds its absolute policy ceiling.'),
  FEE_RATIO_EXCEEDS_LIMIT: def(
    'POLICY',
    'DENY',
    'A fee exceeds its permitted ratio of the item subtotal.',
  ),
  TIP_EXCEEDS_LIMIT: def('POLICY', 'DENY', 'The tip exceeds the policy ceiling.'),
  CATEGORY_PROHIBITED: def('POLICY', 'DENY', 'The cart contains a prohibited category.'),
  CATEGORY_NOT_ALLOWED: def(
    'POLICY',
    'DENY',
    'A line item is in a category the policy does not permit.',
  ),
  ATTRIBUTE_REQUIREMENT_UNMET: def(
    'POLICY',
    'DENY',
    'A line item does not carry an attribute the policy requires.',
  ),
  POLICY_RULE_INAPPLICABLE: def(
    'POLICY',
    'DENY',
    'A policy rule cannot be evaluated against this transaction (for example a currency mismatch); refusing rather than ignoring it.',
  ),
  SUBSCRIPTION_PROHIBITED: def('POLICY', 'DENY', 'Policy forbids recurring charges.'),
  SNAPSHOT_AGE_EXCEEDS_POLICY: def(
    'POLICY',
    'DENY',
    'The snapshot is older than the policy freshness window.',
  ),
  POLICY_NOT_FOUND: def('POLICY', 'DENY', 'No policy document is bound to this authorization.'),
  POLICY_HASH_MISMATCH: def(
    'POLICY',
    'DENY',
    'The loaded policy does not hash to the value bound at issuance.',
  ),
  POLICY_RULE_UNKNOWN: def(
    'POLICY',
    'DENY',
    'The policy contains a rule this engine does not understand; refusing rather than skipping it.',
  ),

  // ----------------------------------------------------------------- freshness
  LIVE_STATE_UNAVAILABLE: def(
    'FRESHNESS',
    'DENY',
    'Live merchant state could not be read; TrueIntent refuses rather than trusting a stale copy.',
  ),
  LIVE_ITEM_NOT_FOUND: def('FRESHNESS', 'DENY', 'A cart SKU no longer exists in the live catalog.'),
  LIVE_PRICE_DIVERGED: def(
    'FRESHNESS',
    'DENY',
    'The live unit price differs from the price being paid.',
  ),
  LIVE_CURRENCY_DIVERGED: def(
    'FRESHNESS',
    'DENY',
    'The live listing currency differs from the transaction currency.',
  ),
  LIVE_ITEM_UNAVAILABLE: def('FRESHNESS', 'DENY', 'The live item is flagged unavailable.'),
  LIVE_INSUFFICIENT_STOCK: def('FRESHNESS', 'DENY', 'Live stock is below the requested quantity.'),
  LIVE_ATTRIBUTE_DIVERGED: def(
    'FRESHNESS',
    'DENY',
    'Live item attributes changed since the snapshot was issued.',
  ),
  LIVE_FEE_DIVERGED: def(
    'FRESHNESS',
    'DENY',
    'The merchant now quotes different fees from the ones the transaction carries.',
  ),
  LIVE_MERCHANT_DIVERGED: def(
    'FRESHNESS',
    'DENY',
    'The live record belongs to a different merchant than the snapshot.',
  ),

  // ----------------------------------------------------------------- execution
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: def(
    'EXECUTION',
    'DENY',
    'This idempotency key was already used for a materially different request.',
  ),
  RELEASE_ALREADY_TERMINAL: def(
    'EXECUTION',
    'DENY',
    'The release has reached a terminal state and cannot act again.',
  ),
  INVALID_RELEASE_STATE_FOR_GATE: def(
    'EXECUTION',
    'DENY',
    'The release is not in a state from which this gate may run.',
  ),
  AUTHORIZATION_HAS_ACTIVE_RELEASE: def(
    'EXECUTION',
    'DENY',
    'Another non-terminal release already exists for this authorization.',
  ),
  RELEASE_AMOUNT_DIVERGED: def(
    'EXECUTION',
    'DENY',
    'The amount to capture differs from the amount verified and recorded at order creation.',
  ),
  RELEASE_ABANDONED: def(
    'EXECUTION',
    'INFO',
    'A release left in a transient state was aborted by the liveness sweep, freeing its authorization. The provider was never called.',
  ),
  RETRY_VELOCITY_EXCEEDED: def(
    'EXECUTION',
    'PAUSE',
    // Says what is measured, which is a lifetime count of attempts on this
    // release rather than a sliding window. `velocityWindowSeconds` is carried
    // into the finding for context but bounds nothing: per-attempt timestamps
    // would be needed to window this, and are not persisted. Stated plainly
    // rather than implied away — see the limitations section of the README.
    'Too many release attempts; a human should look.',
  ),
  CONCURRENT_RELEASE_IN_PROGRESS: def(
    'EXECUTION',
    'PAUSE',
    'A concurrent request for the same release won the race.',
  ),

  // -------------------------------------------------------------------- kernel
  KERNEL_STAGE_ERROR: def(
    'KERNEL',
    'DENY',
    'A verification stage threw; the kernel fails closed rather than skipping the check.',
  ),
  STAGE_DID_NOT_COMPLETE: def(
    'KERNEL',
    'DENY',
    'A mandatory verification stage did not report completion.',
  ),

  // ------------------------------------------------------------------ advisory
  ADVISORY_UNAVAILABLE: def(
    'ADVISORY',
    'INFO',
    'The advisory intent reviewer was unavailable; it can only restrict, so its absence changes nothing.',
  ),
  ADVISORY_INTENT_MARGINAL: def(
    'ADVISORY',
    'PAUSE',
    'The advisory reviewer judged the cart a marginal fit for the stated intent.',
  ),
  ADVISORY_INTENT_DIVERGED: def(
    'ADVISORY',
    'DENY',
    'The advisory reviewer judged the cart to have diverged from the stated intent.',
  ),

  // ------------------------------------------------------------------- session
  //
  // The delegated-authority layer above a single mandate. These refuse a
  // purchase *request* before an authorization exists, so none of them can
  // reach the kernel: a session failure means no mandate was ever minted, which
  // is why they are refusals rather than findings.
  SESSION_NOT_FOUND: def('SESSION', 'DENY', 'No commerce session exists for the given id.'),
  SESSION_EXPIRED: def('SESSION', 'DENY', 'The commerce session validity window has passed.'),
  SESSION_REVOKED: def('SESSION', 'DENY', 'The commerce session was revoked by the user.'),
  SESSION_NOT_OWNED: def(
    'SESSION',
    'DENY',
    'The requesting principal does not own this commerce session.',
  ),
  SESSION_BOUNDS_HASH_MISMATCH: def(
    'SESSION',
    'DENY',
    'The stored session bounds do not hash to the value recorded at delegation; the session was altered.',
  ),
  SESSION_BUDGET_EXCEEDED: def(
    'SESSION',
    'DENY',
    // The check a per-transaction ceiling structurally cannot make: each
    // purchase is individually within its cap, and together they exceed what
    // the user delegated.
    'The purchase would exceed the budget remaining on the session, counting purchases already made.',
  ),
  SESSION_PURCHASE_NOT_PERMITTED: def(
    'SESSION',
    'DENY',
    'The proposed purchase falls outside the bounds the user delegated to this session.',
  ),

  // --------------------------------------------------------------------- agent
  //
  // Failures of the buyer agent itself. An agent failure must never be able to
  // become a payment success, so each of these terminates the request without
  // reaching a gate.
  INVALID_AGENT_ACTION: def(
    'AGENT',
    'DENY',
    'The agent proposed an action that failed validation against its tool schema or the current session state.',
  ),
  AGENT_STEP_LIMIT_EXCEEDED: def(
    'AGENT',
    'DENY',
    'The agent exhausted its step budget without reaching a purchase decision.',
  ),
  CART_NOT_GROUNDED: def(
    'AGENT',
    'DENY',
    'A cart line names a SKU the merchant catalog does not currently offer, so nothing grounds it.',
  ),
  AGENT_MODEL_UNAVAILABLE: def(
    'AGENT',
    'DENY',
    'The buyer model could not be reached. Refusing to shop is safe; guessing is not.',
  ),

  // ------------------------------------------------------------- informational
  VERIFIED_MATCH: def(
    'INFORMATIONAL',
    'INFO',
    'All mandatory verification stages passed with no findings.',
  ),
  IDEMPOTENT_REPLAY: def(
    'INFORMATIONAL',
    'INFO',
    'A previously stored decision was returned for a repeated request.',
  ),
  WEBHOOK_DUPLICATE_IGNORED: def(
    'INFORMATIONAL',
    'INFO',
    'A webhook event with an already-seen event id was discarded.',
  ),
  WEBHOOK_OUT_OF_ORDER_IGNORED: def(
    'INFORMATIONAL',
    'INFO',
    'A webhook implied a backwards state transition and was recorded without applying it.',
  ),
  REVIEW_APPROVAL_APPLIED: def(
    'INFORMATIONAL',
    'INFO',
    'An operator approval, bound to this exact snapshot, cleared the pause findings it covers.',
  ),
  WEBHOOK_ENTITY_MISMATCH: def(
    'EXECUTION',
    'DENY',
    'A webhook carried a payment whose order or amount does not match the release it addressed.',
  ),
} as const satisfies Record<string, ReasonDefinition>;

export type ReasonCode = keyof typeof REASON_CODE_DEFINITIONS;

export const REASON_CODES = Object.keys(REASON_CODE_DEFINITIONS) as readonly ReasonCode[];

export function reasonSeverity(code: ReasonCode): Severity {
  return REASON_CODE_DEFINITIONS[code].severity;
}

export function reasonStage(code: ReasonCode): ReasonStage {
  return REASON_CODE_DEFINITIONS[code].stage;
}

export function reasonDescription(code: ReasonCode): string {
  return REASON_CODE_DEFINITIONS[code].description;
}

export function isReasonCode(value: string): value is ReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_CODE_DEFINITIONS, value);
}

/** Ranks severity so the verdict combiner can take a maximum deterministically. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  INFO: 0,
  PAUSE: 1,
  DENY: 2,
});
