-- ============================================================================
-- Phase 5: bounded agentic commerce — session authority and aggregate budget.
-- ============================================================================
--
-- An `AuthorizedIntent` bounds one purchase and is consumed by the release that
-- spends it. That is the wrong shape for an autonomous agent, which makes
-- several purchases against one delegation. Without an aggregate, an agent
-- holding a ₹800-per-purchase mandate can spend ₹800 an unbounded number of
-- times, and every individual transaction passes every check — because the
-- check it needs to fail does not exist.
--
-- The tables below add that aggregate. As everywhere else in this schema, the
-- guarantee is the constraint rather than the application logic: the budget
-- cannot be overspent by any sequence of writes, including two that race,
-- because `commerce_sessions_budget_bounded` will not permit the row to exist.

-- --------------------------------------------------------- commerce sessions --
CREATE TABLE IF NOT EXISTS commerce_sessions (
  session_id         VARCHAR(64)  PRIMARY KEY,
  user_id            VARCHAR(128) NOT NULL,
  -- The user's own words. Carried for evidence and for the advisory reviewer;
  -- no deterministic check reads it, exactly as with `raw_intent_text`.
  purpose            TEXT         NOT NULL,
  bounds             JSONB        NOT NULL,
  -- Recomputed on every read, so raising a budget by editing this row is
  -- detected rather than enforced.
  bounds_hash        CHAR(64)     NOT NULL,
  policy_id          VARCHAR(64)  NOT NULL,
  policy_version     VARCHAR(32)  NOT NULL,
  currency           CHAR(3)      NOT NULL,
  total_budget_minor BIGINT       NOT NULL CHECK (total_budget_minor > 0),
  -- Committed to purchases in flight. Held until the release reaches a terminal
  -- state, so a crash mid-capture withholds budget rather than freeing it for a
  -- second spend.
  reserved_minor     BIGINT       NOT NULL DEFAULT 0,
  -- Confirmed moved at the provider.
  spent_minor        BIGINT       NOT NULL DEFAULT 0,
  state              VARCHAR(16)  NOT NULL
    CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  revoked_at         TIMESTAMPTZ,
  -- A session with no enforceable operator policy would be a delegation with no
  -- operator constraints at all, so it cannot be created.
  FOREIGN KEY (policy_id, policy_version) REFERENCES policies (policy_id, version),
  -- The single most important constraint added by this migration. Everything
  -- else about aggregate budget is an optimisation of the error message.
  CONSTRAINT commerce_sessions_budget_bounded
    CHECK (reserved_minor >= 0
           AND spent_minor >= 0
           AND reserved_minor + spent_minor <= total_budget_minor),
  CONSTRAINT commerce_sessions_window CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS commerce_sessions_user_idx
  ON commerce_sessions (user_id, created_at DESC);

-- ------------------------------------------------- commerce session purchases --
-- One row per purchase attempt: the hold it placed on the session budget, and
-- whether that hold has been resolved.
--
-- Keyed by authorization because a purchase attempt *is* the mandate it minted.
-- The settlement state is a compare-and-set target, which is what makes
-- counting spend exactly-once a property of the database rather than of the
-- caller being invoked exactly once.
CREATE TABLE IF NOT EXISTS commerce_session_purchases (
  authorization_id    VARCHAR(64) PRIMARY KEY
                        REFERENCES authorizations (authorization_id),
  session_id          VARCHAR(64) NOT NULL
                        REFERENCES commerce_sessions (session_id),
  -- Derived server-side from (session_id, agent idempotency key).
  purchase_request_id CHAR(64)    NOT NULL,
  reserved_minor      BIGINT      NOT NULL CHECK (reserved_minor >= 0),
  settlement_state    VARCHAR(16) NOT NULL
    CHECK (settlement_state IN ('RESERVED','SETTLED','RELEASED')),
  -- Binds the purchase to the agentic context recorded in the evidence chain.
  capsule_hash        CHAR(64)    NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ,
  -- A resolved hold must say when it was resolved, and an unresolved one must
  -- not claim to have been.
  CONSTRAINT commerce_session_purchases_settled_at
    CHECK ((settlement_state = 'RESERVED') = (settled_at IS NULL))
);

-- Exactly-once purchase requests. A retried request finds this row and is
-- handed back the authorization it already created, rather than minting a
-- second mandate against the same session. An application-level "have I seen
-- this key?" check would be racy; this is not.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_session_purchases_request_idx
  ON commerce_session_purchases (session_id, purchase_request_id);

-- Feeds the sweep that resolves holds stranded by a crash between the provider
-- call and the settlement write.
CREATE INDEX IF NOT EXISTS commerce_session_purchases_unsettled_idx
  ON commerce_session_purchases (created_at)
  WHERE settlement_state = 'RESERVED';

-- ------------------------------------------------------- agentic evidence kind --
-- The evidence chain gains one envelope kind, appended before the order gate so
-- a chain reads: what the agent was trying to buy and why, and only then what
-- CaptureLock decided about it.
--
-- The kind vocabulary is enumerated in exactly two places — `ENVELOPE_KINDS` in
-- packages/evidence/src/envelope.ts and this constraint. They must agree, or an
-- append that passes type-checking fails at the database.
ALTER TABLE evidence_envelopes
  DROP CONSTRAINT IF EXISTS evidence_envelopes_kind_check;

ALTER TABLE evidence_envelopes
  ADD CONSTRAINT evidence_envelopes_kind_check
  CHECK (kind IN ('DECISION','PROVIDER_OUTCOME','RELEASE_TRANSITION','WEBHOOK',
                  'REVIEW_RESOLUTION','AGENT_CONTEXT'));
