/**
 * Stage 4: does the transaction still match live commercial reality?
 *
 * This is the capture-time TOCTOU guard, and it works differently from the
 * design Phase 0 documented.
 *
 * The old design compared an agent-supplied `sourceRowHash` against the live
 * row hash. That detects *honest* drift only: a malicious agent simply sends
 * whatever hash is current and passes. What actually protects the user is
 * comparing **the terms about to be charged** against **the terms the merchant
 * will honour right now**. Row hashes still appear here, but only to attribute
 * drift in the evidence — never to gate it. See ADR-008.
 *
 * Any price difference in either direction is refused. A higher live price
 * means the order is underfunded; a lower one means the user is being
 * overcharged relative to what the merchant is currently selling for. Neither
 * is something to wave through.
 */

import {
  finding,
  liveItemRowHash,
  millisBetween,
  isAfter,
  type Finding,
  type LiveItemState,
  type Sku,
} from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { blocked, completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'FRESHNESS' as const;

export const freshnessStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const findings: Finding[] = [];
    const snapshot = context.snapshot;

    if (snapshot !== null) {
      if (isAfter(context.evaluatedAt, snapshot.expiresAt)) {
        findings.push(
          finding(
            STAGE,
            'SNAPSHOT_EXPIRED',
            'The verified snapshot expired before execution was attempted.',
            {
              expiresAt: snapshot.expiresAt,
              evaluatedAt: context.evaluatedAt,
              observedAt: snapshot.observedAt,
            },
          ),
        );
      }

      const constraints = context.authorization?.intent.constraints;
      if (constraints) {
        const ageSeconds = Math.floor(
          millisBetween(snapshot.observedAt, context.evaluatedAt) / 1000,
        );
        if (ageSeconds > constraints.maxSnapshotAgeSeconds) {
          findings.push(
            finding(
              STAGE,
              'SNAPSHOT_EXPIRED',
              'The snapshot is older than the freshness window the user authorized.',
              { ageSeconds, maxAgeSeconds: constraints.maxSnapshotAgeSeconds },
            ),
          );
        }
      }
    }

    // A merchant we could not reach is not a merchant whose prices we can
    // vouch for. Refusing is the only safe reading of "unknown".
    if (context.live.kind === 'UNAVAILABLE') {
      findings.push(
        finding(
          STAGE,
          'LIVE_STATE_UNAVAILABLE',
          'Live merchant state could not be read, so the transaction cannot be re-verified against it.',
          { reason: context.live.reason },
        ),
      );
      return blocked('live-state', findings);
    }

    const live = context.live.state;
    const cart = context.proposal;

    if (live.merchantId !== cart.merchantId) {
      findings.push(
        finding(
          STAGE,
          'LIVE_MERCHANT_DIVERGED',
          'The live record was read from a different merchant than the cart names.',
          { liveMerchantId: live.merchantId, cartMerchantId: cart.merchantId },
        ),
      );
    }

    for (const line of cart.lines) {
      const item = live.items.get(line.sku);
      if (item === undefined) {
        findings.push(
          finding(STAGE, 'LIVE_ITEM_NOT_FOUND', 'A cart SKU is no longer in the live catalogue.', {
            sku: line.sku,
          }),
        );
        continue;
      }

      findings.push(
        ...checkItem(
          line.sku,
          line.quantity,
          line.unitPrice.amountMinor,
          line.unitPrice.currency,
          item,
        ),
      );

      // Row-hash comparison against the snapshot: this does not gate the
      // decision on its own, it explains *what* changed when a price or
      // attribute check above has already failed.
      const issuedRowHash = context.snapshot?.rowHashes.get(line.sku);
      const currentRowHash = liveItemRowHash(item);
      if (issuedRowHash !== undefined && issuedRowHash !== currentRowHash) {
        const attributesChanged =
          !sameAttributes(item, context) &&
          item.unitPrice.amountMinor === line.unitPrice.amountMinor;
        if (attributesChanged) {
          findings.push(
            finding(
              STAGE,
              'LIVE_ATTRIBUTE_DIVERGED',
              'The live item changed since the snapshot was issued in a way that is not price or stock.',
              { sku: line.sku, issuedRowHash, currentRowHash },
            ),
          );
        }
      }
    }

    findings.push(...checkFees(context));

    return completed(findings);
  },
};

