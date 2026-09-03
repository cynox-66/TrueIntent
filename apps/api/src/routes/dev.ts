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
import { ReleaseIdSchema } from '@capturelock/core';
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

export function registerDevRoutes(server: FastifyInstance, app: Application): void {
  if (!isDevSimulationEnabled(app)) return;

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
