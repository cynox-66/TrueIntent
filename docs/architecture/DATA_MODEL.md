# CaptureLock Data Model & Persistence Architecture

## 1. Overview

The CaptureLock persistence layer is designed for PostgreSQL using Drizzle ORM. It establishes atomic guarantees for:

- Exactly-once payment execution.
- Append-only, tamper-evident audit and evidence storage.
- Strict session and evaluation traceability.

---

## 2. Core Entities

```
+------------------+         +--------------------+         +--------------------+
|     sessions     | 1 --- * |   cart_snapshots   | 1 --- 1 |    evaluations     |
+------------------+         +--------------------+         +--------------------+
         │                                                            │
         │ 1                                                          │ 1
         │                                                            │
         ▼ *                                                          ▼ 1
+------------------+                                        +--------------------+
| evidence_env...  |                                        |      releases      |
+------------------+                                        +--------------------+
                                                                      │
                                                                      │ 1
                                                                      ▼ *
                                                            +--------------------+
                                                            |   webhook_inbox    |
                                                            +--------------------+
```

### 2.1 `sessions`

Represents an authorized agentic commerce interaction initiated by a user.

| Column             | Type         | Constraints             | Description                                                 |
| ------------------ | ------------ | ----------------------- | ----------------------------------------------------------- |
| `id`               | UUID         | PRIMARY KEY             | Unique session identifier                                   |
| `user_id`          | VARCHAR(128) | NOT NULL                | Identifier of the authorizing user                          |
| `raw_intent`       | TEXT         | NOT NULL                | Original user intent prompt                                 |
| `max_budget_minor` | BIGINT       | NOT NULL                | Authorized upper limit in minor currency units (e.g. paise) |
| `currency`         | VARCHAR(3)   | NOT NULL, DEFAULT 'INR' | ISO currency code                                           |
| `mandate_ref`      | VARCHAR(255) | NULLABLE                | Associated UPI Reserve Pay mandate or AP2 credential ID     |
| `status`           | VARCHAR(32)  | NOT NULL                | `ACTIVE`, `COMPLETED`, `ABORTED`, `EXPIRED`                 |
| `created_at`       | TIMESTAMPTZ  | NOT NULL, DEFAULT NOW() | Creation timestamp                                          |
| `updated_at`       | TIMESTAMPTZ  | NOT NULL, DEFAULT NOW() | Last update timestamp                                       |

### 2.2 `cart_snapshots`

Immutable snapshot of a proposed cart submitted by an agent prior to capture.

| Column               | Type         | Constraints             | Description                                             |
| -------------------- | ------------ | ----------------------- | ------------------------------------------------------- |
| `id`                 | UUID         | PRIMARY KEY             | Unique snapshot identifier                              |
| `session_id`         | UUID         | REFERENCES sessions(id) | Associated session                                      |
| `merchant_id`        | VARCHAR(128) | NOT NULL                | Target merchant identifier                              |
| `items_json`         | JSONB        | NOT NULL                | Array of items (SKU, qty, price, row_hash, observed_at) |
| `total_amount_minor` | BIGINT       | NOT NULL                | Computed total cart price                               |
| `snapshot_hash`      | VARCHAR(64)  | NOT NULL                | SHA-256 digest of canonical cart items                  |
| `created_at`         | TIMESTAMPTZ  | NOT NULL                | Submission timestamp                                    |

### 2.3 `evaluations`

Verification outcomes produced by the CaptureLock engine.

| Column             | Type        | Constraints                   | Description                                  |
| ------------------ | ----------- | ----------------------------- | -------------------------------------------- |
| `id`               | UUID        | PRIMARY KEY                   | Unique evaluation record ID                  |
| `session_id`       | UUID        | REFERENCES sessions(id)       | Associated session                           |
| `snapshot_id`      | UUID        | REFERENCES cart_snapshots(id) | Evaluated cart snapshot                      |
| `verdict`          | VARCHAR(16) | NOT NULL                      | `ALLOW`, `PAUSE`, `DENY`                     |
| `reason_codes`     | JSONB       | NOT NULL                      | Array of triggered reason codes              |
| `hard_checks_pass` | BOOLEAN     | NOT NULL                      | Result of deterministic predicate evaluation |
| `spirit_verdict`   | VARCHAR(16) | NULLABLE                      | `ALIGNED`, `MARGINAL`, `DIVERGED`            |
| `evaluated_at`     | TIMESTAMPTZ | NOT NULL                      | Timestamp of evaluation                      |

