/**
 * The operator session.
 *
 * Held in React state and nowhere else. There is no `localStorage`, no
 * `sessionStorage`, no cookie and no URL parameter — a reload signs the
 * operator out, which is the correct trade for a bearer credential sitting in a
 * browser. The key is write-only from the UI's point of view: once submitted it
 * is never rendered again, only the operator's name is.
 *
 * This is explicitly a development credential flow and the UI says so. Real
 * deployment wants an operator login against a session the server holds, so the
 * key never reaches the browser at all; see ADR-017.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { OperatorCredential } from '../api/client.js';

interface OperatorSessionValue {
  /** Null until the credential has been accepted by the API. */
  readonly operator: OperatorCredential | null;
  readonly signIn: (credential: OperatorCredential) => void;
  readonly signOut: () => void;
}

const OperatorSessionContext = createContext<OperatorSessionValue | null>(null);

export function OperatorSessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [operator, setOperator] = useState<OperatorCredential | null>(null);

  const signIn = useCallback((credential: OperatorCredential) => {
    setOperator(credential);
  }, []);

  const signOut = useCallback(() => {
    setOperator(null);
  }, []);

  const value = useMemo<OperatorSessionValue>(
    () => ({ operator, signIn, signOut }),
    [operator, signIn, signOut],
  );

  return (
    <OperatorSessionContext.Provider value={value}>{children}</OperatorSessionContext.Provider>
  );
}

export function useOperatorSession(): OperatorSessionValue {
  const value = useContext(OperatorSessionContext);
  if (value === null) {
    throw new Error('useOperatorSession must be used inside an OperatorSessionProvider');
  }
  return value;
}

/**
 * The credential for a screen that cannot render without one.
 *
 * Throwing rather than returning null keeps the "signed in" check in one place
 * — the router — instead of every view re-deciding what to do without a
 * credential and one of them getting it wrong.
 */
export function useOperator(): OperatorCredential {
  const { operator } = useOperatorSession();
  if (operator === null) throw new Error('This view requires an authenticated operator.');
  return operator;
}
