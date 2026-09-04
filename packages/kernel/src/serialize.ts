/**
 * Serialization of a verification context to and from canonicalizable JSON.
 *
 * This is what makes replay real rather than rhetorical. The evidence envelope
 * stores the serialized context; an auditor deserializes it, re-runs
 * `evaluate`, and compares decision hashes. If they match, the decision was not
 * merely *recorded* — it has been *reproduced* from its inputs.
 *
 * The round trip must be exact. The property the tests assert is not structural
 * equality but the one that matters: a context and its round-tripped twin must
 * produce byte-identical decisions.
 *
 * Maps become sorted arrays of pairs, because object keys here are SKUs and
 * SKUs are not restricted to the ASCII-identifier charset the canonical
 * serializer requires of keys.
 */

import {
  asSha256Hex,
  asTimestamp,
  hash,
  type Attribute,
  type AuthorizationRecord,
  type LiveItemState,
  type LiveMerchantState,
  type LiveStateResult,
  type ProposedCart,
  type Sha256Hex,
  type Sku,
  type VerifiedSnapshot,
} from '@capturelock/core';
import type { PolicyDocument } from '@capturelock/policy';
import type { ExecutionContext, VerificationContext } from './context.js';
import { deepFreeze } from './context.js';

type Json = Record<string, unknown>;

function sortedPairs<V>(map: ReadonlyMap<string, V>, encode: (value: V) => unknown): Json[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value: encode(value) }));
}

