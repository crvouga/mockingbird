import type { Meta } from "@storybook/html-vite"
import { fleet, fleets, forbidden, inFleet } from "./fixtures.js"
import { failure } from "./mock.js"
import { story } from "./story.js"

export default { title: "Fleet" } satisfies Meta

const path = "/fleets/flt_staging"
const saved = { lastSavedAt: "2026-11-10T11:58:07.000Z", storedBytes: 48_213 }
const typical = fleets[0] as (typeof fleets)[number]

/** A fleet anyone with the URL can call, at the organization's rate ceiling. */
export const AccessOpen = story({ path, routes: inFleet(typical) })

export const Empty = story({ path, routes: inFleet(fleet()) })

export const AsAdmin = story({ path, routes: inFleet(typical, "admin") })

/** A member can do everything on this screen. */
export const AsMember = story({ path, routes: inFleet(typical, "member") })

/** A viewer sees the fleet and its URLs; every control that changes it is absent or disabled. */
export const AsViewer = story({ path, routes: inFleet(typical, "viewer") })

export const EmptyAsViewer = story({ path, routes: inFleet(fleet(), "viewer") })

/** The organization cannot be read, so the role is unknown: the controls stay. */
export const OrganizationUnavailable = story({
  path,
  routes: { ...inFleet(typical, "member"), "GET /orgs/org_acme": forbidden },
})

/** Every request needs an API key in `x-mockingbird-api-key`. */
export const AccessKey = story({
  path,
  routes: inFleet(fleet([["stripe", "stripe", "buffered", saved]], { access: "key" })),
})

export const CustomRequestsPerMinute = story({
  path,
  routes: inFleet(fleet([["stripe", "stripe", "buffered", saved]], { requestsPerMinute: 120 })),
})

/** One emulator in each mode. Only `buffered` has something to save on demand. */
export const DurabilityModes = story({
  path,
  routes: inFleet(
    fleet([
      ["stripe", "stripe", "strict", saved],
      ["resend", "resend", "buffered", saved],
      ["twilio", "twilio", "ephemeral"],
    ]),
  ),
})

/** Every tag an emulator can carry, in the order the names sort. */
export const StatusTags = story({
  path,
  routes: inFleet(
    fleet([
      ["github", "github", "buffered", { loaded: false }],
      ["openai", "openai", "strict"],
      ["resend", "resend", "buffered", { ...saved, dirty: true }],
      [
        "s3",
        "s3",
        "buffered",
        {
          ...saved,
          dirty: true,
          lastError: "State is 17.2 MiB, over the 16 MiB limit. Reset the emulator to continue.",
        },
      ],
      ["slack", "slack", "ephemeral"],
      ["stripe", "stripe", "strict", saved],
    ]),
  ),
})

/** Two Stripe accounts in one fleet: the second instance is named `stripe-2`. */
export const SecondInstance = story({
  path,
  routes: inFleet(
    fleet([
      ["stripe", "stripe", "strict", saved],
      ["stripe-2", "stripe", "buffered", saved],
    ]),
  ),
})

/** Focusing the search lists the catalog. */
export const CatalogOpen = story({
  path,
  routes: inFleet(typical),
  steps: (page) => page.focus("Search emulators"),
  shows: ["catalog:open"],
})

export const CatalogResults = story({
  path,
  routes: inFleet(typical),
  steps: (page) => page.type("Search emulators", "payments"),
  shows: ["catalog:results"],
})

export const CatalogNoMatch = story({
  path,
  routes: inFleet(typical),
  steps: (page) => page.type("Search emulators", "mainframe"),
  shows: ["catalog:no-match"],
})

/** Saving on demand while the object store is failing. */
export const SaveRefused = story({
  path,
  routes: {
    ...inFleet(typical),
    "POST /fleets/flt_staging/emulators/resend/flush": failure(
      503,
      "flush_failed",
      "The object store answered 503 SlowDown",
    ),
  },
  steps: (page) => page.press("Save now"),
  shows: ["flash"],
})
