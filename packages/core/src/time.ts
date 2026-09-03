/**
 * Timestamps as canonical ISO-8601 UTC strings.
 *
 * Every timestamp that enters a hashed structure is a string in exactly the
 * form produced by `Date.prototype.toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * Fixing the representation matters because the same instant has many valid
 * ISO-8601 spellings (offsets, omitted milliseconds, `+00:00` vs `Z`), and two
 * spellings of one instant would produce two different hashes.
 *
 * Time is never read from the ambient clock inside the verification kernel. It
 * is captured once at the edge and injected, which is what makes a decision
 * replayable.
 */

import { z } from 'zod';
import type { Brand } from './brand.js';
import { CaptureLockError } from './errors.js';

export type Timestamp = Brand<string, 'Timestamp'>;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isTimestamp(value: string): value is Timestamp {
  if (!ISO_UTC_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  // Round-tripping rejects values that match the shape but are not real
  // instants, such as 2026-02-30T00:00:00.000Z.
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function asTimestamp(value: string): Timestamp {
  if (!isTimestamp(value)) {
    throw new CaptureLockError(
      'INVALID_IDENTIFIER',
      'Timestamp must be canonical ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ)',
      { value },
    );
  }
  return value;
}

export const TimestampSchema = z
  .string()
  .refine(isTimestamp, 'Must be a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  .transform(value => value as Timestamp);

export function timestampFromDate(date: Date): Timestamp {
  const iso = date.toISOString();
  return iso as Timestamp;
}

export function timestampToEpochMillis(value: Timestamp): number {
  return Date.parse(value);
}

/** Signed difference in milliseconds: `later - earlier`. */
export function millisBetween(earlier: Timestamp, later: Timestamp): number {
  return timestampToEpochMillis(later) - timestampToEpochMillis(earlier);
}

export function addMillis(value: Timestamp, millis: number): Timestamp {
  if (!Number.isInteger(millis)) {
    throw new CaptureLockError('INVALID_IDENTIFIER', 'Millisecond offset must be an integer', {
      millis: Number.isFinite(millis) ? millis : 0,
    });
  }
  return timestampFromDate(new Date(timestampToEpochMillis(value) + millis));
}

export function addSeconds(value: Timestamp, seconds: number): Timestamp {
  return addMillis(value, seconds * 1000);
}

export function isBefore(a: Timestamp, b: Timestamp): boolean {
  return timestampToEpochMillis(a) < timestampToEpochMillis(b);
}

export function isAfter(a: Timestamp, b: Timestamp): boolean {
  return timestampToEpochMillis(a) > timestampToEpochMillis(b);
}

/**
 * Clock port.
 *
 * Injected everywhere rather than calling `Date.now()` directly, so tests are
 * deterministic and so no verification stage can read a moving clock.
 */
export interface Clock {
  now(): Timestamp;
}

export const systemClock: Clock = {
  now: () => timestampFromDate(new Date()),
};

/** Test clock with explicit, manual advancement. */
export class FixedClock implements Clock {
  private current: Timestamp;

  constructor(start: Timestamp) {
    this.current = start;
  }

  now(): Timestamp {
    return this.current;
  }

  advanceBySeconds(seconds: number): void {
    this.current = addSeconds(this.current, seconds);
  }

  advanceByMillis(millis: number): void {
    this.current = addMillis(this.current, millis);
  }

  set(value: Timestamp): void {
    this.current = value;
  }
}
