/**
 * Stage 5: does the transaction still match what the user actually authorized?
 *
 * Every attribute and category check in here reads the **live merchant record**,
 * not the agent's assertion about the item. That distinction is the whole
 * defence against a confused or compromised agent: an agent that claims
 * `colour=black` on a shoe the merchant lists as white would otherwise satisfy
 * a "must be black" constraint against its own claim.
 *
 * The agent's assertions are still checked — against live truth — and a
 * contradiction is itself a refusal (`AGENT_MISREPRESENTED_ITEM`). An agent
 * describing an item differently from its merchant is either broken or lying,
 * and neither should be able to move money.
 *
 * Free text never appears here. `intent.rawText` is carried into evidence so a
 * human can read what was asked for, and is deliberately unreachable from any
 * check in this file.
 */

import {
  finding,
  isGreaterThan,
  money,
  multiply,
  normalizeAttributes,
  satisfiesPredicate,
  sum,
  zero,
  type Attribute,
  type CartLine,
  type Finding,
  type IntentConstraints,
  type LiveItemState,
  type Money,
} from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { blocked, completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'INTENT' as const;

export const intentAlignmentStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    if (context.authorization === null) {
      return blocked('authorization');
    }
    if (context.live.kind !== 'OK') {
      // Without live truth, every attribute and category check would have to
      // fall back on the agent's own claims, which is exactly what this stage
      // exists to avoid. Refuse rather than degrade.
      return blocked('live-state');
    }

    const constraints = context.authorization.intent.constraints;
    const live = context.live.state;
    const cart = context.proposal;
    const findings: Finding[] = [];

    if (cart.currency !== constraints.currency) {
      findings.push(
        finding(
          STAGE,
          'INTENT_CURRENCY_MISMATCH',
          'The charge is not in the authorized currency.',
          {
            authorized: constraints.currency,
            actual: cart.currency,
          },
        ),
      );
      // Money in another currency cannot be compared against the authorized
      // ceilings, so the amount checks below are skipped rather than guessed.
      return completed([...findings, ...checkNonMonetary(context, constraints, live)]);
    }

    // ---- amounts -----------------------------------------------------------
    const lineTotals = cart.lines.map(line => multiply(line.unitPrice, line.quantity));
    const itemSubtotal = sum(cart.currency, lineTotals);
    let feeTotal = zero(cart.currency);
    let discountTotal = zero(cart.currency);
    const feeByType = new Map<string, Money>();

    for (const adjustment of cart.adjustments) {
      if (adjustment.type === 'DISCOUNT') {
        discountTotal = money(
          cart.currency,
          discountTotal.amountMinor + adjustment.amount.amountMinor,
        );
      } else {
        feeTotal = money(cart.currency, feeTotal.amountMinor + adjustment.amount.amountMinor);
        const running = feeByType.get(adjustment.type) ?? zero(cart.currency);
        feeByType.set(
          adjustment.type,
          money(cart.currency, running.amountMinor + adjustment.amount.amountMinor),
        );
      }
    }

    const total = money(
      cart.currency,
      itemSubtotal.amountMinor + feeTotal.amountMinor - discountTotal.amountMinor,
    );

    if (isGreaterThan(total, constraints.maxTotal)) {
      findings.push(
        finding(
          STAGE,
          'INTENT_TOTAL_EXCEEDED',
          'The total exceeds the ceiling the user authorized.',
          {
            actualMinor: total.amountMinor,
            authorizedMinor: constraints.maxTotal.amountMinor,
            itemSubtotalMinor: itemSubtotal.amountMinor,
            feeTotalMinor: feeTotal.amountMinor,
          },
        ),
      );
    }

    const feeChecks: ReadonlyArray<readonly [string, Money | null]> = [
      ['SHIPPING', constraints.fees.maxShipping],
      ['TAX', constraints.fees.maxTax],
      ['TIP', constraints.fees.maxTip],
      ['CONVENIENCE_FEE', constraints.fees.maxConvenienceFee],
    ];
    for (const [type, ceiling] of feeChecks) {
      if (ceiling === null) continue;
      const actual = feeByType.get(type) ?? zero(cart.currency);
      if (isGreaterThan(actual, ceiling)) {
        findings.push(
          finding(STAGE, 'INTENT_FEE_EXCEEDED', `${type} exceeds the authorized ceiling.`, {
            adjustmentType: type,
            actualMinor: actual.amountMinor,
            authorizedMinor: ceiling.amountMinor,
          }),
        );
      }
    }

    if (
      constraints.fees.maxTotalFees !== null &&
      isGreaterThan(feeTotal, constraints.fees.maxTotalFees)
    ) {
      findings.push(
        finding(STAGE, 'INTENT_FEE_EXCEEDED', 'Combined fees exceed the authorized ceiling.', {
          adjustmentType: 'ALL_FEES',
          actualMinor: feeTotal.amountMinor,
          authorizedMinor: constraints.fees.maxTotalFees.amountMinor,
        }),
      );
    }

    if (constraints.maxUnitPrice !== null) {
      for (const line of cart.lines) {
        if (isGreaterThan(line.unitPrice, constraints.maxUnitPrice)) {
          findings.push(
            finding(
              STAGE,
              'INTENT_UNIT_PRICE_EXCEEDED',
              'A unit price exceeds the per-item ceiling the user authorized.',
              {
                sku: line.sku,
                actualMinor: line.unitPrice.amountMinor,
                authorizedMinor: constraints.maxUnitPrice.amountMinor,
              },
            ),
          );
        }
      }
    }

    return completed([...findings, ...checkNonMonetary(context, constraints, live)]);
  },
};

