/**
 * Development-only routes.
 *
 * One endpoint, and it exists to close a real gap rather than as a convenience:
 * nothing in the production code path can drive a release to
 * `PAYMENT_AUTHORIZED` except a signed webhook from the provider, which is
 * correct — but it means the end-to-end flow cannot be exercised without a
 * hosted checkout, a public URL, and a human with a test card.
 *
 * The important design choice is that this does **not** bypass anything. It
 * seeds an authorized payment on the fake provider, builds a Razorpay-shaped
 * payload, signs it with the *real* webhook secret, and hands it to the *real*
 * webhook route. The signature is verified, the inbox claims it, and the state
 * machine decides whether the transition is legal — exactly as it would for a
 * genuine delivery. What this proves and does not prove is spelled out in
 * ADR-014.
 *
 * Two independent guards, because one is one thing to accidentally remove:
 * the routes are not registered at all unless the provider is the fake AND the
 * environment is not production, and the handler re-checks.
 */

import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ReleaseIdSchema, asTimestamp, type MerchantId, type UserId } from '@capturelock/core';
import { RAZORPAY_EVENT_ID_HEADER, RAZORPAY_SIGNATURE_HEADER } from '@capturelock/integrations';
import type { Application } from '../composition.js';

const SimulateBody = z.object({ releaseId: ReleaseIdSchema }).strict();

/**
 * Catalogue mutations, for demonstrating drift between the two gates.
 *
 * This moves the *merchant's* world, not CaptureLock's view of it — exactly what
 * a real price change would do. Nothing here touches an authorization, a
 * snapshot, or a release; the whole point is that the transaction becomes
 * invalid because reality moved, and CaptureLock notices on its next live read.
 */
const CatalogBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('SET_PRICE'),
      sku: z.string().min(1),
      unitPriceMinor: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('SET_STOCK'),
      sku: z.string().min(1),
      availableStock: z.number().int().min(0),
    })
    .strict(),
  z
    .object({ kind: z.literal('SET_AVAILABLE'), sku: z.string().min(1), available: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('GO_OFFLINE'), reason: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('COME_ONLINE') }).strict(),
]);

interface SeedableProvider {
  seedAuthorizedPayment(
    orderId: string,
    amount: { currency: string; amountMinor: number },
  ): { paymentId: string };
}

export function isDevSimulationEnabled(app: Application): boolean {
  return app.config.paymentProvider === 'fake' && app.config.nodeEnv !== 'production';
}

/**
 * The hosted-checkout helper is guarded differently, and deliberately so.
 *
 * `simulate-authorization` fabricates a payment, so it is confined to the fake
 * provider. The checkout page is its opposite: it renders a real Razorpay
 * Checkout against a real order, and is the only way to obtain a genuinely
 * authorized payment for live verification. Restricting it to the fake provider
 * would make it useless for the one job it exists to do.
 *
 * It creates nothing and asserts nothing. It emits HTML containing the public
 * key id — which is public by design, it ships to every browser in any Razorpay
 * integration — and an order id. The key SECRET never appears. Still confined
 * to non-production, because a checkout page the server generates for arbitrary
 * releases is not something to leave switched on.
 */
export function isCheckoutHelperEnabled(app: Application): boolean {
  return app.config.nodeEnv !== 'production';
}

/**
 * The delegation the buyer demo runs under.
 *
 * "Thai dinner for two, under 5,000." The two dining candidates are priced so
 * one lands at 4,949 all-in and the other at 6,649, which lets the two
 * protections be shown apart from each other: the tasting menu is outside the
 * delegation regardless of what the merchant does, and the dinner for two is
 * inside it until the restaurant reprices between the gates.
 */
const DEMO_MERCHANT = 'merchant_alpha' as MerchantId;

const DEMO_DELEGATION = {
  purpose: 'Thai dinner for two, under 5,000 rupees',
  bounds: {
    currency: 'INR' as const,
    totalBudget: { currency: 'INR' as const, amountMinor: 500_000 },
    maxPerPurchase: { currency: 'INR' as const, amountMinor: 500_000 },
    merchants: { mode: 'ALLOWLIST' as const, merchantIds: [DEMO_MERCHANT] },
    allowedCategories: ['dining'],
    forbiddenCategories: [],
    itemsPerPurchase: { min: 1, max: 1 },
    recurrence: 'ONE_TIME_ONLY' as const,
  },
};

