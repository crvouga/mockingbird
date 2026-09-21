/**
 * Set by `scripts/bundle-service.ts` when a service is bundled, and rewritten to the
 * released version when it is published. Undefined when running from source.
 */
declare const __MOCKINGBIRD_PACKAGE_VERSION__: string | undefined

/** Placeholder a bundle carries until `release:publish` writes the real version over it. */
export const UNRELEASED_VERSION = "0.0.0-development"

/** The published version of the service package this code is bundled into. */
export const PACKAGE_VERSION: string =
  typeof __MOCKINGBIRD_PACKAGE_VERSION__ === "string"
    ? __MOCKINGBIRD_PACKAGE_VERSION__
    : UNRELEASED_VERSION