function checkNonMonetary(
  context: VerificationContext,
  constraints: IntentConstraints,
  live: { readonly items: ReadonlyMap<string, LiveItemState> },
): Finding[] {
  const cart = context.proposal;
  const findings: Finding[] = [];

  // ---- merchant ------------------------------------------------------------
  if (
    constraints.merchants.mode === 'ALLOWLIST' &&
    !constraints.merchants.merchantIds.includes(cart.merchantId)
  ) {
    findings.push(
      finding(STAGE, 'MERCHANT_NOT_AUTHORIZED', 'The merchant is not one the user authorized.', {
        merchantId: cart.merchantId,
        authorized: [...constraints.merchants.merchantIds].sort().join(','),
      }),
    );
  }

  // ---- recurrence ----------------------------------------------------------
  if (constraints.recurrence === 'ONE_TIME_ONLY' && cart.recurring) {
    findings.push(
      finding(
        STAGE,
        'SUBSCRIPTION_NOT_AUTHORIZED',
        'The transaction establishes a recurring charge but the user authorized a one-time purchase.',
        { source: 'CART' },
      ),
    );
  }

  // ---- geography -----------------------------------------------------------
  if (constraints.geography !== null) {
    if (cart.shipTo === null) {
      findings.push(
        finding(
          STAGE,
          'SHIP_TO_NOT_AUTHORIZED',
          'The authorization constrains shipping geography but the cart names no destination.',
          {},
        ),
      );
    } else {
      if (!constraints.geography.allowedCountries.includes(cart.shipTo.country)) {
        findings.push(
          finding(STAGE, 'SHIP_TO_NOT_AUTHORIZED', 'The destination country is not authorized.', {
            country: cart.shipTo.country,
            authorized: [...constraints.geography.allowedCountries].sort().join(','),
          }),
        );
      }
      const regions = constraints.geography.allowedRegions;
      if (
        regions !== null &&
        (cart.shipTo.region === null || !regions.includes(cart.shipTo.region))
      ) {
        findings.push(
          finding(STAGE, 'SHIP_TO_NOT_AUTHORIZED', 'The destination region is not authorized.', {
            region: cart.shipTo.region ?? '<absent>',
            authorized: [...regions].sort().join(','),
          }),
        );
      }
    }
  }

  // ---- per-line checks against LIVE truth ---------------------------------
  for (const line of cart.lines) {
    if (line.quantity < constraints.quantity.min || line.quantity > constraints.quantity.max) {
      findings.push(
        finding(
          STAGE,
          'INTENT_QUANTITY_OUT_OF_BAND',
          'A line quantity is outside the authorized band.',
          {
            sku: line.sku,
            quantity: line.quantity,
            min: constraints.quantity.min,
            max: constraints.quantity.max,
          },
        ),
      );
    }

    const item = live.items.get(line.sku);
    if (item === undefined) {
      // The freshness stage reports the missing item; nothing to align against here.
      continue;
    }

    if (item.subscriptionOnly && constraints.recurrence === 'ONE_TIME_ONLY') {
      findings.push(
        finding(
          STAGE,
          'SUBSCRIPTION_NOT_AUTHORIZED',
          'The merchant only sells this item on a recurring plan, which the user did not authorize.',
          { sku: line.sku, source: 'LIVE_ITEM' },
        ),
      );
    }

    if (
      constraints.allowedCategories.length > 0 &&
      !constraints.allowedCategories.includes(item.category)
    ) {
      findings.push(
        finding(
          STAGE,
          'INTENT_CATEGORY_MISMATCH',
          'The live item is not in an authorized category.',
          {
            sku: line.sku,
            liveCategory: item.category,
            authorized: [...constraints.allowedCategories].sort().join(','),
          },
        ),
      );
    }

    if (constraints.forbiddenCategories.includes(item.category)) {
      findings.push(
        finding(STAGE, 'INTENT_CATEGORY_MISMATCH', 'The live item is in an excluded category.', {
          sku: line.sku,
          liveCategory: item.category,
          excluded: [...constraints.forbiddenCategories].sort().join(','),
        }),
      );
    }

    for (const predicate of constraints.requiredAttributes) {
      if (!satisfiesPredicate(item.attributes, predicate)) {
        findings.push(
          finding(
            STAGE,
            'INTENT_ATTRIBUTE_MISSING',
            'The live item does not carry a required attribute.',
            {
              sku: line.sku,
              attribute: predicate.name,
              requiredAnyOf: [...predicate.anyOf].sort().join(','),
              liveValue: describe(item.attributes, predicate.name),
            },
          ),
        );
      }
    }

    for (const predicate of constraints.forbiddenAttributes) {
      if (satisfiesPredicate(item.attributes, predicate)) {
        findings.push(
          finding(
            STAGE,
            'INTENT_ATTRIBUTE_FORBIDDEN',
            'The live item carries an attribute the user excluded.',
            {
              sku: line.sku,
              attribute: predicate.name,
              excludedAnyOf: [...predicate.anyOf].sort().join(','),
              liveValue: describe(item.attributes, predicate.name),
            },
          ),
        );
      }
    }

    findings.push(...checkAgentHonesty(line, item));
  }

  return findings;
}