export function registerDevRoutes(server: FastifyInstance, app: Application): void {
  registerCheckoutHelper(server, app);
  if (!isDevSimulationEnabled(app)) return;

  /**
   * Delegates the demo session, server-side.
   *
   * This route exists for one reason: delegating a budget is **issuer**
   * authority, and shipping an issuer key to a browser so a demo page could
   * call `POST /v1/sessions` itself would hand the agent-facing surface the
   * exact key the architecture exists to keep away from it. A demo that
   * undermined its own thesis to be convenient would be worse than no demo.
   *
   * So the browser never holds an issuer key. It asks this dev-only route,
   * which exercises the same `CommerceSessionService.create` a trusted
   * application would, and gets back a session id and the principal it may act
   * as — which is all an agent is ever entitled to.
   *
   * Guarded exactly like the rest of this module: fake provider, non-production,
   * re-checked in the handler.
   */
  server.post('/v1/dev/demo-session', async (request, reply) => {
    if (!isDevSimulationEnabled(app)) {
      return reply.status(404).send({ error: 'NOT_FOUND' });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const created = await app.commerceSessionService.create({
      userId: 'user_priya' as UserId,
      purpose: DEMO_DELEGATION.purpose,
      bounds: { ...DEMO_DELEGATION.bounds, expiresAt: asTimestamp(expiresAt) },
      policyId: app.config.agentPolicyId,
      policyVersion: app.config.agentPolicyVersion,
    });

    if (created.kind === 'POLICY_NOT_FOUND') {
      return reply.status(422).send({
        error: 'POLICY_NOT_FOUND',
        message: `No operator policy ${app.config.agentPolicyId}@${app.config.agentPolicyVersion} is seeded.`,
      });
    }

    request.log.info(
      { sessionId: created.session.sessionId },
      'demo session delegated through the dev route',
    );

    return reply.status(201).send({
      sessionId: created.session.sessionId,
      // The principal an agent may act as. Not a credential: it names who is
      // acting, and confers nothing an unauthenticated caller could not claim.
      principal: { userId: created.session.userId, sessionId: created.session.sessionId },
      merchantId: DEMO_MERCHANT,
      purpose: created.session.purpose,
      bounds: created.session.bounds,
    });
  });

  /**
   * Simulates the payer authorizing a payment.
   *
   * Returns whatever the webhook route returned, so a caller sees the real
   * disposition — including an out-of-order or duplicate outcome — rather than
   * a synthetic success.
   */
  server.post('/v1/dev/simulate-authorization', async (request, reply) => {
    // Re-checked here, not just at registration.
    if (!isDevSimulationEnabled(app)) {
      return reply.status(404).send({ error: 'NOT_FOUND' });
    }
    if (app.webhookVerifier === null || app.config.razorpayWebhookSecret === undefined) {
      return reply.status(503).send({
        error: 'WEBHOOKS_NOT_CONFIGURED',
        message: 'Simulation delivers a real signed webhook, so a webhook secret is required.',
      });
    }

    const { releaseId } = SimulateBody.parse(request.body);
    const release = await app.deps.releases.findById(releaseId);
    if (release === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    if (release.providerOrderId === null) {
      return reply.status(409).send({
        error: 'NO_PROVIDER_ORDER',
        message: 'This release has no provider order yet; run the order gate first.',
      });
    }

    const payment = (app.rawProvider as unknown as SeedableProvider).seedAuthorizedPayment(
      release.providerOrderId,
      release.amount,
    );

    const payload = {
      entity: 'event',
      event: 'payment.authorized',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: payment.paymentId,
            entity: 'payment',
            amount: release.amount.amountMinor,
            currency: release.amount.currency,
            status: 'authorized',
            order_id: release.providerOrderId,
          },
        },
      },
    };

    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    // Signed with the real secret, over the exact bytes that will be delivered.
    const signature = createHmac('sha256', app.config.razorpayWebhookSecret)
      .update(raw)
      .digest('hex');

    const delivered = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        [RAZORPAY_SIGNATURE_HEADER]: signature,
        [RAZORPAY_EVENT_ID_HEADER]: `evt_sim_${payment.paymentId}`,
      },
      payload: raw,
    });

    request.log.info(
      { releaseId, paymentId: payment.paymentId, webhookStatus: delivered.statusCode },
      'simulated payment authorization delivered through the real webhook route',
    );

    return reply.status(delivered.statusCode).send({
      simulated: true,
      paymentId: payment.paymentId,
      webhook: JSON.parse(delivered.body) as unknown,
    });
  });

  /**
   * Moves the merchant's world.
   *
   * Used to demonstrate that a transaction approved at the order gate is
   * refused at the capture gate when reality changes underneath it. It mutates
   * only the fake catalogue; CaptureLock learns about the change the same way
   * it would learn about a real one, on its next live read.
   */
  server.post('/v1/dev/catalog', async (request, reply) => {
    if (!isDevSimulationEnabled(app)) return reply.status(404).send({ error: 'NOT_FOUND' });
    const mutation = CatalogBody.parse(request.body);
    app.catalog.apply(mutation as never);
    request.log.warn({ mutation }, 'demo catalogue mutated');
    return reply.send({ applied: mutation });
  });
}

