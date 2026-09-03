import { describe, it, expect } from 'vitest';
import {
  RELEASE_STATES,
  isTerminalReleaseState,
  moneyHasMoved,
  requiresReconciliation,
  type ReleaseState,
} from '@capturelock/core';
import {
  InvalidTransitionError,
  TRANSITIONS,
  TRANSITION_TRIGGERS,
  graphInvariants,
  isWriteAheadTrigger,
  nextState,
  requireNextState,
  sourceStatesFor,
} from '../src/release-fsm.js';

describe('graph invariants', () => {
  const invariants = graphInvariants();

  it('has no unreachable states', () => {
    expect(invariants.unreachable).toEqual([]);
  });

  it('has no non-terminal dead ends', () => {
    expect(invariants.deadEnds).toEqual([]);
  });

  it('has no terminal state with an outgoing transition', () => {
    expect(invariants.terminalWithExits).toEqual([]);
  });

  it('declares every trigger in the transition table', () => {
    const declared = new Set(TRANSITIONS.map(t => t.trigger));
    expect([...TRANSITION_TRIGGERS].filter(t => !declared.has(t))).toEqual([]);
  });
});

describe('terminal states', () => {
  it.each(RELEASE_STATES.filter(isTerminalReleaseState))(
    'refuses every trigger from terminal state %s',
    state => {
      for (const trigger of TRANSITION_TRIGGERS) {
        expect(nextState(state, trigger)).toBeNull();
      }
    },
  );

  it('treats CAPTURED as non-terminal so settlement can still be recorded', () => {
    expect(isTerminalReleaseState('CAPTURED')).toBe(false);
    expect(nextState('CAPTURED', 'SETTLEMENT_CONFIRMED')).toBe('SETTLED');
  });

  it('recognises the states in which money has certainly moved', () => {
    expect(moneyHasMoved('CAPTURED')).toBe(true);
    expect(moneyHasMoved('SETTLED')).toBe(true);
    expect(moneyHasMoved('CAPTURE_IN_FLIGHT')).toBe(false);
  });
});

describe('the write-ahead states', () => {
  it('marks the two provider-call entries as write-ahead', () => {
    expect(isWriteAheadTrigger('ORDER_CALL_STARTED')).toBe(true);
    expect(isWriteAheadTrigger('CAPTURE_CALL_STARTED')).toBe(true);
    expect(isWriteAheadTrigger('CAPTURE_SUCCEEDED')).toBe(false);
  });

  it('reaches CAPTURE_IN_FLIGHT only from CAPTURE_APPROVED', () => {
    const entries = TRANSITIONS.filter(t => t.to === 'CAPTURE_IN_FLIGHT');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.from).toEqual(['CAPTURE_APPROVED']);
  });

  it('reaches CAPTURE_APPROVED only through the capture verification gate', () => {
    const entries = TRANSITIONS.filter(t => t.to === 'CAPTURE_APPROVED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.from).toEqual(['CAPTURE_VERIFYING']);
    expect(entries[0]?.trigger).toBe('CAPTURE_ALLOWED');
  });

  it('flags every in-flight and indeterminate state as needing reconciliation', () => {
    for (const state of [
      'ORDER_IN_FLIGHT',
      'ORDER_INDETERMINATE',
      'CAPTURE_IN_FLIGHT',
      'CAPTURE_INDETERMINATE',
    ] as ReleaseState[]) {
      expect(requiresReconciliation(state)).toBe(true);
    }
    expect(requiresReconciliation('ORDER_CREATED')).toBe(false);
  });
});

describe('recovery from indeterminate states', () => {
  it('leaves an indeterminate capture only by adopting provider truth', () => {
    const exits = TRANSITIONS.filter(t => t.from.includes('CAPTURE_INDETERMINATE'));
    expect(exits.map(t => t.trigger).sort()).toEqual([
      'CAPTURE_RECONCILED_CAPTURED',
      'CAPTURE_RECONCILED_NOT_CAPTURED',
    ]);
  });

  it('offers no blind-retry path back into a capture call', () => {
    // A transition from an indeterminate state straight back to IN_FLIGHT would
    // be a second capture attempt with no idea whether the first succeeded.
    expect(nextState('CAPTURE_INDETERMINATE', 'CAPTURE_CALL_STARTED')).toBeNull();
    expect(nextState('CAPTURE_IN_FLIGHT', 'CAPTURE_CALL_STARTED')).toBeNull();
  });

  it('leaves an indeterminate order only by looking it up', () => {
    const exits = TRANSITIONS.filter(t => t.from.includes('ORDER_INDETERMINATE'));
    expect(exits.map(t => t.trigger).sort()).toEqual([
      'ORDER_RECONCILED_ABSENT',
      'ORDER_RECONCILED_FOUND',
    ]);
  });
});

describe('the paused path', () => {
  it('re-verifies rather than executing directly when an operator approves', () => {
    expect(nextState('PAUSED', 'REVIEW_APPROVED')).toBe('CAPTURE_VERIFYING');
  });

  it('does not let an approval jump straight to a capture call', () => {
    expect(nextState('PAUSED', 'CAPTURE_CALL_STARTED')).toBeNull();
    expect(nextState('PAUSED', 'CAPTURE_ALLOWED')).toBeNull();
  });
});

describe('happy-path walk', () => {
  it('runs DRAFT to SETTLED through every declared step', () => {
    let state: ReleaseState = 'DRAFT';
    const walk = [
      'RELEASE_REQUESTED',
      'VERIFICATION_ALLOWED',
      'ORDER_CALL_STARTED',
      'ORDER_CREATED',
      'PAYMENT_AUTHORIZED',
      'CAPTURE_REQUESTED',
      'CAPTURE_ALLOWED',
      'CAPTURE_CALL_STARTED',
      'CAPTURE_SUCCEEDED',
      'SETTLEMENT_CONFIRMED',
    ] as const;
    for (const trigger of walk) {
      state = requireNextState(state, trigger);
    }
    expect(state).toBe('SETTLED');
  });
});

describe('invalid transitions', () => {
  it('throws with a structured error rather than silently doing nothing', () => {
    expect(() => requireNextState('DRAFT', 'CAPTURE_SUCCEEDED')).toThrow(InvalidTransitionError);
    try {
      requireNextState('DRAFT', 'CAPTURE_SUCCEEDED');
    } catch (error) {
      expect((error as InvalidTransitionError).code).toBe('INVALID_TRANSITION');
      expect((error as InvalidTransitionError).details).toMatchObject({ from: 'DRAFT' });
    }
  });

  it('refuses to skip the capture gate', () => {
    expect(nextState('ORDER_CREATED', 'CAPTURE_CALL_STARTED')).toBeNull();
    expect(nextState('PAYMENT_AUTHORIZED', 'CAPTURE_CALL_STARTED')).toBeNull();
    expect(nextState('VERIFIED', 'CAPTURE_SUCCEEDED')).toBeNull();
  });

  it('reports the source states a trigger is legal from, for use in a CAS', () => {
    expect(sourceStatesFor('CAPTURE_CALL_STARTED')).toEqual(['CAPTURE_APPROVED']);
    expect([...sourceStatesFor('VERIFICATION_DENIED')].sort()).toEqual([
      'CAPTURE_VERIFYING',
      'VERIFYING',
    ]);
  });
});