/**
 * Compares what the agent said about an item against what the merchant says.
 *
 * A mismatch does not merely mean the constraint checks used the right source —
 * it means the agent's model of the transaction disagrees with reality, which is
 * a reason to stop regardless of whether the live values happen to pass.
 */
function checkAgentHonesty(line: CartLine, item: LiveItemState): Finding[] {
  const findings: Finding[] = [];

  if (line.asserted.category !== item.category) {
    findings.push(
      finding(
        STAGE,
        'AGENT_MISREPRESENTED_ITEM',
        'The agent asserted a different category from the live merchant record.',
        { sku: line.sku, asserted: line.asserted.category, live: item.category },
      ),
    );
  }

  const assertedAttributes = normalizeAttributes(line.asserted.attributes);
  for (const asserted of assertedAttributes) {
    const liveValues = item.attributes.filter(a => a.name === asserted.name).map(a => a.value);
    if (liveValues.length > 0 && !liveValues.includes(asserted.value)) {
      findings.push(
        finding(
          STAGE,
          'AGENT_MISREPRESENTED_ITEM',
          'The agent asserted an attribute value the live merchant record contradicts.',
          {
            sku: line.sku,
            attribute: asserted.name,
            asserted: asserted.value,
            live: [...liveValues].sort().join(','),
          },
        ),
      );
    }
  }

  return findings;
}

function describe(attributes: readonly Attribute[], name: string): string {
  const values = attributes.filter(a => a.name === name).map(a => a.value);
  return values.length === 0 ? '<absent>' : [...values].sort().join(',');
}
