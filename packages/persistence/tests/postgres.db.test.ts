/**
 * Concurrency guarantees, proved against a real Postgres.
 *
 * The in-memory repositories model the right *shape*, but on a single-threaded
 * event loop they cannot prove anything about several API instances sharing a
 * database. Only these tests can, which is why they exist separately and why
 * the honest claim in the documentation is scoped to what they cover.
 *
 * Opt in with:  pnpm db:up && pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  asTimestamp,
  deriveReceipt,
  hash,
  money,
  newAuthorizationId,
  newReleaseId,
  newSessionId,
  newSnapshotId,
  type AuthorizationId,
  type IdempotencyKey,
  type ReleaseRecord,
  type SnapshotId,
} from '@capturelock/core';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import { Database, isAppendOnlyViolation } from '../src/postgres/client.js';
import { PostgresReleaseRepository } from '../src/postgres/release-repository.js';
import { PostgresWebhookInboxRepository } from '../src/postgres/webhook-inbox.js';
import { PostgresEvidenceLedger } from '../src/postgres/evidence-ledger.js';
import { PostgresSessionAuthorityRepository } from '../src/postgres/session-repository.js';

const CONNECTION =
  process.env['DATABASE_URL'] ??
  'postgresql://capturelock:capturelock@localhost:5432/capturelock_dev';

const AT = asTimestamp('2026-09-03T10:00:00.000Z');
const EXPIRES = asTimestamp('2026-09-04T10:00:00.000Z');

let db: Database;
let releases: PostgresReleaseRepository;
let inbox: PostgresWebhookInboxRepository;
let ledger: PostgresEvidenceLedger;
const keys = generateEvidenceKeyPair();

beforeAll(async () => {
  db = new Database({ connectionString: CONNECTION, max: 20 });
  await db.reset();
  await db.migrate();
  releases = new PostgresReleaseRepository(db);
  inbox = new PostgresWebhookInboxRepository(db);
  ledger = new PostgresEvidenceLedger(
    db,
    createSigner(keys.privateKeyPkcs8Base64),
    createVerifier(keys.publicKeySpkiBase64),
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query(
    `TRUNCATE commerce_session_purchases, commerce_sessions, review_requests,
     webhook_inbox, evidence_envelopes, evaluations,
     releases, verified_snapshots, authorizations, policies CASCADE`,
  );
});

async function seedAuthorization(): Promise<AuthorizationId> {
  await db.query(
    `INSERT INTO policies (policy_id, version, name, rules, policy_hash, created_at)
     VALUES ('p','1.0.0','test','[]'::jsonb,$1,$2)
     ON CONFLICT DO NOTHING`,
    ['a'.repeat(64), AT],
  );
  const id = newAuthorizationId();
  await db.query(
    `INSERT INTO authorizations (
       authorization_id, user_id, session_id, raw_intent_text, constraints,
       normalization, intent_hash, policy_id, policy_version, policy_hash, state, created_at, updated_at
     ) VALUES ($1,'u','s','text','{}'::jsonb,'{}'::jsonb,$2,'p','1.0.0',$3,'ACTIVE',$4,$4)`,
    [id, 'b'.repeat(64), 'a'.repeat(64), AT],
  );
  return id;
}

async function seedSnapshot(authorizationId: AuthorizationId): Promise<SnapshotId> {
  const id = newSnapshotId();
  await db.query(
    `INSERT INTO verified_snapshots (
       snapshot_id, authorization_id, merchant_id, currency, cart,
       item_subtotal_minor, fee_total_minor, discount_total_minor, total_minor,
       row_hashes, live_state_digest, snapshot_hash, observed_at, expires_at, state
     ) VALUES ($1,$2,'m','INR','{}'::jsonb,479900,15000,0,494900,'{}'::jsonb,$3,$4,$5,$6,'ISSUED')`,
    [
      id,
      authorizationId,
      'c'.repeat(64),
      hash('capturelock.v1.snapshot', { id }),
      AT,
      asTimestamp('2026-09-03T10:00:30.000Z'),
    ],
  );
  return id;
}

function draft(
  authorizationId: AuthorizationId,
  snapshotId: SnapshotId,
  key: string,
): ReleaseRecord {
  const snapshotHash = hash('capturelock.v1.snapshot', { key });
  return {
    releaseId: newReleaseId(),
    authorizationId,
    snapshotId,
    state: 'DRAFT',
    clientIdempotencyKey: `idem-${key.padEnd(12, '0')}` as IdempotencyKey,
    requestFingerprint: hash('capturelock.v1.request_fingerprint', { key }),
    receipt: deriveReceipt(authorizationId, snapshotHash),
    amount: money('INR', 494_900),
    currency: 'INR',
    providerOrderId: null,
    providerPaymentId: null,
    attemptCount: 0,
    inFlightSince: null,
    createdAt: AT,
    updatedAt: AT,
    lastReasonCodes: [],
  };
}

describe('one active release per authorization', () => {
  it('lets exactly one of ten concurrent inserts through', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        releases.insert(draft(authorizationId, snapshotId, `race${i}`)),
      ),
    );

    // The partial unique index decides this, not application logic.
    expect(results.filter(r => r.kind === 'INSERTED')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'AUTHORIZATION_BUSY')).toHaveLength(9);

    const count = await db.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM releases WHERE authorization_id = $1',
      [authorizationId],
    );
    expect(count[0]?.n).toBe('1');
  });

  it('permits a new release once the previous one is terminal', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);

    const first = await releases.insert(draft(authorizationId, snapshotId, 'first'));
    expect(first.kind).toBe('INSERTED');

    await releases.transition(
      (first as { release: ReleaseRecord }).release.releaseId,
      ['DRAFT'],
      'DENIED',
      {},
      AT,
    );

    const second = await releases.insert(draft(authorizationId, snapshotId, 'second'));
    expect(second.kind).toBe('INSERTED');
  });

  it('rejects a reused client idempotency key', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);
    const record = draft(authorizationId, snapshotId, 'same');

    expect((await releases.insert(record)).kind).toBe('INSERTED');
    const again = await releases.insert({ ...record, releaseId: newReleaseId() });
    expect(again.kind).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });
});

describe('compare-and-set transitions', () => {
  it('lets exactly one of ten concurrent transitions win', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);
    const inserted = await releases.insert(draft(authorizationId, snapshotId, 'cas'));
    const releaseId = (inserted as { release: ReleaseRecord }).release.releaseId;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        releases.transition(releaseId, ['DRAFT'], 'VERIFYING', {}, AT),
      ),
    );

    // This is the guarantee that stops two concurrent captures both proceeding.
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect(results.filter(r => r === null)).toHaveLength(9);
  });

  it('refuses a transition from a state not in the source list', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);
    const inserted = await releases.insert(draft(authorizationId, snapshotId, 'wrong'));
    const releaseId = (inserted as { release: ReleaseRecord }).release.releaseId;

    expect(
      await releases.transition(releaseId, ['CAPTURE_APPROVED'], 'CAPTURE_IN_FLIGHT', {}, AT),
    ).toBeNull();
    expect((await releases.findById(releaseId))?.state).toBe('DRAFT');
  });

  it('races the capture write-ahead so only one caller may call the provider', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);
    const inserted = await releases.insert(draft(authorizationId, snapshotId, 'capture'));
    const releaseId = (inserted as { release: ReleaseRecord }).release.releaseId;
    await releases.transition(releaseId, ['DRAFT'], 'CAPTURE_APPROVED', {}, AT);

    const winners = await Promise.all(
      Array.from({ length: 8 }, () =>
        releases.transition(
          releaseId,
          ['CAPTURE_APPROVED'],
          'CAPTURE_IN_FLIGHT',
          { inFlightSince: AT },
          AT,
        ),
      ),
    );
    expect(winners.filter(r => r !== null)).toHaveLength(1);
  });
});

describe('webhook inbox deduplication', () => {
  it('claims an event exactly once under ten simultaneous deliveries', async () => {
    const record = {
      providerEventId: 'evt_concurrent',
      eventType: 'payment.captured',
      payloadHash: hash('capturelock.v1.webhook_payload', { a: 1 }),
      payload: { a: 1 },
      signatureValid: true,
      receivedAt: AT,
      processedAt: null,
      status: 'RECEIVED' as const,
      releaseId: null,
      providerEventAt: AT,
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => inbox.claim(record)));
    expect(results.filter(r => r.kind === 'CLAIMED')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'DUPLICATE')).toHaveLength(9);

    const rows = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM webhook_inbox');
    expect(rows[0]?.n).toBe('1');
  });
});

describe('evidence ledger under concurrency', () => {
  it('does not fork the chain when appends race', async () => {
    const chainId = 'chn_concurrent';
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.append({ chainId, kind: 'DECISION', body: { i }, recordedAt: AT }),
      ),
    );

    const chain = await ledger.listByChain(chainId);
    expect(chain).toHaveLength(20);
    // Contiguous sequences and an unbroken prev-hash link mean the advisory
    // lock did its job.
    expect(chain.map(e => e.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect((await ledger.verifyChain(chainId)).valid).toBe(true);
  });

  it('verifies a chain written across separate transactions', async () => {
    const chainId = 'chn_serial';
    for (let i = 0; i < 5; i += 1) {
      await ledger.append({ chainId, kind: 'DECISION', body: { i }, recordedAt: AT });
    }
    const head = await ledger.head(chainId);
    expect((await ledger.verifyChain(chainId, head!.chainHash)).valid).toBe(true);
  });
});

describe('append-only enforcement at the database', () => {
  it('rejects an UPDATE against evidence_envelopes', async () => {
    await ledger.append({ chainId: 'chn_ro', kind: 'DECISION', body: { a: 1 }, recordedAt: AT });
    let caught: unknown = null;
    try {
      await db.query(`UPDATE evidence_envelopes SET payload = '{"a":2}'::jsonb`);
    } catch (error) {
      caught = error;
    }
    // Not a convention the application keeps: the database refuses.
    expect(caught).not.toBeNull();
    expect(isAppendOnlyViolation(caught)).toBe(true);
  });

  it('rejects a DELETE against evidence_envelopes', async () => {
    await ledger.append({ chainId: 'chn_ro2', kind: 'DECISION', body: { a: 1 }, recordedAt: AT });
    let caught: unknown = null;
    try {
      await db.query('DELETE FROM evidence_envelopes');
    } catch (error) {
      caught = error;
    }
    expect(isAppendOnlyViolation(caught)).toBe(true);
  });

  it('rejects an UPDATE against evaluations', async () => {
    const authorizationId = await seedAuthorization();
    await db.query(
      `INSERT INTO evaluations (evaluation_id, authorization_id, gate, verdict,
        reason_codes, decision, context_hash, decision_hash, evaluated_at)
       VALUES ('evl_1',$1,'CAPTURE','DENY','[]'::jsonb,'{}'::jsonb,$2,$3,$4)`,
      [authorizationId, 'd'.repeat(64), 'e'.repeat(64), AT],
    );
    let caught: unknown = null;
    try {
      await db.query(`UPDATE evaluations SET verdict = 'ALLOW'`);
    } catch (error) {
      caught = error;
    }
    expect(isAppendOnlyViolation(caught)).toBe(true);
  });
});

describe('the aggregate session budget', () => {
  /**
   * Seeds a session with a 2,000 budget and an 800 per-purchase cap.
   *
   * Those numbers are the demo's, and they are chosen so that the interesting
   * case is reachable: after 700 and 600 are committed, an 800 purchase is
   * *inside* the per-transaction ceiling and outside what the user delegated.
   */
  async function seedSession(): Promise<string> {
    await db.query(
      `INSERT INTO policies (policy_id, version, name, rules, policy_hash, created_at)
       VALUES ('p','1.0.0','test','[]'::jsonb,$1,$2)
       ON CONFLICT DO NOTHING`,
      ['a'.repeat(64), AT],
    );
    const id = newSessionId();
    // Real bounds JSON rather than `{}`: the repository re-parses `expiresAt`
    // through `asTimestamp` on read rather than trusting the stored value, so a
    // placeholder here would fail loudly — which is the behaviour we want.
    const bounds = {
      currency: 'INR',
      totalBudget: money('INR', 200_000),
      maxPerPurchase: money('INR', 80_000),
      merchants: { mode: 'ANY' },
      allowedCategories: [],
      forbiddenCategories: [],
      itemsPerPurchase: { min: 1, max: 8 },
      recurrence: 'ONE_TIME_ONLY',
      expiresAt: EXPIRES,
    };
    await db.query(
      `INSERT INTO commerce_sessions (
         session_id, user_id, purpose, bounds, bounds_hash, policy_id,
         policy_version, currency, total_budget_minor, reserved_minor,
         spent_minor, state, created_at, updated_at, expires_at
       ) VALUES ($1,'u','dinner',$2::jsonb,$3,'p','1.0.0','INR',200000,0,0,'ACTIVE',$4,$4,$5)`,
      [id, JSON.stringify(bounds), 'd'.repeat(64), AT, EXPIRES],
    );
    return id;
  }

  it('lets exactly two of ten concurrent 700-paise reserves through', async () => {
    // The heart of the aggregate-budget claim. Ten agents race for a 2,000
    // budget in 700 increments; arithmetic allows two, and the database must
    // permit exactly two however the requests interleave. An application-level
    // "read the balance, then check it" would let several through here.
    const sessionId = await seedSession();
    const sessions = new PostgresSessionAuthorityRepository(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        sessions.reserve(sessionId as never, money('INR', 70_000), AT),
      ),
    );

    const reserved = results.filter(r => r.kind === 'RESERVED');
    const refused = results.filter(r => r.kind === 'REFUSED');
    expect({ reserved: reserved.length, refused: refused.length }).toEqual({
      reserved: 2,
      refused: 8,
    });

    // And the row agrees: 1,400 held, not 7,000.
    const current = await sessions.findById(sessionId as never);
    expect(current?.reservedMinor).toBe(140_000);
  });

  it('refuses to let the CHECK constraint be crossed even by a direct write', async () => {
    // The constraint is the guarantee, not the WHERE clause. If `reserve` were
    // ever rewritten into a read-then-write, this is what would still stop an
    // overspend — so it is asserted directly rather than assumed.
    const sessionId = await seedSession();
    await expect(
      db.query(`UPDATE commerce_sessions SET reserved_minor = 200001 WHERE session_id = $1`, [
        sessionId,
      ]),
    ).rejects.toThrow(/commerce_sessions_budget_bounded/);
  });

  it('settles a hold exactly once under ten concurrent settlements', async () => {
    // Money moved once. Ten sweepers noticing simultaneously must count it
    // once, which is the purchase row's compare-and-set rather than a guard in
    // the caller.
    const sessionId = await seedSession();
    const sessions = new PostgresSessionAuthorityRepository(db);
    await sessions.reserve(sessionId as never, money('INR', 70_000), AT);

    const authorizationId = await seedAuthorization();
    await sessions.recordPurchase({
      authorizationId,
      sessionId: sessionId as never,
      purchaseRequestId: hash('capturelock.v1.purchase_request', { k: 1 }),
      reservedMinor: 70_000,
      settlementState: 'RESERVED',
      capsuleHash: 'e'.repeat(64) as never,
      createdAt: AT,
      settledAt: null,
    });

    const settled = await Promise.all(
      Array.from({ length: 10 }, () => sessions.settlePurchase(authorizationId, AT)),
    );
    expect(settled.filter(r => r !== null)).toHaveLength(1);

    const current = await sessions.findById(sessionId as never);
    expect({ reserved: current?.reservedMinor, spent: current?.spentMinor }).toEqual({
      reserved: 0,
      spent: 70_000,
    });
  });

  it('admits exactly one of ten concurrent identical purchase requests', async () => {
    // The retry path under contention: one row recorded, nine told it already
    // exists, so a retried purchase can never mint a second mandate.
    const sessionId = await seedSession();
    const sessions = new PostgresSessionAuthorityRepository(db);
    const requestId = hash('capturelock.v1.purchase_request', { k: 'same' });

    const authorizationIds = await Promise.all(
      Array.from({ length: 10 }, () => seedAuthorization()),
    );

    const results = await Promise.all(
      authorizationIds.map(authorizationId =>
        sessions.recordPurchase({
          authorizationId,
          sessionId: sessionId as never,
          purchaseRequestId: requestId,
          reservedMinor: 70_000,
          settlementState: 'RESERVED',
          capsuleHash: 'e'.repeat(64) as never,
          createdAt: AT,
          settledAt: null,
        }),
      ),
    );

    expect(results.filter(r => r.kind === 'RECORDED')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'DUPLICATE_REQUEST')).toHaveLength(9);
  });
});

describe('money precision', () => {
  it('round-trips a large amount through BIGINT without losing precision', async () => {
    const authorizationId = await seedAuthorization();
    const snapshotId = await seedSnapshot(authorizationId);
    const record = {
      ...draft(authorizationId, snapshotId, 'big'),
      amount: money('INR', 9_999_999_999_999),
    };
    await releases.insert(record);
    const read = await releases.findById(record.releaseId);
    expect(read?.amount.amountMinor).toBe(9_999_999_999_999);
  });
});