function checkItem(
  sku: Sku,
  quantity: number,
  chargedUnitPriceMinor: number,
  chargedCurrency: string,
  item: LiveItemState,
): Finding[] {
  const findings: Finding[] = [];

  if (item.unitPrice.currency !== chargedCurrency) {
    findings.push(
      finding(
        STAGE,
        'LIVE_CURRENCY_DIVERGED',
        'The live listing currency differs from the charge.',
        {
          sku,
          liveCurrency: item.unitPrice.currency,
          chargedCurrency,
        },
      ),
    );
    // Prices in different currencies are not comparable; stop for this line.
    return findings;
  }

  if (item.unitPrice.amountMinor !== chargedUnitPriceMinor) {
    findings.push(
      finding(
        STAGE,
        'LIVE_PRICE_DIVERGED',
        'The live unit price is not the price this transaction would charge.',
        {
          sku,
          liveUnitPriceMinor: item.unitPrice.amountMinor,
          chargedUnitPriceMinor,
          direction: item.unitPrice.amountMinor > chargedUnitPriceMinor ? 'INCREASED' : 'DECREASED',
        },
      ),
    );
  }

  if (!item.available) {
    findings.push(
      finding(
        STAGE,
        'LIVE_ITEM_UNAVAILABLE',
        'The merchant currently lists this item as unavailable.',
        {
          sku,
        },
      ),
    );
  }

  if (item.availableStock < quantity) {
    findings.push(
      finding(STAGE, 'LIVE_INSUFFICIENT_STOCK', 'Live stock is below the requested quantity.', {
        sku,
        availableStock: item.availableStock,
        requestedQuantity: quantity,
      }),
    );
  }

  return findings;
}

/** Compares the merchant's current fee quote against the fees being charged. */
function checkFees(context: VerificationContext): Finding[] {
  if (context.live.kind !== 'OK') return [];
  const quoted = context.live.state.feeQuote;
  const charged = context.proposal.adjustments;

  const key = (a: { type: string; label: string }): string => `${a.type}:${a.label}`;
  const quotedMap = new Map(quoted.adjustments.map(a => [key(a), a.amount.amountMinor]));
  const chargedMap = new Map(charged.map(a => [key(a), a.amount.amountMinor]));

  const findings: Finding[] = [];
  for (const [k, chargedMinor] of chargedMap) {
    const quotedMinor = quotedMap.get(k);
    if (quotedMinor === undefined) {
      findings.push(
        finding(
          STAGE,
          'LIVE_FEE_DIVERGED',
          'The transaction carries a fee the merchant does not currently quote.',
          {
            adjustment: k,
            chargedMinor,
          },
        ),
      );
    } else if (quotedMinor !== chargedMinor) {
      findings.push(
        finding(STAGE, 'LIVE_FEE_DIVERGED', 'A fee differs from the current merchant quote.', {
          adjustment: k,
          chargedMinor,
          quotedMinor,
        }),
      );
    }
  }
  for (const [k, quotedMinor] of quotedMap) {
    if (!chargedMap.has(k)) {
      findings.push(
        finding(
          STAGE,
          'LIVE_FEE_DIVERGED',
          'The merchant now quotes a fee this transaction does not include.',
          { adjustment: k, quotedMinor },
        ),
      );
    }
  }
  return findings;
}

/** True when the live item's attributes still match what the snapshot recorded. */
function sameAttributes(item: LiveItemState, context: VerificationContext): boolean {
  const snapshotLine = context.snapshot?.cart.lines.find(line => line.sku === item.sku);
  if (snapshotLine === undefined) return true;
  const before = [...snapshotLine.asserted.attributes]
    .map(a => `${a.name}=${a.value}`)
    .sort()
    .join('|');
  const after = [...item.attributes]
    .map(a => `${a.name}=${a.value}`)
    .sort()
    .join('|');
  return before === after && snapshotLine.asserted.category === item.category;
}
