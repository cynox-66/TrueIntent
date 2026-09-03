-- ============================================================================
-- CaptureLock schema.
--
-- The security-relevant guarantees in this file are the CONSTRAINTS, not the
-- columns. Application code can be rewritten by anyone; a unique index cannot
-- be talked out of its job by a race. Specifically:
--
--   * releases.client_idempotency_key UNIQUE    - one answer per client key
--   * releases.receipt UNIQUE                   - one provider receipt per release
--   * releases.provider_payment_id UNIQUE       - one release per payment
--   * releases_one_active_per_authorization     - PARTIAL unique index: at most one
--                                                 non-terminal release per authorization.
--                                                 This is what stops an authorization
--                                                 funding two purchases concurrently.
--   * webhook_inbox.provider_event_id UNIQUE    - webhook deduplication
--   * evidence_envelopes (chain_id, sequence)   - the chain cannot fork
--   * append-only triggers on the two audit tables
--
-- No table stores a secret. The evidence signing key lives in the environment;
-- Razorpay credentials are never persisted.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SET timezone = 'UTC';

-- ---------------------------------------------------------------- policies --
CREATE TABLE IF NOT EXISTS policies (
  policy_id     VARCHAR(64)  NOT NULL,
  version       VARCHAR(32)  NOT NULL,
  name          VARCHAR(128) NOT NULL,
  rules         JSONB        NOT NULL,
  policy_hash   CHAR(64)     NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (policy_id, version)
);

-- --------------------------------------------------------- authorizations --
CREATE TABLE IF NOT EXISTS authorizations (
  authorization_id       VARCHAR(64)  PRIMARY KEY,
  user_id                VARCHAR(128) NOT NULL,
  session_id             VARCHAR(128) NOT NULL,
  -- The user's own words. Carried for audit; never read by a deterministic check.
  raw_intent_text        TEXT         NOT NULL,
  -- The structured constraints and their content address. Editing the JSON
  -- without being able to recompute the hash is detected by the authority stage.
  constraints            JSONB        NOT NULL,
  normalization          JSONB        NOT NULL,
  intent_hash            CHAR(64)     NOT NULL,
  policy_id              VARCHAR(64)  NOT NULL,
  policy_version         VARCHAR(32)  NOT NULL,
  policy_hash            CHAR(64)     NOT NULL,
  state                  VARCHAR(16)  NOT NULL
    CHECK (state IN ('ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED')),
  consumed_by_release_id VARCHAR(64),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at             TIMESTAMPTZ,
  FOREIGN KEY (policy_id, policy_version) REFERENCES policies (policy_id, version)
);

CREATE INDEX IF NOT EXISTS authorizations_user_idx ON authorizations (user_id, created_at DESC);

