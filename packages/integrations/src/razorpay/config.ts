/**
 * Razorpay configuration, with a hard refusal of live-mode credentials.
 *
 * This is enforced in three places rather than one, because a single check is a
 * single thing to accidentally remove: the schema rejects the key here, the
 * client constructor re-checks it, and the API's configuration loader validates
 * at boot. A prototype that can be pointed at real money by editing one
 * environment variable is not a prototype anyone should run.
 */

import { z } from 'zod';

export const TEST_KEY_PREFIX = 'rzp_test_';
export const LIVE_KEY_PREFIX = 'rzp_live_';

export const RazorpayConfigSchema = z
  .object({
    keyId: z
      .string()
      .min(TEST_KEY_PREFIX.length + 1)
      .refine(value => !value.startsWith(LIVE_KEY_PREFIX), {
        message: 'Refusing a live-mode Razorpay key. TrueIntent is test mode only.',
      })
      .refine(value => value.startsWith(TEST_KEY_PREFIX), {
        message: `Razorpay key id must begin with ${TEST_KEY_PREFIX}`,
      }),
    keySecret: z.string().min(1),
    webhookSecret: z.string().min(1),
    baseUrl: z.string().url().default('https://api.razorpay.com'),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  })
  .strict();

export type RazorpayConfig = z.infer<typeof RazorpayConfigSchema>;

export class LiveModeRefusedError extends Error {
  constructor(prefix: string) {
    super(
      `Refusing to construct a Razorpay client with a "${prefix}" key. TrueIntent is test mode only.`,
    );
    this.name = 'LiveModeRefusedError';
  }
}

export function assertTestMode(keyId: string): void {
  if (keyId.startsWith(LIVE_KEY_PREFIX)) {
    throw new LiveModeRefusedError(LIVE_KEY_PREFIX);
  }
  if (!keyId.startsWith(TEST_KEY_PREFIX)) {
    throw new LiveModeRefusedError(keyId.slice(0, 9));
  }
}