function encodeAttributes(attributes: readonly Attribute[]): Json[] {
  return [...attributes]
    .map(a => ({ name: a.name, value: a.value }))
    .sort((a, b) => (a.name === b.name ? cmp(a.value, b.value) : cmp(a.name, b.name)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeLiveItem(item: LiveItemState): Json {
  return {
    sku: item.sku,
    merchantId: item.merchantId,
    name: item.name,
    category: item.category,
    attributes: encodeAttributes(item.attributes),
    unitPrice: { currency: item.unitPrice.currency, amountMinor: item.unitPrice.amountMinor },
    available: item.available,
    availableStock: item.availableStock,
    subscriptionOnly: item.subscriptionOnly,
    updatedAt: item.updatedAt,
  };
}

function encodeCart(cart: ProposedCart): Json {
  return {
    merchantId: cart.merchantId,
    currency: cart.currency,
    recurring: cart.recurring,
    shipTo:
      cart.shipTo === null ? null : { country: cart.shipTo.country, region: cart.shipTo.region },
    declaredTotal: {
      currency: cart.declaredTotal.currency,
      amountMinor: cart.declaredTotal.amountMinor,
    },
    lines: cart.lines.map(line => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: { currency: line.unitPrice.currency, amountMinor: line.unitPrice.amountMinor },
      asserted: {
        name: line.asserted.name,
        category: line.asserted.category,
        attributes: encodeAttributes(line.asserted.attributes),
      },
    })),
    adjustments: cart.adjustments.map(a => ({
      type: a.type,
      label: a.label,
      amount: { currency: a.amount.currency, amountMinor: a.amount.amountMinor },
    })),
  };
}

function encodeLive(live: LiveStateResult): Json {
  if (live.kind === 'UNAVAILABLE') {
    return { kind: 'UNAVAILABLE', reason: live.reason, state: null };
  }
  const state = live.state;
  return {
    kind: 'OK',
    reason: null,
    state: {
      merchantId: state.merchantId,
      fetchedAt: state.fetchedAt,
      items: sortedPairs(state.items as ReadonlyMap<string, LiveItemState>, encodeLiveItem),
      feeQuote: {
        merchantId: state.feeQuote.merchantId,
        currency: state.feeQuote.currency,
        quotedAt: state.feeQuote.quotedAt,
        adjustments: state.feeQuote.adjustments.map(a => ({
          type: a.type,
          label: a.label,
          amount: { currency: a.amount.currency, amountMinor: a.amount.amountMinor },
        })),
      },
    },
  };
}

function encodeSnapshot(snapshot: VerifiedSnapshot | null): Json | null {
  if (snapshot === null) return null;
  return {
    snapshotId: snapshot.snapshotId,
    authorizationId: snapshot.authorizationId,
    merchantId: snapshot.merchantId,
    currency: snapshot.currency,
    cart: encodeCart(snapshot.cart),
    itemSubtotal: money(snapshot.itemSubtotal),
    feeTotal: money(snapshot.feeTotal),
    discountTotal: money(snapshot.discountTotal),
    total: money(snapshot.total),
    rowHashes: sortedPairs(snapshot.rowHashes as ReadonlyMap<string, Sha256Hex>, v => v),
    liveStateDigest: snapshot.liveStateDigest,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
    snapshotHash: snapshot.snapshotHash,
    state: snapshot.state,
    redeemedByReleaseId: snapshot.redeemedByReleaseId,
  };
}

function money(value: { currency: string; amountMinor: number }): Json {
  return { currency: value.currency, amountMinor: value.amountMinor };
}

function encodeAuthorization(record: AuthorizationRecord | null): Json | null {
  if (record === null) return null;
  const c = record.intent.constraints;
  return {
    authorizationId: record.authorizationId,
    userId: record.userId,
    sessionId: record.sessionId,
    intentHash: record.intentHash,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    policyHash: record.policyHash,
    state: record.state,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    consumedByReleaseId: record.consumedByReleaseId,
    intent: {
      rawText: record.intent.rawText,
      normalization: {
        method: record.intent.normalization.method,
        modelId: record.intent.normalization.modelId,
        confirmedByUser: record.intent.normalization.confirmedByUser,
      },
      constraints: {
        currency: c.currency,
        maxTotal: money(c.maxTotal),
        maxUnitPrice: c.maxUnitPrice === null ? null : money(c.maxUnitPrice),
        quantity: { min: c.quantity.min, max: c.quantity.max },
        allowedCategories: [...c.allowedCategories],
        forbiddenCategories: [...c.forbiddenCategories],
        requiredAttributes: c.requiredAttributes.map(p => ({ name: p.name, anyOf: [...p.anyOf] })),
        forbiddenAttributes: c.forbiddenAttributes.map(p => ({
          name: p.name,
          anyOf: [...p.anyOf],
        })),
        merchants:
          c.merchants.mode === 'ANY'
            ? { mode: 'ANY', merchantIds: null }
            : { mode: 'ALLOWLIST', merchantIds: [...c.merchants.merchantIds] },
        fees: {
          maxShipping: c.fees.maxShipping === null ? null : money(c.fees.maxShipping),
          maxTax: c.fees.maxTax === null ? null : money(c.fees.maxTax),
          maxTip: c.fees.maxTip === null ? null : money(c.fees.maxTip),
          maxConvenienceFee:
            c.fees.maxConvenienceFee === null ? null : money(c.fees.maxConvenienceFee),
          maxTotalFees: c.fees.maxTotalFees === null ? null : money(c.fees.maxTotalFees),
        },
        recurrence: c.recurrence,
        geography:
          c.geography === null
            ? null
            : {
                allowedCountries: [...c.geography.allowedCountries],
                allowedRegions:
                  c.geography.allowedRegions === null ? null : [...c.geography.allowedRegions],
              },
        maxSnapshotAgeSeconds: c.maxSnapshotAgeSeconds,
        notBefore: c.notBefore,
        notAfter: c.notAfter,
      },
    },
  };
}

function encodeExecution(execution: ExecutionContext): Json {
  const release = (value: ExecutionContext['release']): Json | null =>
    value === null
      ? null
      : {
          releaseId: value.releaseId,
          authorizationId: value.authorizationId,
          snapshotId: value.snapshotId,
          state: value.state,
          clientIdempotencyKey: value.clientIdempotencyKey,
          requestFingerprint: value.requestFingerprint,
          receipt: value.receipt,
          amount: money(value.amount),
          currency: value.currency,
          providerOrderId: value.providerOrderId,
          providerPaymentId: value.providerPaymentId,
          attemptCount: value.attemptCount,
          inFlightSince: value.inFlightSince,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          lastReasonCodes: [...value.lastReasonCodes],
        };

  return {
    release: release(execution.release),
    releaseForIdempotencyKey: release(execution.releaseForIdempotencyKey),
    otherActiveRelease: release(execution.otherActiveRelease),
    // Serialized so a replay of an approved decision reproduces it. Omitting
    // this would make every operator-approved ALLOW fail its own replay check,
    // which would look exactly like tampering.
    approvedReview:
      execution.approvedReview === null || execution.approvedReview === undefined
        ? null
        : {
            reviewId: execution.approvedReview.reviewId,
            boundTo: execution.approvedReview.boundTo,
            reasonCodes: [...execution.approvedReview.reasonCodes],
            resolvedBy: execution.approvedReview.resolvedBy,
            resolvedAt: execution.approvedReview.resolvedAt,
          },
    requestFingerprint: execution.requestFingerprint,
    attemptsInWindow: execution.attemptsInWindow,
    velocityWindowSeconds: execution.velocityWindowSeconds,
    maxAttemptsInWindow: execution.maxAttemptsInWindow,
  };
}

function encodePolicy(document: PolicyDocument | null): Json | null {
  if (document === null) return null;
  return {
    policyId: document.policyId,
    version: document.version,
    name: document.name,
    createdAt: document.createdAt,
    rules: [...document.rules],
  };
}

/** Fully self-describing projection of a context: everything `evaluate` reads. */
export function serializeContext(context: VerificationContext): Json {
  return {
    gate: context.gate,
    requestId: context.requestId,
    evaluatedAt: context.evaluatedAt,
    principal: { userId: context.principal.userId, sessionId: context.principal.sessionId },
    authorization: encodeAuthorization(context.authorization),
    policy: encodePolicy(context.policy),
    snapshot: encodeSnapshot(context.snapshot),
    proposal: encodeCart(context.proposal),
    live: encodeLive(context.live),
    execution: encodeExecution(context.execution),
  };
}

export function computeContextHash(context: VerificationContext): Sha256Hex {
  return hash('capturelock.v1.context', serializeContext(context));
}

/**
 * Rebuilds a context from its serialized form.
 *
 * Structural typing does most of the work: the encoded shape mirrors the domain
 * types field for field, so the only real work is turning pair arrays back into
 * Maps. The result is deep-frozen exactly as a freshly resolved context is, so
 * a replay runs under identical conditions to the original.
 */
export function deserializeContext(serialized: unknown): VerificationContext {
  const root = serialized as Json;
  const live = root['live'] as Json;

  let liveResult: LiveStateResult;
  if (live['kind'] === 'UNAVAILABLE') {
    liveResult = { kind: 'UNAVAILABLE', reason: String(live['reason']) };
  } else {
    const state = live['state'] as Json;
    const items = new Map<Sku, LiveItemState>();
    for (const pair of state['items'] as Json[]) {
      items.set(pair['key'] as Sku, pair['value'] as unknown as LiveItemState);
    }
    liveResult = {
      kind: 'OK',
      state: { ...(state as unknown as LiveMerchantState), items },
    };
  }

  const snapshotJson = root['snapshot'] as Json | null;
  let snapshot: VerifiedSnapshot | null = null;
  if (snapshotJson !== null) {
    const rowHashes = new Map<Sku, Sha256Hex>();
    for (const pair of snapshotJson['rowHashes'] as Json[]) {
      rowHashes.set(pair['key'] as Sku, asSha256Hex(String(pair['value'])));
    }
    snapshot = { ...(snapshotJson as unknown as VerifiedSnapshot), rowHashes };
  }

  const context: VerificationContext = {
    gate: root['gate'] as VerificationContext['gate'],
    requestId: root['requestId'] as VerificationContext['requestId'],
    evaluatedAt: asTimestamp(String(root['evaluatedAt'])),
    principal: root['principal'] as VerificationContext['principal'],
    authorization: root['authorization'] as AuthorizationRecord | null,
    policy: root['policy'] as PolicyDocument | null,
    snapshot,
    proposal: root['proposal'] as unknown as ProposedCart,
    live: liveResult,
    // Normalized rather than cast straight through: envelopes recorded before
    // approvals existed carry no `approvedReview`, and replaying one must
    // reproduce its original decision rather than throw. Absent means "no
    // approval was in play", which is exactly what those decisions assumed.
    execution: normalizeExecution(root['execution']),
  };

  return deepFreeze(context);
}

/** Fills in fields added after an envelope was written. */
function normalizeExecution(raw: unknown): ExecutionContext {
  const execution = raw as ExecutionContext;
  return {
    ...execution,
    approvedReview: execution.approvedReview ?? null,
  };
}
