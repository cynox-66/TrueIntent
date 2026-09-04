/**
 * The shell.
 *
 * The signed-in check lives here and only here, so no view has to decide what
 * to do without a credential. The queue and the release view need operator
 * authority; the evidence views do not, but they are behind the same gate
 * because reaching them means having come through the queue.
 */

import type { ReactNode } from 'react';
import { OperatorSessionProvider, useOperatorSession } from './session/OperatorSession.js';
import { useRoute } from './lib/router.js';
import { useAsync } from './lib/useAsync.js';
import { api } from './api/client.js';
import type { HealthResponse } from './api/types.js';
import { SignIn } from './views/SignIn.js';
import { Queue } from './views/Queue.js';
import { ReleaseDetail } from './views/ReleaseDetail.js';
import { Evidence } from './views/Evidence.js';

export function App(): ReactNode {
  return (
    <OperatorSessionProvider>
      <Shell />
    </OperatorSessionProvider>
  );
}

function Shell(): ReactNode {
  const { operator, signIn, signOut } = useOperatorSession();
  const route = useRoute();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span>CaptureLock</span>
          <span className="brand-sub">Operator Console</span>
        </div>
        <div className="topbar-spacer" />
        <ProviderBadge />
        {operator !== null && (
          <>
            <span className="operator-chip">
              <span className="glyph" aria-hidden="true">
                ●
              </span>
              Acting as <strong>{operator.name}</strong>
            </span>
            <button type="button" className="btn btn-quiet btn-sm" onClick={signOut}>
              Sign out
            </button>
          </>
        )}
      </header>

      <main className="main">
        {operator === null ? (
          <SignIn onSignedIn={signIn} />
        ) : route.name === 'release' ? (
          <ReleaseDetail releaseId={route.releaseId} operator={operator} />
        ) : route.name === 'evidence' ? (
          <Evidence chainId={route.chainId} />
        ) : (
          <Queue operator={operator} />
        )}
      </main>
    </div>
  );
}

/**
 * Which payment adapter is actually wired, stated on every screen.
 *
 * The default adapter is a deterministic fake, and a fake run looks exactly
 * like a real one in every other part of this console — same states, same
 * evidence, same refusals. Someone watching a demonstration cannot be expected
 * to infer which they are seeing, and letting them assume the stronger reading
 * would be the most consequential thing this UI could get wrong. So the answer
 * is on screen, taken from `/health` on the running API rather than from build
 * configuration, and the fake is the one that gets the louder treatment.
 *
 * A failed or pending read says so instead of guessing. "We could not establish
 * which provider is wired" is a true statement; picking a default would not be.
 */
function ProviderBadge(): ReactNode {
  const { state } = useAsync<HealthResponse>(signal => api.health(signal), []);

  if (state.status !== 'ready') {
    return (
      <span className="provider-badge is-unknown" title="Reading /health from the API">
        <span className="glyph" aria-hidden="true">
          ?
        </span>
        provider unknown
      </span>
    );
  }

  const provider = state.data.paymentProvider;
  const isFake = provider === 'fake';
  return (
    <span
      className={`provider-badge ${isFake ? 'is-fake' : 'is-test'}`}
      title={
        isFake
          ? 'The deterministic in-process fake. No request reaches Razorpay; nothing here is a real payment.'
          : `Razorpay TEST MODE (${provider}). Test-mode keys only — a live-mode key is refused at boot.`
      }
    >
      <span className="glyph" aria-hidden="true">
        {isFake ? '◇' : '◆'}
      </span>
      {isFake ? 'SIMULATED PROVIDER' : 'RAZORPAY TEST MODE'}
    </span>
  );
}
