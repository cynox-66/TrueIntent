/**
 * @capturelock/integrations
 *
 * External boundaries and their test doubles. The kernel depends on the ports
 * declared in `@capturelock/core`, never on anything in this package, so a
 * provider can be swapped without touching a verification stage.
 */

export {
  LiveModeRefusedError,
  LIVE_KEY_PREFIX,
  RazorpayConfigSchema,
  TEST_KEY_PREFIX,
  assertTestMode,
  type RazorpayConfig,
} from './razorpay/config.js';

export { RazorpayTestClient } from './razorpay/client.js';

export {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  RazorpayWebhookVerifier,
} from './razorpay/webhook.js';

export { FakePaymentProvider, type FakeProviderOptions, type FaultKind } from './razorpay/fake.js';

export {
  FakeMerchantCatalog,
  type CatalogItemSpec,
  type CatalogMutation,
  type FakeCatalogOptions,
} from './merchant/fake-catalog.js';
