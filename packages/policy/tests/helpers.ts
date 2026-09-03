import {
  asTimestamp,
  computeCartTotals,
  money,
  type AdjustmentType,
  type Attribute,
  type CartAdjustment,
  type CurrencyCode,
  type MerchantId,
  type Money,
  type ProposedCart,
  type Sku,
} from '@capturelock/core';
import type { PolicySubject, PolicySubjectLine } from '../src/subject.js';
import type { PolicyDocument } from '../src/document.js';

export const sku = (value: string): Sku => value as Sku;
export const merchant = (value: string): MerchantId => value as MerchantId;
export const inr = (minor: number): Money => money('INR', minor);
export const attr = (name: string, value: string): Attribute => ({ name, value });

export function adjustment(
  type: AdjustmentType,
  amountMinor: number,
  label: string = type,
): CartAdjustment {
  return { type, label, amount: inr(amountMinor) };
}

interface LineSpec {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  category?: string;
  attributes?: Attribute[];
}

export function buildSubject(spec: {
  lines: LineSpec[];
  adjustments?: CartAdjustment[];
  merchantId?: string;
  currency?: CurrencyCode;
  recurring?: boolean;
  snapshotAgeSeconds?: number;
}): PolicySubject {
  const currency = spec.currency ?? 'INR';
  const cart: ProposedCart = {
    merchantId: merchant(spec.merchantId ?? 'merchant_alpha'),
    currency,
    lines: spec.lines.map(line => ({
      sku: sku(line.sku),
      quantity: line.quantity,
      unitPrice: money(currency, line.unitPriceMinor),
      asserted: {
        name: line.sku,
        category: line.category ?? 'footwear',
        attributes: line.attributes ?? [],
      },
    })),
    adjustments: spec.adjustments ?? [],
    declaredTotal: money(currency, 0),
    recurring: spec.recurring ?? false,
    shipTo: null,
  };

  const totals = computeCartTotals(cart);

  const lines: PolicySubjectLine[] = spec.lines.map(line => ({
    sku: sku(line.sku),
    quantity: line.quantity,
    unitPrice: money(currency, line.unitPriceMinor),
    lineTotal: money(currency, line.unitPriceMinor * line.quantity),
    category: line.category ?? 'footwear',
    attributes: line.attributes ?? [],
  }));

  return {
    merchantId: merchant(spec.merchantId ?? 'merchant_alpha'),
    currency,
    lines,
    totals,
    feeByType: totals.byAdjustmentType,
    recurring: spec.recurring ?? false,
    snapshotAgeSeconds: spec.snapshotAgeSeconds ?? 5,
  };
}

export function policy(rules: unknown[]): PolicyDocument {
  return {
    policyId: 'test_policy',
    version: '1.0.0',
    name: 'Test policy',
    rules,
    createdAt: asTimestamp('2026-09-03T10:00:00.000Z'),
  };
}
