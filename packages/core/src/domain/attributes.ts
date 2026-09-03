/**
 * Product attributes as a canonically sorted list of name/value pairs.
 *
 * A `Record<string, string>` would have been the obvious shape, but merchant
 * catalogues supply arbitrary attribute names and our canonical serializer only
 * permits ASCII identifiers as *object keys*. Modelling attributes as data —
 * an array of pairs — sidesteps that entirely, keeps hashing simple, and lets
 * us define the ordering ourselves instead of inheriting JavaScript's.
 */

import { z } from 'zod';

export interface Attribute {
  readonly name: string;
  readonly value: string;
}

export const AttributeSchema = z
  .object({
    name: z.string().min(1).max(64),
    value: z.string().min(1).max(256),
  })
  .strict();

export const AttributeListSchema = z.array(AttributeSchema).max(64);

/**
 * Sorts by name then value so two lists with the same content hash identically.
 * Comparison is on code units, matching the canonical serializer.
 */
export function normalizeAttributes(attributes: readonly Attribute[]): readonly Attribute[] {
  return [...attributes]
    .map(a => ({ name: a.name, value: a.value }))
    .sort((a, b) =>
      a.name === b.name ? compareStrings(a.value, b.value) : compareStrings(a.name, b.name),
    );
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function findAttributeValues(
  attributes: readonly Attribute[],
  name: string,
): readonly string[] {
  return attributes.filter(a => a.name === name).map(a => a.value);
}

export function hasAttribute(
  attributes: readonly Attribute[],
  name: string,
  value: string,
): boolean {
  return attributes.some(a => a.name === name && a.value === value);
}

/**
 * A constraint on an attribute: the item must carry `name` with one of `anyOf`.
 *
 * Deliberately exact-match rather than fuzzy. "Black" and "Jet Black" are
 * different values; resolving that ambiguity belongs upstream in intent
 * normalization, where a human can confirm it, not in the money path.
 */
export interface AttributePredicate {
  readonly name: string;
  readonly anyOf: readonly string[];
}

export const AttributePredicateSchema = z
  .object({
    name: z.string().min(1).max(64),
    anyOf: z.array(z.string().min(1).max(256)).min(1).max(32),
  })
  .strict();

export function satisfiesPredicate(
  attributes: readonly Attribute[],
  predicate: AttributePredicate,
): boolean {
  return attributes.some(a => a.name === predicate.name && predicate.anyOf.includes(a.value));
}