/**
 * Serves a Razorpay Checkout page bound to one release's order.
 *
 * Razorpay's server-to-server payment APIs are not enabled on a standard
 * account, so hosted checkout is the only route to an authorized payment. That
 * human step is preserved rather than faked; this merely removes the busywork
 * around it. Served over HTTP because Checkout does not work from a `file://`
 * origin.
 */
function registerCheckoutHelper(server: FastifyInstance, app: Application): void {
  if (!isCheckoutHelperEnabled(app)) return;

  server.get('/v1/dev/checkout/:id', async (request, reply) => {
    const { id } = z.object({ id: ReleaseIdSchema }).strict().parse(request.params);
    const release = await app.deps.releases.findById(id);
    if (release === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    if (release.providerOrderId === null) {
      return reply.status(409).send({
        error: 'NO_PROVIDER_ORDER',
        message: 'Run the order gate first; there is nothing to pay for yet.',
      });
    }

    const rupees = (release.amount.amountMinor / 100).toFixed(2);
    // Only the public key id reaches the browser. The secret is never read here.
    const keyId = app.config.razorpayKeyId ?? '';

    return reply.type('text/html').send(`<!doctype html>
<meta charset="utf-8">
<title>CaptureLock — live capture verification</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; }
  code { background: #f4f4f5; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  button { font: inherit; padding: .75em 1.5em; border: 0; border-radius: 6px;
           background: #0b5fff; color: #fff; cursor: pointer; }
  .warn { background: #fff8e1; border-left: 3px solid #f5a623; padding: .8rem 1rem; margin: 1.5rem 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem 1rem; }
  dt { color: #666; }
</style>
<h1>Live capture verification</h1>
<dl>
  <dt>release</dt><dd><code>${release.releaseId}</code></dd>
  <dt>order</dt><dd><code>${release.providerOrderId}</code></dd>
  <dt>amount</dt><dd>INR ${rupees}</dd>
</dl>
<p>This order was created with <code>payment_capture: 0</code>, so paying it produces an
   <strong>authorized</strong> payment that CaptureLock must then capture through its
   capture gate.</p>
<div class="warn">
  <strong>Razorpay TEST MODE — no real money moves.</strong><br>
  Card <code>4100 2800 0000 1007</code> · any future expiry · any CVV · OTP: any 4–10 digits<br>
  <small>Razorpay's published <strong>domestic</strong> Visa test card. A generic number such as
  4111&nbsp;1111&nbsp;1111&nbsp;1111 is classified <code>international: true</code> and is refused by
  accounts that accept domestic cards only.</small>
</div>
<button id="pay">Pay with Razorpay</button>
<p id="out"></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  document.getElementById('pay').onclick = function () {
    new Razorpay({
      key: ${JSON.stringify(keyId)},
      order_id: ${JSON.stringify(release.providerOrderId)},
      name: 'CaptureLock',
      description: 'Live capture verification (test mode)',
      // Open straight on the card form. The method list is the only screen in
      // Checkout that cannot be driven from the keyboard, which makes the
      // verification run un-automatable for no good reason.
      prefill: { method: 'card' },
      handler: function (r) {
        document.getElementById('out').textContent =
          'Payment ' + r.razorpay_payment_id + ' authorized. Razorpay will now send the webhook.';
      },
    }).open();
  };
</script>
`);
  });
}
