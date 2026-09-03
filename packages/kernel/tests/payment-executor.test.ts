/**
 * The guarded executor: the boundary money must cross.
 *
 * Phase 1 relied on the grant being passed *alongside* the provider call. These
 * tests cover what changed: the grant is now a precondition of the call, it is
 * single-use, it expires, and the amount that reaches the provider is read off
 * the grant rather than off the caller's request.
 */

import { describe, it, expect } from 'vitest';
import { FixedClock, asTimestamp, money } from '@capturelock/core';
import { FakePaymentProvider } from '@capturelock/integrations';
import {
  GrantRejectedError,
  GuardedPaymentExecutor,
  paymentReaderOf,
} from '../src/payment-executor.js';
import { mintGrant, type ExecutionGrant } from '../src/grant.js';
import { evaluate } from '../src/kernel.js';
import { buildContext, NOW } from './fixtures.js';

const AT = NOW;

function allowDecision() {
  const decision = evaluate(buildContext());
  expect(decision.verdict).toBe('ALLOW');
  return decision;
}

function grantFor(options: { nonce?: string; expiresAt?: string } = {}): ExecutionGrant {
  const grant = mintGrant(
    allowDecision(),
    'a'.repeat(64) as never,
    {
      releaseId: ('rel_' + 'a'.repeat(32)) as never,
      authorizationId: ('auth_' + 'a'.repeat(32)) as never,
      snapshotId: ('snap_' + 'a'.repeat(32)) as never,
      snapshotHash: 'b'.repeat(64) as never,
      receipt: 'cl_test_receipt' as never,
      amount: money('INR', 494_900),
    },
    {
      nonce: options.nonce ?? `nonce-${Math.floor(Math.random() * 1e9)}`,
      expiresAt: (options.expiresAt ?? asTimestamp('2026-09-03T10:01:00.000Z')) as never,
    },
  );
  if (grant === null) throw new Error('expected a grant');
  return grant;
}

function build(): {
  executor: GuardedPaymentExecutor;
  provider: FakePaymentProvider;
  clock: FixedClock;
} {
  const clock = new FixedClock(AT);
  const provider = new FakePaymentProvider({ clock: () => clock.now() });
  return { executor: new GuardedPaymentExecutor(provider, clock), provider, clock };
}

describe('a grant is required to reach the provider', () => {
  it('performs the call when the grant is valid', async () => {
    const { executor, provider } = build();
    const outcome = await executor.createOrder(grantFor(), {
      receipt: 'cl_test_receipt' as never,
      amount: money('INR', 494_900),
      notes: {},
    });
    expect(outcome.kind).toBe('CREATED');
    expect(provider.orderCount()).toBe(1);
  });

  it('mints no grant at all for a refusal, so the call cannot be expressed', () => {
    const denied = evaluate(buildContext({ omitAuthorization: true }));
    expect(denied.verdict).toBe('DENY');
    expect(
      mintGrant(
        denied,
        'a'.repeat(64) as never,
        {
          releaseId: ('rel_' + 'a'.repeat(32)) as never,
          authorizationId: ('auth_' + 'a'.repeat(32)) as never,
          snapshotId: ('snap_' + 'a'.repeat(32)) as never,
          snapshotHash: 'b'.repeat(64) as never,
          receipt: 'cl_test_receipt' as never,
          amount: money('INR', 1),
        },
        { nonce: 'n', expiresAt: AT },
      ),
    ).toBeNull();
  });
});

