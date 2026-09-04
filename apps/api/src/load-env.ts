/**
 * Loads the workspace-root `.env`.
 *
 * `import 'dotenv/config'` resolves `.env` relative to the *current working
 * directory*, and `pnpm dev` runs this app with cwd = `apps/api`, where no
 * `.env` exists. The result was silent misconfiguration of exactly the kind
 * that wastes an afternoon: the server came up reporting `paymentProvider:
 * fake` and answered webhooks with `WEBHOOKS_NOT_CONFIGURED`, while a fully
 * populated `.env` sat at the repository root being ignored.
 *
 * Resolving from this module's own location instead makes the behaviour
 * independent of how the process was launched. A local `.env` still wins, so a
 * per-app override remains possible.
 */

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadEnv(): void {
  config({
    path: [
      // Nearest first: dotenv does not overwrite an already-set variable.
      join(here, '..', '.env'),
      join(here, '..', '..', '..', '.env'),
    ],
  });
}
