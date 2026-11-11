import type { Meta } from "@storybook/html-vite"
import {
  type Fleet,
  fleet,
  fleets,
  forbidden,
  inFleet,
  invalid,
  limits,
  managed,
  managedByDeclaration,
  project,
  rateLimited,
  suspended,
  usage,
} from "./fixtures.js"
import { type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Fleet" } satisfies Meta

const path = "/fleets/flt_staging"
const saved = { lastSavedAt: "2026-11-10T11:58:07.000Z", storedBytes: 48_213 }
const typical = fleets[0] as Fleet

/** Anyone with the URL can call it, at the organization's rate ceiling. */
export const AsOwner = query({ path, routes: inFleet(typical) })
export const AsAdmin = query({ path, routes: inFleet(typical, "admin") })
/** A member can change everything on this screen. */
export const AsMember = query({ path, routes: inFleet(typical, "member") })
/** A viewer sees the fleet and its URLs, and no link to change it. */
export const AsViewer = query({ path, routes: inFleet(typical, "viewer") })

export const NoEmulators = query({ path, routes: inFleet(fleet()) })
export const NoEmulatorsAsViewer = query({ path, routes: inFleet(fleet(), "viewer") })

/** The organization cannot be read, so the role is unknown: the links to change it stay. */
export const OrganizationUnavailable = query({
  path,
  routes: { ...inFleet(typical, "member"), "GET /orgs/org_acme": forbidden },
})

/** Every request needs an API key in `x-mockingbird-api-key`. */
export const OnlyWithAKey = query({
  path,
  routes: inFleet(fleet([["stripe", "stripe", "buffered", saved]], { access: "key" })),
})

export const OwnRequestsPerMinute = query({
  path,
  routes: inFleet(fleet([["stripe", "stripe", "buffered", saved]], { requestsPerMinute: 120 })),
})

/** One emulator in each mode. Only `buffered` has something to save on demand. */
export const DurabilityModes = query({
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
export const EmulatorStates = query({
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
export const SecondInstance = query({
  path,
  routes: inFleet(
    fleet([
      ["stripe", "stripe", "strict", saved],
      ["stripe-2", "stripe", "buffered", saved],
    ]),
  ),
})

// ---- renaming

const rename = "/fleets/flt_staging/rename"
const changed = (next: Partial<Fleet>, role = "member" as const): MockRoutes => {
  const after = { ...typical, ...next }
  return { ...inFleet(typical, role), "PATCH /fleets/flt_staging": ok(after, inFleet(after, role)) }
}

export const Rename = mutation({ path: rename, routes: inFleet(typical, "member") })

export const RenameToNothing = mutation({
  path: rename,
  routes: inFleet(typical, "member"),
  steps: (page) => page.submit({ Name: "" }),
  shows: ["field-error"],
})

export const RenameNameTooLong = mutation({
  path: rename,
  routes: {
    ...inFleet(typical, "member"),
    "PATCH /fleets/flt_staging": invalid("body.name: must be at most 80 characters"),
  },
  steps: (page) =>
    page.submit({ Name: "Staging environment for the release candidates ".repeat(2) }),
  shows: ["field-error"],
})

/** Nothing can change in a suspended organization. */
export const RenameWhileSuspended = mutation({
  path: rename,
  routes: {
    ...inFleet(typical, "member"),
    "PATCH /fleets/flt_staging": suspended("unpaid invoice"),
  },
  steps: (page) => page.submit({ Name: "Staging (old)" }),
  shows: ["form-error"],
})

export const RenameSaving = mutation({
  path: rename,
  routes: { ...inFleet(typical, "member"), "PATCH /fleets/flt_staging": PENDING },
  steps: (page) => page.submit({ Name: "Staging (old)" }),
  shows: ["pending"],
})

export const Renamed = mutation({
  path: rename,
  routes: changed({ name: "Staging (old)" }),
  steps: (page) => page.submit({ Name: "Staging (old)" }),
  shows: ["landed"],
})

export const RenameAsViewer = query({ path: rename, routes: inFleet(typical, "viewer") })

// ---- who can call it

const access = "/fleets/flt_staging/access"

export const Access = mutation({ path: access, routes: inFleet(typical, "member") })

/** Choosing what it already is changes nothing: the form says so. */
export const AccessUnchanged = mutation({
  path: access,
  routes: inFleet(typical, "member"),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

export const AccessRefused = mutation({
  path: access,
  routes: { ...inFleet(typical, "member"), "PATCH /fleets/flt_staging": forbidden },
  steps: (page) => page.submit({ "Who can call this fleet": "key" }),
  shows: ["form-error"],
})

export const AccessChanged = mutation({
  path: access,
  routes: changed({ access: "key" }),
  steps: (page) => page.submit({ "Who can call this fleet": "key" }),
  shows: ["landed"],
})

// ---- requests per minute

const rate = "/fleets/flt_staging/rate-limit"
const withCeiling = (routes: MockRoutes, ceiling = limits.fleetRequestsPerMinute): MockRoutes => ({
  ...routes,
  "GET /orgs/org_acme/usage": ok(usage({ limits: { ...limits, fleetRequestsPerMinute: ceiling } })),
})

/** The organization's ceiling is the most the field accepts. */
export const RateLimit = mutation({ path: rate, routes: withCeiling(inFleet(typical, "member")) })

export const RateLimitOwn = mutation({
  path: rate,
  routes: withCeiling(inFleet({ ...typical, requestsPerMinute: 120 }, "member")),
})

/** Over the ceiling: the browser says so without asking. */
export const RateLimitOverTheCeiling = mutation({
  path: rate,
  routes: withCeiling(inFleet(typical, "member")),
  steps: (page) => page.submit({ "Requests per minute": "5000" }),
  shows: ["field-error"],
})

/** With no ceiling the browser cannot tell; the API's refusal is written under the field. */
export const RateLimitRejected = mutation({
  path: rate,
  routes: {
    ...withCeiling(inFleet(typical, "member"), 0),
    "PATCH /fleets/flt_staging": invalid("body.requestsPerMinute: must be <= 1000000"),
  },
  steps: (page) => page.submit({ "Requests per minute": "2000000" }),
  shows: ["field-error"],
})

export const RateLimitChanged = mutation({
  path: rate,
  routes: withCeiling(changed({ requestsPerMinute: 600 })),
  steps: (page) => page.submit({ "Requests per minute": "600" }),
  shows: ["landed"],
})

// ---- deleting

const remove = "/fleets/flt_staging/delete"

/** The consequence names the URL that stops answering and the emulators erased. */
export const Delete = mutation({ path: remove, routes: inFleet(typical, "member") })
export const DeleteWithoutEmulators = mutation({ path: remove, routes: inFleet(fleet(), "member") })

export const DeleteRefused = mutation({
  path: remove,
  routes: { ...inFleet(typical, "member"), "DELETE /fleets/flt_staging": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Deleting = mutation({
  path: remove,
  routes: { ...inFleet(typical, "member"), "DELETE /fleets/flt_staging": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

/** Gone, the project's fleets say which one was deleted. */
export const Deleted = mutation({
  path: remove,
  routes: {
    ...inFleet(typical, "member"),
    "DELETE /fleets/flt_staging": ok(
      { ok: true },
      { [`GET /projects/${project.id}/fleets`]: ok({ data: fleets.slice(1) }) },
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- states every mutation is shown in

export const AccessSaving = mutation({
  path: access,
  routes: { ...inFleet(typical, "member"), "PATCH /fleets/flt_staging": PENDING },
  steps: (page) => page.submit({ "Who can call this fleet": "key" }),
  shows: ["pending"],
})

export const RateLimitSaving = mutation({
  path: rate,
  routes: { ...withCeiling(inFleet(typical, "member")), "PATCH /fleets/flt_staging": PENDING },
  steps: (page) => page.submit({ "Requests per minute": "600" }),
  shows: ["pending"],
})

/** The API throttles the caller: the refusal belongs to no field. */
export const RateLimitThrottled = mutation({
  path: rate,
  routes: { ...withCeiling(inFleet(typical, "member")), "PATCH /fleets/flt_staging": rateLimited },
  steps: (page) => page.submit({ "Requests per minute": "600" }),
  shows: ["form-error"],
})

// ---- configured by mockingbird.yaml

const declared = { managed }

/** The file declares the fleet: its settings and emulators are shown, with only the links that operate them. */
export const ManagedAsOwner = query({ path, routes: inFleet(typical, "owner", declared) })
/** A member can still save, reset and download emulator state. */
export const ManagedAsMember = query({ path, routes: inFleet(typical, "member", declared) })
export const ManagedAsViewer = query({ path, routes: inFleet(typical, "viewer", declared) })
export const ManagedNoEmulators = query({ path, routes: inFleet(fleet(), "owner", declared) })

/** The address of a form the file controls: a statement, not the form. */
export const RenameWhenManaged = query({
  path: rename,
  routes: inFleet(typical, "member", declared),
})
export const AccessWhenManaged = query({
  path: access,
  routes: inFleet(typical, "member", declared),
})
export const RateLimitWhenManaged = query({
  path: rate,
  routes: withCeiling(inFleet(typical, "member", declared)),
})
export const DeleteWhenManaged = query({
  path: remove,
  routes: inFleet(typical, "member", declared),
})

/** A file was applied while the form was open: the API's refusal is shown in the form. */
export const RenameBecameManaged = mutation({
  path: rename,
  routes: { ...inFleet(typical, "member"), "PATCH /fleets/flt_staging": managedByDeclaration },
  steps: (page) => page.submit({ Name: "Staging (old)" }),
  shows: ["form-error"],
})
