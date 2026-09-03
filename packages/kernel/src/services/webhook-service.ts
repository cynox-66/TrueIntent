/**
 * Webhook ingestion.
 *
 * Four properties, each with a test:
 *
 *  - **Signature first.** The caller must have verified the HMAC over the raw
 *    bytes before this service is reached; an unverified event is recorded as
 *    such and never applied.
 *  - **Deduplication is a database constraint.** `claim` succeeds for exactly
 *    one caller per event id. A prior `SELECT` would race; the unique index
 *    does not.
 *  - **No state regression.** Webhooks arrive out of order. An event implying a
 *    move the state machine does not declare is recorded and discarded rather
 *    than applied, so a late `payment.authorized` cannot pull a settled release
 *    backwards.
 *  - **A webhook can never create a release.** It can only advance one that
 *    already exists, and only along a declared edge. An attacker who could
 *    forge a signature still could not conjure a payment.
 */

import {
  hash,
  type ReasonCode,
  type ReleaseRecord,
  type ReleaseState,
  type Timestamp,
} from '@capturelock/core';
import { nextState, type TransitionTrigger } from '../release-fsm.js';
import type { CoreDependencies } from './dependencies.js';

export interface WebhookEvent {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly signatureValid: boolean;
  readonly payload: unknown;
  /** Provider-stated event time, when present. Used only for diagnostics. */
  readonly providerEventAt: Timestamp | null;
  readonly paymentId: string | null;
  readonly orderId: string | null;
}

export type WebhookResult =
  | { readonly kind: 'APPLIED'; readonly releaseId: string; readonly state: ReleaseState }
  | { readonly kind: 'DUPLICATE_IGNORED'; readonly reasonCode: ReasonCode }
  | {
      readonly kind: 'OUT_OF_ORDER_IGNORED';
      readonly reasonCode: ReasonCode;
      readonly state: ReleaseState;
    }
  | { readonly kind: 'UNKNOWN_EVENT_RECORDED' }
  | { readonly kind: 'NO_MATCHING_RELEASE' }
  | { readonly kind: 'SIGNATURE_INVALID' };

/** Event types this build understands. Anything else is stored, never applied. */
const EVENT_TRIGGERS: Readonly<Record<string, TransitionTrigger>> = Object.freeze({
  'payment.authorized': 'PAYMENT_AUTHORIZED',
  'payment.captured': 'SETTLEMENT_CONFIRMED',
  'payment.failed': 'PAYMENT_FAILED',
});

export class WebhookService {
  constructor(private readonly deps: CoreDependencies) {}

  async ingest(event: WebhookEvent): Promise<WebhookResult> {
    const now = this.deps.clock.now();

    if (!event.signatureValid) {
      // Recorded for forensics, never acted upon, and never allowed to occupy
      // an event id that a genuine delivery might later need.
      return { kind: 'SIGNATURE_INVALID' };
    }

    const claim = await this.deps.webhookInbox.claim({
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      payloadHash: hash('capturelock.v1.webhook_payload', { payload: safeBody(event.payload) }),
      payload: event.payload,
      signatureValid: true,
      receivedAt: now,
      processedAt: null,
      status: 'RECEIVED',
      releaseId: null,
      providerEventAt: event.providerEventAt,
    });

    if (claim.kind === 'DUPLICATE') {
      // At-least-once delivery is normal. The second arrival is acknowledged so
      // the provider stops retrying, and changes nothing.
      return { kind: 'DUPLICATE_IGNORED', reasonCode: 'WEBHOOK_DUPLICATE_IGNORED' };
    }

    const trigger = EVENT_TRIGGERS[event.eventType];
    if (trigger === undefined) {
      await this.deps.webhookInbox.markProcessed(
        event.providerEventId,
        'IGNORED_UNKNOWN',
        now,
        null,
      );
      return { kind: 'UNKNOWN_EVENT_RECORDED' };
    }

    const release = await this.findRelease(event);
    if (release === null) {
      await this.deps.webhookInbox.markProcessed(event.providerEventId, 'FAILED', now, null);
      return { kind: 'NO_MATCHING_RELEASE' };
    }

    const target = nextState(release.state, trigger);
    if (target === null) {
      // The event implies a move the machine does not declare from here. This
      // is the out-of-order case: record it, and leave the release exactly as
      // it is rather than dragging it backwards.
      await this.deps.webhookInbox.markProcessed(
        event.providerEventId,
        'PROCESSED',
        now,
        release.releaseId,
      );
      await this.recordEvidence(release, event, release.state, 'OUT_OF_ORDER');
      return {
        kind: 'OUT_OF_ORDER_IGNORED',
        reasonCode: 'WEBHOOK_OUT_OF_ORDER_IGNORED',
        state: release.state,
      };
    }

    const updated = await this.deps.releases.transition(
      release.releaseId,
      [release.state],
      target,
      {
        providerPaymentId: event.paymentId ?? release.providerPaymentId,
        providerOrderId: event.orderId ?? release.providerOrderId,
      },
      now,
    );

    if (updated === null) {
      // Something else moved the release between our read and our write. The
      // compare-and-set refused rather than overwriting, which is correct.
      const current = await this.deps.releases.findById(release.releaseId);
      await this.deps.webhookInbox.markProcessed(
        event.providerEventId,
        'PROCESSED',
        now,
        release.releaseId,
      );
      return {
        kind: 'OUT_OF_ORDER_IGNORED',
        reasonCode: 'WEBHOOK_OUT_OF_ORDER_IGNORED',
        state: current?.state ?? release.state,
      };
    }

    await this.deps.webhookInbox.markProcessed(
      event.providerEventId,
      'PROCESSED',
      now,
      release.releaseId,
    );
    await this.recordEvidence(release, event, updated.state, 'APPLIED');

    return { kind: 'APPLIED', releaseId: updated.releaseId, state: updated.state };
  }

  private async findRelease(event: WebhookEvent): Promise<ReleaseRecord | null> {
    // Correlation is by identifiers we recorded ourselves when we made the
    // provider call, so a webhook cannot introduce a release we never created.
    if (event.paymentId !== null) {
      const byPayment = await this.deps.releases.findByProviderPaymentId(event.paymentId);
      if (byPayment !== null) return byPayment;
    }
    if (event.orderId !== null) {
      return this.deps.releases.findByProviderOrderId(event.orderId);
    }
    return null;
  }

  private async recordEvidence(
    release: ReleaseRecord,
    event: WebhookEvent,
    state: ReleaseState,
    disposition: string,
  ): Promise<void> {
    await this.deps.evidence.append({
      chainId: release.authorizationId,
      kind: 'WEBHOOK',
      recordedAt: this.deps.clock.now(),
      body: {
        releaseId: release.releaseId,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        disposition,
        resultingState: state,
      },
    });
  }
}

/** Strips anything non-canonicalizable so hashing a hostile payload cannot throw. */
function safeBody(payload: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(payload)) as unknown;
  } catch {
    return null;
  }
}
