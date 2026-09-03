/**
 * Configuration, validated at boot.
 *
 * The service refuses to start rather than starting misconfigured. In
 * particular a live-mode Razorpay key fails here — the first of three
 * independent refusals, alongside the integrations schema and the client
 * constructor. One check is one thing to accidentally delete.
 */

import { z } from 'zod';
import { LIVE_KEY_PREFIX, TEST_KEY_PREFIX } from '@capturelock/integrations';

const ConfigSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65_535).default(3000),
    host: z.string().default('0.0.0.0'),
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    databaseUrl: z.string().optional(),

    /**
     * Which persistence backend to construct.
     *
     * Postgres is the real one. `memory` exists so the offline test suite can
     * run without Docker; it is never a production configuration, and the
     * refinement below refuses it there.
     */
    persistence: z.enum(['postgres', 'memory']).optional(),

    /**
     * Which payment adapter to construct.
     *
     * `fake` is the default so a fresh checkout cannot accidentally point at a
     * real API. Selecting `razorpay-test` requires credentials, and even then
     * only test-mode ones are accepted.
     */
    paymentProvider: z.enum(['fake', 'razorpay-test']).default('fake'),
    razorpayKeyId: z.string().optional(),
    razorpayKeySecret: z.string().optional(),
    razorpayWebhookSecret: z.string().optional(),

    /**
     * Authority to ISSUE authorizations.
     *
     * Held by the trusted user-facing application, never by an agent. Without
     * this separation an agent could mint its own mandate with its own budget
     * and then spend it, which would make every downstream check pointless.
     */
    issuerApiKey: z.string().min(16).optional(),
    /**
     * Authority to act as an OPERATOR: resolving a paused review, forcing
     * reconciliation.
     *
     * Also never held by an agent. An agent that could resolve its own PAUSE
     * would defeat the entire purpose of pausing.
     */
    operatorApiKey: z.string().min(16).optional(),

    /**
     * Ed25519 private key for signing evidence, base64 PKCS#8.
     *
     * Generated on the fly outside production so a developer can run the
     * service immediately; production refuses to boot without one, because a
     * key that changes on restart makes every prior envelope unverifiable.
     */
    evidenceSigningKey: z.string().optional(),

    snapshotTtlSeconds: z.coerce.number().int().min(1).max(3600).default(30),
    maxAttemptsInWindow: z.coerce.number().int().min(0).max(100).default(3),
    velocityWindowSeconds: z.coerce.number().int().min(1).max(3600).default(60),
    reconcileAfterSeconds: z.coerce.number().int().min(1).max(3600).default(30),
    abandonTransientAfterSeconds: z.coerce.number().int().min(1).max(86_400).default(120),
    grantTtlSeconds: z.coerce.number().int().min(1).max(3600).default(60),
    providerLookupConsistencySeconds: z.coerce.number().int().min(0).max(3600).default(60),
    /** Background sweeper interval. Zero disables the sweepers entirely. */
    sweepIntervalSeconds: z.coerce.number().int().min(0).max(3600).default(30),
  })
  .strict()
  .transform(config => ({
    ...config,
    // Postgres whenever a database is configured; memory only when explicitly
    // asked for or when there is no database at all.
    persistence: config.persistence ?? (config.databaseUrl === undefined ? 'memory' : 'postgres'),
  }))
  .superRefine((config, ctx) => {
    if (config.persistence === 'postgres' && config.databaseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PERSISTENCE=postgres requires DATABASE_URL',
      });
    }
    if (config.nodeEnv === 'production' && config.persistence !== 'postgres') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Refusing to start in production with in-memory persistence: a restart would silently lose every authorization, release and evidence record.',
      });
    }
    if (config.paymentProvider === 'razorpay-test') {
      if (config.razorpayKeyId === undefined || config.razorpayKeySecret === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'razorpay-test provider requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
        });
      }
    }
    if (config.razorpayKeyId !== undefined) {
      if (config.razorpayKeyId.startsWith(LIVE_KEY_PREFIX)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['razorpayKeyId'],
          message:
            'Refusing to start with a live-mode Razorpay key. CaptureLock is test mode only.',
        });
      } else if (!config.razorpayKeyId.startsWith(TEST_KEY_PREFIX)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['razorpayKeyId'],
          message: `Razorpay key id must begin with ${TEST_KEY_PREFIX}`,
        });
      }
    }
    if (config.nodeEnv === 'production' && config.issuerApiKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'ISSUER_API_KEY is required in production: without it, anything that can reach the API could mint its own authorization.',
      });
    }
    if (config.nodeEnv === 'production' && config.operatorApiKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'OPERATOR_API_KEY is required in production: without it, an agent could resolve its own paused release.',
      });
    }
    if (config.nodeEnv === 'production' && config.evidenceSigningKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'EVIDENCE_SIGNING_KEY is required in production: a key that changes on restart makes every earlier envelope unverifiable.',
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * A well-known key outside production, so the demo runs without setup.
 *
 * Returns undefined in production, where the refinements above then refuse to
 * start. A predictable default is only safe because it cannot exist where it
 * would matter.
 */
function devDefault(env: NodeJS.ProcessEnv, value: string): string | undefined {
  return env['NODE_ENV'] === 'production' ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    port: env['PORT'],
    host: env['HOST'],
    nodeEnv: env['NODE_ENV'],
    databaseUrl: env['DATABASE_URL'],
    persistence: env['PERSISTENCE'],
    paymentProvider: env['PAYMENT_PROVIDER'],
    razorpayKeyId: env['RAZORPAY_KEY_ID'],
    razorpayKeySecret: env['RAZORPAY_KEY_SECRET'],
    razorpayWebhookSecret: env['RAZORPAY_WEBHOOK_SECRET'],
    issuerApiKey: env['ISSUER_API_KEY'] ?? devDefault(env, 'dev-issuer-key-not-for-production'),
    operatorApiKey: env['OPERATOR_API_KEY'] ?? devDefault(env, 'dev-operator-key-not-for-prod'),
    evidenceSigningKey: env['EVIDENCE_SIGNING_KEY'],
    snapshotTtlSeconds: env['SNAPSHOT_TTL_SECONDS'],
    maxAttemptsInWindow: env['MAX_ATTEMPTS_IN_WINDOW'],
    velocityWindowSeconds: env['VELOCITY_WINDOW_SECONDS'],
    reconcileAfterSeconds: env['RECONCILE_AFTER_SECONDS'],
    abandonTransientAfterSeconds: env['ABANDON_TRANSIENT_AFTER_SECONDS'],
    grantTtlSeconds: env['GRANT_TTL_SECONDS'],
    providerLookupConsistencySeconds: env['PROVIDER_LOOKUP_CONSISTENCY_SECONDS'],
    sweepIntervalSeconds: env['SWEEP_INTERVAL_SECONDS'],
  });
}
