/**
 * @capturelock/integrations
 *
 * External Integration Contracts and Adapters.
 *
 * CRITICAL RULES:
 * 1. Razorpay integration is TEST MODE ONLY. Live mode is strictly prohibited.
 * 2. Every external integration must have a mock/fake implementation for deterministic tests.
 * 3. Never commit API keys or webhook secrets.
 */

import { z } from 'zod';
import type { CartItemSnapshot } from '@capturelock/core';

/**
 * Razorpay test mode configuration schema.
 */
export const RazorpayConfigSchema = z.object({
  keyId: z
    .string()
    .startsWith('rzp_test_', { message: 'Razorpay Key ID MUST begin with rzp_test_' }),
  keySecret: z.string().min(1),
  webhookSecret: z.string().min(1),
});
export type RazorpayConfig = z.infer<typeof RazorpayConfigSchema>;

export interface CreateOrderParams {
  amountMinor: number;
  currency: string;
  receiptId: string;
  idempotencyKey: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrderResult {
  orderId: string;
  amountMinor: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
  createdAt: number;
}

export interface WebhookVerificationResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payloadHash?: string;
}

/**
 * Adapter interface for Razorpay TEST MODE operations.
 */
export interface IRazorpayTestAdapter {
  createOrder(params: CreateOrderParams): Promise<RazorpayOrderResult>;
  verifyWebhookSignature(rawBody: string, signature: string): WebhookVerificationResult;
}

/**
 * Result of fetching live state from a merchant system.
 */
export interface LiveItemState {
  sku: string;
  currentPriceMinor: number;
  availableStock: number;
  rowHash: string;
  updatedAt: string;
}

/**
 * Adapter interface for verifying live merchant state (TOCTOU guard).
 */
export interface IMerchantLiveStateProvider {
  fetchLiveItemState(skus: string[]): Promise<Map<string, LiveItemState>>;
  verifyFreshness(
    items: CartItemSnapshot[],
    maxAgeSeconds: number,
  ): Promise<{ fresh: boolean; staleItems: string[] }>;
}