describe('a grant is single use', () => {
  it('refuses a second use of the same grant', async () => {
    const { executor, provider } = build();
    const grant = grantFor({ nonce: 'reused-nonce' });
    const request = {
      receipt: 'cl_test_receipt' as never,
      amount: money('INR', 494_900),
      notes: {},
    };

    await executor.createOrder(grant, request);
    await expect(executor.createOrder(grant, request)).rejects.toThrow(GrantRejectedError);
    // The refusal happens before the provider is touched.
    expect(provider.orderCount()).toBe(1);
    expect(provider.callCount('createOrder')).toBe(1);
  });

  it('refuses a reused grant on capture too, before any money moves', async () => {
    const { executor, provider } = build();
    const payment = provider.seedAuthorizedPayment('order_1', money('INR', 494_900));
    const grant = grantFor({ nonce: 'capture-nonce' });

    await executor.capturePayment(grant, {
      paymentId: payment.paymentId,
      amount: money('INR', 494_900),
    });
    await expect(
      executor.capturePayment(grant, {
        paymentId: payment.paymentId,
        amount: money('INR', 494_900),
      }),
    ).rejects.toThrow(/ALREADY_CONSUMED/);
    expect(provider.capturedCount()).toBe(1);
    expect(provider.callCount('capturePayment')).toBe(1);
  });

  it('counts each grant it burns', async () => {
    const { executor } = build();
    await executor.createOrder(grantFor(), {
      receipt: 'cl_a' as never,
      amount: money('INR', 1),
      notes: {},
    });
    await executor.createOrder(grantFor(), {
      receipt: 'cl_b' as never,
      amount: money('INR', 1),
      notes: {},
    });
    expect(executor.consumedCount()).toBe(2);
  });
});

describe('a grant expires', () => {
  it('refuses a grant past its expiry, against the injected clock', async () => {
    const { executor, provider, clock } = build();
    const grant = grantFor({ expiresAt: '2026-09-03T10:00:30.000Z' });

    clock.advanceBySeconds(120);
    await expect(
      executor.createOrder(grant, {
        receipt: 'cl_test_receipt' as never,
        amount: money('INR', 1),
        notes: {},
      }),
    ).rejects.toThrow(/EXPIRED/);
    expect(provider.calls).toHaveLength(0);
  });

  it('accepts a grant still inside its window', async () => {
    const { executor, clock } = build();
    const grant = grantFor({ expiresAt: '2026-09-03T10:00:30.000Z' });
    clock.advanceBySeconds(10);
    await expect(
      executor.createOrder(grant, {
        receipt: 'cl_test_receipt' as never,
        amount: money('INR', 1),
        notes: {},
      }),
    ).resolves.toBeDefined();
  });
});

describe('the amount comes from the grant, not the caller', () => {
  it('ignores a caller-supplied amount on createOrder', async () => {
    const { executor, provider } = build();
    // A caller holding a valid grant tries to charge ten times as much.
    await executor.createOrder(grantFor(), {
      receipt: 'cl_attacker_receipt' as never,
      amount: money('INR', 4_949_000),
      notes: {},
    });
    const order = await provider.findOrderByReceipt('cl_test_receipt' as never);
    expect(order?.amount.amountMinor).toBe(494_900);
    // The receipt is the grant's too, so the attacker's receipt never existed.
    expect(await provider.findOrderByReceipt('cl_attacker_receipt' as never)).toBeNull();
  });

  it('ignores a caller-supplied amount on capture', async () => {
    const { executor, provider } = build();
    const payment = provider.seedAuthorizedPayment('order_1', money('INR', 494_900));
    const outcome = await executor.capturePayment(grantFor(), {
      paymentId: payment.paymentId,
      amount: money('INR', 4_949_000),
    });
    // The provider only accepts a capture equal to the authorized amount, so a
    // substituted figure would have been rejected. It was not substituted.
    expect(outcome.kind).toBe('CAPTURED');
    expect(provider.capturedCount()).toBe(1);
  });
});

describe('the read-only view', () => {
  it('exposes lookups and nothing that can move money', () => {
    const provider = new FakePaymentProvider({ clock: () => AT });
    const reader = paymentReaderOf(provider);
    expect(Object.keys(reader).sort()).toEqual(['findOrderByReceipt', 'getPayment', 'name']);
    // No capture, no createOrder — not merely discouraged, absent.
    expect('capturePayment' in reader).toBe(false);
    expect('createOrder' in reader).toBe(false);
  });
});
