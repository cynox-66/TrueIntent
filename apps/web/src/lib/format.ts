/**
 * Display formatting.
 *
 * Presentation only. Nothing here re-derives a value the API already computed —
 * an amount is rendered from the minor units the server sent, never recomputed
 * from parts, because a console that disagrees with the ledger about a number
 * is worse than one that shows the raw integer.
 */

import type { Money, Timestamp } from '../api/types.js';

/**
 * Renders money from minor units.
 *
 * Falls back to `<currency> <minor units>` for a currency `Intl` does not know,
 * rather than guessing an exponent. Getting the decimal place wrong on a
 * payment screen is a worse failure than an ugly one.
 */
export function formatMoney(amount: Money): string {
  try {
    const formatter = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: amount.currency,
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount.amountMinor / 10 ** digits);
  } catch {
    return `${amount.currency} ${String(amount.amountMinor)}`;
  }
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
];

/**
 * "2m ago", for how long something has been waiting.
 *
 * Always paired with the absolute timestamp in a `title`, because "2m ago" is
 * the wrong thing to read out during an incident.
 */
export function formatRelative(timestamp: Timestamp, now: number = Date.now()): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return String(timestamp);

  const deltaMs = then - now;
  const magnitude = Math.abs(deltaMs);
  if (magnitude < 45_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let chosen: readonly [Intl.RelativeTimeFormatUnit, number] = UNITS[0]!;
  for (const unit of UNITS) {
    if (magnitude >= unit[1]) chosen = unit;
  }
  return formatter.format(Math.round(deltaMs / chosen[1]), chosen[0]);
}

export function formatAbsolute(timestamp: Timestamp | null): string {
  if (timestamp === null) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

/**
 * Shortens a hash for display, keeping both ends.
 *
 * Both ends matter: an operator comparing two hashes by eye is checking that
 * they differ, and truncating only the tail hides a difference that is often at
 * the end. The full value is always available in the raw view.
 */
export function truncateHash(hash: string, keep = 8): string {
  if (hash.length <= keep * 2 + 1) return hash;
  return `${hash.slice(0, keep)}…${hash.slice(-keep)}`;
}

/** Turns SCREAMING_SNAKE_CASE into Title Case for headings. */
export function humanizeState(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
