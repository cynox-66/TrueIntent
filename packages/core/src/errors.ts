/**
 * Structured error taxonomy for CaptureLock.
 *
 * Every error carries a stable machine-readable `code`. Errors are never used to
 * carry secrets, raw credentials, or provider response bodies.
 */

export type CaptureLockErrorCode =
  | 'CANONICALIZATION_ERROR'
  | 'CURRENCY_MISMATCH'
  | 'MONEY_OVERFLOW'
  | 'MONEY_NOT_INTEGER'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_TRANSITION'
  | 'CONCURRENT_MODIFICATION'
  | 'UNIQUE_VIOLATION'
  | 'NOT_FOUND'
  | 'CONFIGURATION_ERROR'
  | 'PROVIDER_ERROR'
  | 'EVIDENCE_CHAIN_ERROR'
  | 'INVARIANT_VIOLATION';

export class CaptureLockError extends Error {
  public readonly code: CaptureLockErrorCode;
  public readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: CaptureLockErrorCode,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = 'CaptureLockError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class CanonicalizationError extends CaptureLockError {
  constructor(message: string, path: string) {
    super('CANONICALIZATION_ERROR', `${message} (at ${path})`, { path });
    this.name = 'CanonicalizationError';
  }
}

export class InvariantViolation extends CaptureLockError {
  constructor(message: string, details: Record<string, string | number | boolean | null> = {}) {
    super('INVARIANT_VIOLATION', message, details);
    this.name = 'InvariantViolation';
  }
}

/**
 * Exhaustiveness helper. Calling this in a `default:` branch turns a missing
 * switch case into a compile-time error, and a runtime failure if the value
 * arrives from outside the type system (e.g. a database row written by an
 * older/newer deployment).
 */
export function assertNever(value: never, context: string): never {
  throw new InvariantViolation(`Unhandled variant in ${context}`, {
    received: typeof value === 'string' ? value : JSON.stringify(value),
  });
}
