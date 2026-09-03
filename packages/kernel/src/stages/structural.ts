/**
 * Stage 1: structural integrity of the cart being charged.
 *
 * Runs even though the cart came from our own snapshot, because "we wrote it"
 * is not the same as "it is still what we wrote". A row edited in the database
 * between quote and capture is caught here, and the arithmetic check is the one
 * that refuses to charge a total nobody computed.
 */

import {
  MAX_CART_LINES,
  computeCartTotals,
  finding,
  type Finding,
  type ProposedCart,
} from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'STRUCTURAL' as const;

export const structuralStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const findings: Finding[] = [];
    const cart: ProposedCart = context.proposal;

    if (cart.lines.length === 0) {
      findings.push(finding(STAGE, 'EMPTY_CART', 'The cart has no line items.'));
      return completed(findings);
    }

    // The request schema bounds this, but a cart reaching the kernel came from
    // storage rather than from a request body, so the bound is re-checked here.
    if (cart.lines.length > MAX_CART_LINES) {
      findings.push(
        finding(STAGE, 'CART_TOO_LARGE', 'The cart exceeds the maximum line-item count.', {
          lines: cart.lines.length,
          limit: MAX_CART_LINES,
        }),
      );
    }

    const seen = new Set<string>();
    for (const line of cart.lines) {
      if (seen.has(line.sku)) {
        findings.push(
          finding(
            STAGE,
            'DUPLICATE_LINE_ITEM',
            'The same SKU appears in more than one line, which makes quantity ceilings ambiguous.',
            { sku: line.sku },
          ),
        );
      }
      seen.add(line.sku);

      if (line.unitPrice.currency !== cart.currency) {
        findings.push(
          finding(
            STAGE,
            'CART_CURRENCY_INCONSISTENT',
            'A line is priced in a different currency.',
            {
              sku: line.sku,
              lineCurrency: line.unitPrice.currency,
              cartCurrency: cart.currency,
            },
          ),
        );
      }
    }

    for (const adjustment of cart.adjustments) {
      if (adjustment.amount.currency !== cart.currency) {
        findings.push(
          finding(
            STAGE,
            'CART_CURRENCY_INCONSISTENT',
            'An adjustment is denominated in a different currency.',
            {
              label: adjustment.label,
              adjustmentCurrency: adjustment.amount.currency,
              cartCurrency: cart.currency,
            },
          ),
        );
      }
    }

    // Any currency inconsistency makes the totals meaningless, and
    // `computeCartTotals` would throw. Stop here with what we have.
    if (findings.some(f => f.code === 'CART_CURRENCY_INCONSISTENT')) {
      return completed(findings);
    }

    const totals = computeCartTotals(cart);

    if (totals.computedTotal.amountMinor !== cart.declaredTotal.amountMinor) {
      findings.push(
        finding(
          STAGE,
          'CART_ARITHMETIC_MISMATCH',
          'The declared total does not equal the total recomputed from line items and adjustments.',
          {
            declaredMinor: cart.declaredTotal.amountMinor,
            recomputedMinor: totals.computedTotal.amountMinor,
            itemSubtotalMinor: totals.itemSubtotal.amountMinor,
            feeTotalMinor: totals.feeTotal.amountMinor,
            discountTotalMinor: totals.discountTotal.amountMinor,
          },
        ),
      );
    }

    if (cart.declaredTotal.currency !== cart.currency) {
      findings.push(
        finding(
          STAGE,
          'CART_CURRENCY_INCONSISTENT',
          'The declared total is in a different currency.',
          {
            declaredCurrency: cart.declaredTotal.currency,
            cartCurrency: cart.currency,
          },
        ),
      );
    }

    if (totals.computedTotal.amountMinor < 0) {
      findings.push(
        finding(
          STAGE,
          'NEGATIVE_EFFECTIVE_TOTAL',
          'Discounts drive the total below zero, which cannot be charged.',
          { recomputedMinor: totals.computedTotal.amountMinor },
        ),
      );
    }

    return completed(findings);
  },
};
