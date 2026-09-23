/**
 * Full-stack demo apps built entirely on Mockingbird mocks, one process,
 * no real network. Hand-authored (unlike the per-service `mockingbird.examples`
 * snippets, which the catalog integration derives from each service's own
 * package.json at build time) because there is one of these per app, not
 * per service.
 */
export type AppExample = {
  slug: string
  title: string
  description: string
  /** Service catalog `name`s this app composes, linked to `/services/<name>`. */
  servicesUsed: string[]
  /** Repo-relative path to the app's package, for the "source" link. */
  packagePath: string
  runCommand: string
}

export const APP_EXAMPLES: readonly AppExample[] = [
  {
    slug: "medical-testing",
    title: "Cove — Medical Testing",
    description:
      "A branded consumer health app: a patient signs in with a Google or Apple OAuth mock, shops lab tests, pays with a mock Stripe Checkout, and the paid order is fulfilled as a mock Junction lab order — persisted to an in-process PostgreSQL engine, all in one process.",
    servicesUsed: ["oauth", "junction", "stripe", "postgres"],
    packagePath: "packages/examples/medical-testing",
    runCommand: "bunx turbo run dev --filter=@crvouga/mockingbird-example-medical-testing",
  },
]
