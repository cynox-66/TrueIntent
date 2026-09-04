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
