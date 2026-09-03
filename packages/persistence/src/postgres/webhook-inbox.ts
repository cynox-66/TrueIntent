/**
 * Postgres webhook inbox.
 *
 * `claim` is an `INSERT ... ON CONFLICT DO NOTHING` against a primary key that
 * IS the provider's event id. Under ten simultaneous deliveries of one event,
 * exactly one insert returns a row and the other nine return none. There is no
 * prior SELECT, because a SELECT-then-INSERT is precisely the race this table
 * exists to close.
 */

import { asSha256Hex, timestampFromDate } from '@capturelock/core';
import type {
  ReleaseId,
  Timestamp,
  WebhookClaimResult,
  WebhookInboxRecord,
  WebhookInboxRepository,
  WebhookInboxStatus,
} from '@capturelock/core';
import type { Queryable } from './client.js';

interface InboxRow extends Record<string, unknown> {
  provider_event_id: string;
  event_type: string;
  payload_hash: string;
  payload: unknown;
  signature_valid: boolean;
  status: string;
  release_id: string | null;
  provider_event_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
}

function toRecord(row: InboxRow): WebhookInboxRecord {
  return {
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    payloadHash: asSha256Hex(row.payload_hash),
    payload: row.payload,
    signatureValid: row.signature_valid,
    status: row.status as WebhookInboxStatus,
    releaseId: row.release_id as ReleaseId | null,
    providerEventAt:
      row.provider_event_at === null ? null : timestampFromDate(row.provider_event_at),
    receivedAt: timestampFromDate(row.received_at),
    processedAt: row.processed_at === null ? null : timestampFromDate(row.processed_at),
  };
}

const SELECT = `
  SELECT provider_event_id, event_type, payload_hash, payload, signature_valid,
         status, release_id, provider_event_at, received_at, processed_at
  FROM webhook_inbox`;

export class PostgresWebhookInboxRepository implements WebhookInboxRepository {
  constructor(private readonly db: Queryable) {}

  async claim(record: WebhookInboxRecord): Promise<WebhookClaimResult> {
    const rows = await this.db.query<InboxRow>(
      `INSERT INTO webhook_inbox (
         provider_event_id, event_type, payload_hash, payload, signature_valid,
         status, provider_event_at, received_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING provider_event_id, event_type, payload_hash, payload, signature_valid,
                 status, release_id, provider_event_at, received_at, processed_at`,
      [
        record.providerEventId,
        record.eventType,
        record.payloadHash,
        JSON.stringify(record.payload ?? null),
        record.signatureValid,
        record.status,
        record.providerEventAt,
        record.receivedAt,
      ],
    );

    if (rows.length === 1) return { kind: 'CLAIMED', record: toRecord(rows[0]!) };

    // Someone else claimed it. Read back what they stored so the caller can see
    // how the original delivery was handled.
    const existing = await this.findByEventId(record.providerEventId);
    return { kind: 'DUPLICATE', existing: existing ?? record };
  }

  async markProcessed(
    providerEventId: string,
    status: WebhookInboxStatus,
    at: Timestamp,
    releaseId: ReleaseId | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE webhook_inbox SET status = $2, processed_at = $3, release_id = COALESCE($4, release_id)
       WHERE provider_event_id = $1`,
      [providerEventId, status, at, releaseId],
    );
  }

  async findByEventId(providerEventId: string): Promise<WebhookInboxRecord | null> {
    const rows = await this.db.query<InboxRow>(`${SELECT} WHERE provider_event_id = $1`, [
      providerEventId,
    ]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }
}