-- ------------------------------------------------------- verified snapshots --
CREATE TABLE IF NOT EXISTS verified_snapshots (
  snapshot_id       VARCHAR(64) PRIMARY KEY,
  authorization_id  VARCHAR(64) NOT NULL REFERENCES authorizations (authorization_id),
  merchant_id       VARCHAR(128) NOT NULL,
  currency          CHAR(3)     NOT NULL,
  -- Server-priced cart. The agent never supplies an amount here.
  cart              JSONB       NOT NULL,
  item_subtotal_minor BIGINT    NOT NULL,
  fee_total_minor     BIGINT    NOT NULL,
  discount_total_minor BIGINT   NOT NULL,
  total_minor         BIGINT    NOT NULL CHECK (total_minor >= 0),
  row_hashes        JSONB       NOT NULL,
  live_state_digest CHAR(64)    NOT NULL,
  snapshot_hash     CHAR(64)    NOT NULL UNIQUE,
  observed_at       TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  state             VARCHAR(16) NOT NULL
    CHECK (state IN ('ISSUED', 'REDEEMED', 'SUPERSEDED', 'EXPIRED')),
  redeemed_by_release_id VARCHAR(64),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS snapshots_authorization_idx
  ON verified_snapshots (authorization_id, observed_at DESC);

-- ---------------------------------------------------------------- releases --
CREATE TABLE IF NOT EXISTS releases (
  release_id             VARCHAR(64)  PRIMARY KEY,
  authorization_id       VARCHAR(64)  NOT NULL REFERENCES authorizations (authorization_id),
  snapshot_id            VARCHAR(64)  NOT NULL REFERENCES verified_snapshots (snapshot_id),
  state                  VARCHAR(32)  NOT NULL,
  -- Agent-chosen. Dedups requests; cannot bound money movement on its own.
  client_idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  -- Digest of the materially significant request fields. A key returning with a
  -- different fingerprint is refused rather than answered from cache.
  request_fingerprint    CHAR(64)     NOT NULL,
  -- Server-derived from (authorization_id, snapshot_hash), <= 40 chars for the
  -- provider. Unique so one cart cannot be paid for twice.
  receipt                VARCHAR(40)  NOT NULL UNIQUE,
  amount_minor           BIGINT       NOT NULL CHECK (amount_minor >= 0),
  currency               CHAR(3)      NOT NULL,
  provider_order_id      VARCHAR(64)  UNIQUE,
  provider_payment_id    VARCHAR(64)  UNIQUE,
  attempt_count          INTEGER      NOT NULL DEFAULT 0,
  -- Set before a provider call and cleared after. A non-null value on a stuck
  -- row is how the reconciliation sweep finds work.
  in_flight_since        TIMESTAMPTZ,
  last_reason_codes      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (state IN (
    'DRAFT','VERIFYING','VERIFIED',
    'ORDER_IN_FLIGHT','ORDER_CREATED','ORDER_INDETERMINATE',
    'PAYMENT_AUTHORIZED','CAPTURE_VERIFYING','CAPTURE_APPROVED',
    'CAPTURE_IN_FLIGHT','CAPTURE_INDETERMINATE','CAPTURED','SETTLED',
    'PAUSED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED'
  ))
);

-- The single most important constraint in the schema.
--
-- At most one non-terminal release may exist per authorization. Two concurrent
-- requests to spend one mandate cannot both succeed, regardless of how many API
-- instances are running or what the application logic believes, because the
-- second INSERT violates this index.
CREATE UNIQUE INDEX IF NOT EXISTS releases_one_active_per_authorization
  ON releases (authorization_id)
  WHERE state NOT IN ('SETTLED', 'DENIED', 'CAPTURE_REJECTED', 'FAILED', 'ABORTED');

-- Supports the reconciliation sweep without scanning the table.
CREATE INDEX IF NOT EXISTS releases_reconciliation_idx
  ON releases (in_flight_since)
  WHERE state IN ('ORDER_IN_FLIGHT','ORDER_INDETERMINATE','CAPTURE_IN_FLIGHT','CAPTURE_INDETERMINATE');

-- ------------------------------------------------------------- evaluations --
-- Append-only: one immutable row per kernel decision.
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id    VARCHAR(64) PRIMARY KEY,
  authorization_id VARCHAR(64) NOT NULL REFERENCES authorizations (authorization_id),
  release_id       VARCHAR(64) REFERENCES releases (release_id),
  gate             VARCHAR(16) NOT NULL CHECK (gate IN ('ORDER_CREATION', 'CAPTURE')),
  verdict          VARCHAR(8)  NOT NULL CHECK (verdict IN ('ALLOW', 'PAUSE', 'DENY')),
  reason_codes     JSONB       NOT NULL,
  decision         JSONB       NOT NULL,
  context_hash     CHAR(64)    NOT NULL,
  decision_hash    CHAR(64)    NOT NULL,
  evaluated_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS evaluations_release_idx ON evaluations (release_id, evaluated_at);

-- ----------------------------------------------------------- webhook inbox --
CREATE TABLE IF NOT EXISTS webhook_inbox (
  -- The provider's own event id IS the primary key. Deduplication is therefore
  -- a constraint violation rather than a prior SELECT that could race.
  provider_event_id  VARCHAR(128) PRIMARY KEY,
  event_type         VARCHAR(64)  NOT NULL,
  payload_hash       CHAR(64)     NOT NULL,
  payload            JSONB        NOT NULL,
  signature_valid    BOOLEAN      NOT NULL,
  status             VARCHAR(32)  NOT NULL
    CHECK (status IN ('RECEIVED','PROCESSED','IGNORED_DUPLICATE','IGNORED_UNKNOWN','FAILED')),
  release_id         VARCHAR(64)  REFERENCES releases (release_id),
  provider_event_at  TIMESTAMPTZ,
  received_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMPTZ
);

-- ------------------------------------------------------- evidence envelopes --
CREATE TABLE IF NOT EXISTS evidence_envelopes (
  envelope_id     VARCHAR(64) PRIMARY KEY,
  chain_id        VARCHAR(64) NOT NULL,
  sequence        BIGINT      NOT NULL CHECK (sequence >= 0),
  prev_chain_hash CHAR(64)    NOT NULL,
  chain_hash      CHAR(64)    NOT NULL UNIQUE,
  signature       TEXT        NOT NULL,
  public_key_id   VARCHAR(32) NOT NULL,
  kind            VARCHAR(32) NOT NULL
    CHECK (kind IN ('DECISION','PROVIDER_OUTCOME','RELEASE_TRANSITION','WEBHOOK','REVIEW_RESOLUTION')),
  payload         JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The chain cannot fork: two concurrent appends cannot both claim a sequence.
  UNIQUE (chain_id, sequence)
);

CREATE INDEX IF NOT EXISTS evidence_chain_idx ON evidence_envelopes (chain_id, sequence);

-- ----------------------------------------------------------------- reviews --
CREATE TABLE IF NOT EXISTS review_requests (
  review_id        VARCHAR(64) PRIMARY KEY,
  release_id       VARCHAR(64) NOT NULL REFERENCES releases (release_id),
  authorization_id VARCHAR(64) NOT NULL REFERENCES authorizations (authorization_id),
  -- An approval authorizes THIS cart. Re-quoting produces a different hash and
  -- requires a new review.
  snapshot_hash    CHAR(64)    NOT NULL,
  reason_codes     JSONB       NOT NULL,
  state            VARCHAR(16) NOT NULL CHECK (state IN ('OPEN','APPROVED','REJECTED','EXPIRED')),
  resolved_by      VARCHAR(128),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_open_per_release
  ON review_requests (release_id) WHERE state = 'OPEN';

-- ------------------------------------------------------ append-only triggers --
-- "Append-only at the application level" is a convention, and conventions do
-- not survive an incident. These make it a property of the database: an UPDATE
-- or DELETE against the audit tables raises, whoever issues it.
CREATE OR REPLACE FUNCTION capturelock_reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'capturelock: % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_envelopes_append_only ON evidence_envelopes;
CREATE TRIGGER evidence_envelopes_append_only
  BEFORE UPDATE OR DELETE ON evidence_envelopes
  FOR EACH ROW EXECUTE FUNCTION capturelock_reject_mutation();

DROP TRIGGER IF EXISTS evaluations_append_only ON evaluations;
CREATE TRIGGER evaluations_append_only
  BEFORE UPDATE OR DELETE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION capturelock_reject_mutation();
