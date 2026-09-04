/**
 * The catalogue browse surface.
 *
 * The property that matters most here is the last describe block: the browse
 * view and the kernel's live-state read are served from one mutable store, so
 * what the agent saw and what the gate re-reads can genuinely disagree. If those
 * two ever came from separate fixtures, every drift scenario in the suite would
 * be theatre — the test would be comparing two things a test author set by hand
 * rather than a world that changed.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, asTimestamp, money, type MerchantId, type Sku } from '@capturelock/core';
import { FakeMerchantCatalog, type CatalogItemSpec } from '../src/index.js';

const MERCHANT = 'merchant_alpha' as MerchantId;
const OTHER_MERCHANT = 'merchant_omega' as MerchantId;

const CURRY: CatalogItemSpec = {
  sku: 'SKU-THAI-CURRY-KIT',
  name: 'Thai Green Curry Kit',
  category: 'thai-meal-kit',
  attributes: [
    { name: 'diet', value: 'vegetarian' },
    { name: 'cuisine', value: 'thai' },
  ],
  unitPriceMinor: 28_000,
  availableStock: 20,
};

const ENERGY: CatalogItemSpec = {
  sku: 'SKU-ENERGY-500',
  name: 'Voltz Energy Drink 500ml',
  category: 'beverages',
  attributes: [{ name: 'caffeine', value: 'high' }],
  unitPriceMinor: 5_000,
  availableStock: 200,
};

function build(items: readonly CatalogItemSpec[] = [CURRY, ENERGY]): FakeMerchantCatalog {
  const clock = new FixedClock(asTimestamp('2026-09-04T10:00:00.000Z'));
  return new FakeMerchantCatalog({
    merchantId: MERCHANT,
    currency: 'INR',
    items,
    fees: [{ type: 'SHIPPING', label: 'Standard delivery', amount: money('INR', 15_000) }],
    clock: () => clock.now(),
  });
}

describe('search', () => {
  it('returns products whose merchant-stated facts overlap the query', async () => {
    const result = await build().search({ merchantId: MERCHANT, query: 'thai curry', limit: 10 });
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.products.map(p => p.sku)).toEqual(['SKU-THAI-CURRY-KIT']);
  });

  it('returns nothing for a query the merchant does not stock', async () => {
    // An honest empty answer. Returning an arbitrary substitute is how an agent
    // ends up buying something nobody asked for.
    const result = await build().search({ merchantId: MERCHANT, query: 'espresso', limit: 10 });
    expect(result.kind === 'OK' && result.products).toEqual([]);
  });

  it('matches on attribute values, not only names', async () => {
    const result = await build().search({ merchantId: MERCHANT, query: 'vegetarian', limit: 10 });
    expect(result.kind === 'OK' && result.products.map(p => p.sku)).toEqual(['SKU-THAI-CURRY-KIT']);
  });

  it('orders results deterministically for one catalogue and query', async () => {
    const a = await build().search({ merchantId: MERCHANT, query: 'thai vegetarian', limit: 10 });
    const b = await build().search({ merchantId: MERCHANT, query: 'thai vegetarian', limit: 10 });
    expect(a.kind === 'OK' && a.products.map(p => p.sku)).toEqual(
      b.kind === 'OK' && b.products.map(p => p.sku),
    );
  });

  it('honours the limit', async () => {
    const result = await build().search({ merchantId: MERCHANT, query: '', limit: 1 });
    expect(result.kind === 'OK' && result.products).toHaveLength(1);
  });

  it('returns nothing for a merchant it does not serve', async () => {
    const result = await build().search({ merchantId: OTHER_MERCHANT, query: 'thai', limit: 10 });
    expect(result.kind === 'OK' && result.products).toEqual([]);
  });

  it('reports unavailability as a result rather than throwing', async () => {
    // Same discipline as `read`: an unreachable merchant is a decision input,
    // not an exception something upstream might swallow into "no results".
    const catalog = build();
    catalog.apply({ kind: 'GO_OFFLINE', reason: 'connector down' });
    const result = await catalog.search({ merchantId: MERCHANT, query: 'thai', limit: 10 });
    expect(result).toEqual({ kind: 'UNAVAILABLE', reason: 'connector down' });
  });

  it('still lists a withdrawn item, flagged unavailable', async () => {
    const catalog = build();
    catalog.apply({ kind: 'SET_AVAILABLE', sku: CURRY.sku, available: false });
    const result = await catalog.search({ merchantId: MERCHANT, query: 'thai', limit: 10 });
    expect(result.kind === 'OK' && result.products[0]?.available).toBe(false);
  });
});

describe('getProduct', () => {
  it('returns the merchant record for a known SKU', async () => {
    const result = await build().getProduct(MERCHANT, CURRY.sku as Sku);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect({ name: result.product.name, price: result.product.unitPrice }).toEqual({
      name: 'Thai Green Curry Kit',
      price: money('INR', 28_000),
    });
  });

  it('distinguishes "not stocked" from "could not look"', async () => {
    // An agent that cannot tell these apart retries the wrong one: a missing
    // SKU is final, an unreachable merchant is not.
    const catalog = build();
    expect(await catalog.getProduct(MERCHANT, 'SKU-NOPE' as Sku)).toEqual({ kind: 'NOT_FOUND' });

    catalog.apply({ kind: 'GO_OFFLINE', reason: 'timeout' });
    expect(await catalog.getProduct(MERCHANT, CURRY.sku as Sku)).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'timeout',
    });
  });

  it('refuses to serve a SKU under a merchant that does not own it', async () => {
    expect(await build().getProduct(OTHER_MERCHANT, CURRY.sku as Sku)).toEqual({
      kind: 'NOT_FOUND',
    });
  });
});

describe('the catalogue version', () => {
  it('is stable while nothing changes', async () => {
    const catalog = build();
    expect(await catalog.catalogVersion()).toBe(await catalog.catalogVersion());
  });

  it('is equal across two identically constructed catalogues', async () => {
    // Content-addressed, not a counter: a replay of the same fixture produces
    // the same version, which is what lets evidence pin what the agent saw.
    expect(await build().catalogVersion()).toBe(await build().catalogVersion());
  });

  it('changes when a price changes', async () => {
    const catalog = build();
    const before = await catalog.catalogVersion();
    catalog.apply({ kind: 'SET_PRICE', sku: CURRY.sku, unitPriceMinor: 34_000 });
    expect(await catalog.catalogVersion()).not.toBe(before);
  });

  it('changes when stock, availability or fees change', async () => {
    const stock = build();
    const stockBefore = await stock.catalogVersion();
    stock.apply({ kind: 'SET_STOCK', sku: CURRY.sku, availableStock: 3 });

    const fees = build();
    const feesBefore = await fees.catalogVersion();
    fees.apply({
      kind: 'SET_FEES',
      adjustments: [{ type: 'SHIPPING', label: 'Express', amount: money('INR', 30_000) }],
    });

    expect({
      stockChanged: (await stock.catalogVersion()) !== stockBefore,
      feesChanged: (await fees.catalogVersion()) !== feesBefore,
    }).toEqual({ stockChanged: true, feesChanged: true });
  });
});

describe('browse and live state share one world', () => {
  it('shows the agent a price the gate then re-reads differently', async () => {
    // The mechanism behind the whole price-drift narrative, asserted directly
    // rather than assumed by the scenarios that depend on it.
    const catalog = build();

    const browsed = await catalog.getProduct(MERCHANT, CURRY.sku as Sku);
    expect(browsed.kind === 'OK' && browsed.product.unitPrice).toEqual(money('INR', 28_000));

    catalog.apply({ kind: 'SET_PRICE', sku: CURRY.sku, unitPriceMinor: 34_000 });

    const live = await catalog.read({
      merchantId: MERCHANT,
      lines: [{ sku: CURRY.sku as Sku, quantity: 1 }],
      shipTo: null,
    });
    expect(live.kind).toBe('OK');
    if (live.kind !== 'OK') return;
    expect(live.state.items.get(CURRY.sku as Sku)?.unitPrice).toEqual(money('INR', 34_000));
  });

  it('applies a scripted timeline to both surfaces at the same tick', async () => {
    const clock = new FixedClock(asTimestamp('2026-09-04T10:00:00.000Z'));
    const catalog = new FakeMerchantCatalog({
      merchantId: MERCHANT,
      currency: 'INR',
      items: [CURRY],
      fees: [],
      clock: () => clock.now(),
      timeline: new Map([[1, [{ kind: 'SET_PRICE', sku: CURRY.sku, unitPriceMinor: 34_000 }]]]),
    });

    const before = await catalog.getProduct(MERCHANT, CURRY.sku as Sku);
    catalog.advance();
    const after = await catalog.getProduct(MERCHANT, CURRY.sku as Sku);

    expect({
      before: before.kind === 'OK' ? before.product.unitPrice.amountMinor : null,
      after: after.kind === 'OK' ? after.product.unitPrice.amountMinor : null,
    }).toEqual({ before: 28_000, after: 34_000 });
  });
});
