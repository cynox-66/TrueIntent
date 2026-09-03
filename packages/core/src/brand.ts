/**
 * Nominal ("branded") type helper.
 *
 * TypeScript is structurally typed, so a plain `string` release id is
 * interchangeable with a plain `string` authorization id. In a system where
 * mixing two identifiers means charging against the wrong mandate, that is
 * unacceptable. Branding makes each identifier its own type, so values can only
 * be produced by the module that owns them — which forces validation at the
 * boundary.
 *
 * The phantom property is a string literal rather than a `unique symbol`.
 * A unique symbol is marginally stronger, but it cannot be named by TypeScript's
 * declaration emit across project references, so every schema whose inferred
 * type mentions a brand fails to compile. The literal form is nameable
 * everywhere and still rejects every realistic mistake: a `ReleaseId` will not
 * satisfy an `AuthorizationId` parameter, and a bare `string` satisfies neither.
 * It exists only in the type system; no such property is ever present at runtime.
 */
export type Brand<T, B extends string> = T & { readonly __capturelockBrand: B };