### 2.4 `releases`

Atomic payment authorization and execution records tracking Razorpay state.

| Column                | Type         | Constraints                | Description                                   |
| --------------------- | ------------ | -------------------------- | --------------------------------------------- |
| `id`                  | UUID         | PRIMARY KEY                | Unique release ID                             |
| `session_id`          | UUID         | REFERENCES sessions(id)    | Associated session                            |
| `evaluation_id`       | UUID         | REFERENCES evaluations(id) | Authorizing evaluation record                 |
| `idempotency_key`     | VARCHAR(128) | NOT NULL, UNIQUE           | Composite business idempotency key            |
| `razorpay_order_id`   | VARCHAR(64)  | NULLABLE, UNIQUE           | Razorpay test mode Order ID (`order_...`)     |
| `razorpay_payment_id` | VARCHAR(64)  | NULLABLE, UNIQUE           | Razorpay test mode Payment ID (`pay_...`)     |
| `status`              | VARCHAR(32)  | NOT NULL                   | `PENDING`, `AUTHORIZED`, `CAPTURED`, `FAILED` |
| `created_at`          | TIMESTAMPTZ  | NOT NULL                   | Creation timestamp                            |

### 2.5 `webhook_inbox`

Guarantees deduplication of asynchronous Razorpay webhook events.

| Column         | Type         | Constraints      | Description                                |
| -------------- | ------------ | ---------------- | ------------------------------------------ |
| `id`           | UUID         | PRIMARY KEY      | Internal inbox ID                          |
| `event_id`     | VARCHAR(128) | NOT NULL, UNIQUE | Upstream Razorpay event ID                 |
| `event_type`   | VARCHAR(64)  | NOT NULL         | E.g. `payment.captured`, `payment.failed`  |
| `payload_hash` | VARCHAR(64)  | NOT NULL         | SHA-256 digest of raw webhook body         |
| `processed_at` | TIMESTAMPTZ  | NOT NULL         | Processing timestamp                       |
| `status`       | VARCHAR(32)  | NOT NULL         | `PROCESSED`, `IGNORED_DUPLICATE`, `FAILED` |

### 2.6 `evidence_envelopes`

Append-only cryptographically chained ledger of all verification events.

| Column               | Type        | Constraints             | Description                                                 |
| -------------------- | ----------- | ----------------------- | ----------------------------------------------------------- |
| `id`                 | UUID        | PRIMARY KEY             | Unique envelope identifier                                  |
| `session_id`         | UUID        | REFERENCES sessions(id) | Associated session                                          |
| `sequence_number`    | BIGINT      | NOT NULL                | Monotonically increasing sequence number                    |
| `prev_envelope_hash` | VARCHAR(64) | NOT NULL                | Hash of previous envelope in chain                          |
| `envelope_hash`      | VARCHAR(64) | NOT NULL                | SHA-256 hash of this envelope's canonical payload           |
| `payload`            | JSONB       | NOT NULL                | Full envelope structure (intent, cart, live state, verdict) |
| `created_at`         | TIMESTAMPTZ | NOT NULL                | Commit timestamp                                            |

---

## 3. Open Design Decisions

- **Partitioning Strategy for `evidence_envelopes`**: STATUS: OPEN DECISION (Whether to partition by `created_at` monthly or maintain a unified table during prototype phase).
- **JSON Serialization Canonicalization**: STATUS: OPEN DECISION (Selection of canonical JSON serialization standard for computing `snapshot_hash` and `envelope_hash`, e.g. RFC 8785 JSON Canonicalization Scheme vs. sorted keys).
