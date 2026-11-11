/**
 * Full-stack demo apps built entirely on Mockingbird emulators, one process,
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
    title: "Lab ordering workspace",
    description:
      "A complete lab ordering app with patient, clinician, and administrator roles. Sign in with an emailed code or with Google or Apple, verify a phone number by SMS or WhatsApp, order tests, track fulfillment, explore biomarker reports, review results, and manage access. Receipts, shipping and result updates go out by email, text and push, and staff alerts go to Slack. Read every message on lifelike phone, mail and chat screens in the Notifications tab, next to the Emulators tab, in one dashboard. The same full stack runs in your browser or on Bun.",
    servicesUsed: ["oauth", "junction", "stripe", "twilio", "resend", "fcm", "slack", "postgres"],
    packagePath: "packages/examples/medical-testing",
    runCommand: "bunx turbo run dev --filter=@crvouga/mockingbird-example-medical-testing",
  },
]
