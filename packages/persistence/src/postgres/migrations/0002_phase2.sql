-- ============================================================================
-- Phase 2: request-level idempotency, and an index for the liveness sweep.
-- ============================================================================

-- ---------------------------------------------------------- idempotency ----
-- Request-scoped idempotency, distinct from the release-scoped layer that
-- already lives on `releases.client_idempotency_key`.
--
-- The two exist for different reasons. The release-scoped key answers "has this
-- authorization already been spent under this key?" and is what the kernel's
-- execution stage reads. This table answers "has this HTTP request already been
-- answered?", covers every mutating endpoint, and — crucially — survives a
-- process restart mid-request, because the IN_FLIGHT row is committed before
-- the work begins. See ADR-013.
CREATE TABLE IF NOT EXISTS idempotency_records (
  key           VARCHAR(255) PRIMARY KEY,
  route         VARCHAR(128) NOT NULL,
  -- Digest of the request body plus the authenticated principal. A key
  -- returning with a different fingerprint is refused rather than answered
  -- from cache: that is an attempt to get new input charged under an old
  -- approval.
  fingerprint   CHAR(64)     NOT NULL,
  status        VARCHAR(16)  NOT NULL CHECK (status IN ('IN_FLIGHT', 'COMPLETED')),
  status_code   INTEGER,
  response      JSONB,
  release_id    VARCHAR(64)  REFERENCES releases (release_id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  -- A completed record must carry the response it completed with, so a replay
  -- returns the same bytes rather than a plausible reconstruction.
  CHECK (status = 'IN_FLIGHT' OR (response IS NOT NULL AND status_code IS NOT NULL))
);

-- Lets the sweep find requests abandoned mid-flight by a crashed process.
CREATE INDEX IF NOT EXISTS idempotency_in_flight_idx
  ON idempotency_records (created_at)
  WHERE status = 'IN_FLIGHT';

-- ------------------------------------------------------- liveness sweep ----
-- Releases abandoned in a transient state hold their authorization's only
-- active-release slot. Without this index the sweep would scan the table; with
-- it, finding them is cheap enough to run on a timer.
--
-- Filtered on `updated_at` because these rows never had a provider call and so
-- never set `in_flight_since`.
CREATE INDEX IF NOT EXISTS releases_transient_idx
  ON releases (updated_at)
  WHERE state IN ('DRAFT', 'VERIFYING', 'VERIFIED', 'CAPTURE_VERIFYING', 'CAPTURE_APPROVED');
