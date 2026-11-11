import type { Meta } from "@storybook/html-vite"
import {
  fleets,
  forbidden,
  inOrg,
  type Managed,
  managed,
  managedByKey,
  manifest,
  me,
  org,
  projects,
  type Role,
  suspended,
} from "./fixtures.js"
import { type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organization/Configuration" } satisfies Meta

const path = "/orgs/org_acme/configuration"
const tab = (role: Role, by: Managed | null, view = manifest(by)): MockRoutes => ({
  ...inOrg(role, { managed: by }),
  "GET /orgs/org_acme/manifest": ok(view),
})

/** A mockingbird.yaml was applied: the file, when and by whom, and how to apply it again. */
export const ManagedAsOwner = query({ path, routes: tab("owner", managed) })
/** An admin can release the organization from the file, as an owner can. */
export const ManagedAsAdmin = query({ path, routes: tab("admin", managed) })
/** Every member can read the file; releasing is for admins. */
export const ManagedAsMember = query({ path, routes: tab("member", managed) })
export const ManagedAsViewer = query({ path, routes: tab("viewer", managed) })
/** Applied from CI with an organization API key. */
export const ManagedByAnApiKey = query({ path, routes: tab("owner", managedByKey) })

/** Configured by hand: the file is generated from what exists, ready to commit and apply. */
export const ByHandAsOwner = query({ path, routes: tab("owner", null) })
export const ByHandAsAdmin = query({ path, routes: tab("admin", null) })
export const ByHandAsMember = query({ path, routes: tab("member", null) })
export const ByHandAsViewer = query({ path, routes: tab("viewer", null) })

/** Nothing exists yet: the file declares no projects, and an example shows what one looks like. */
export const EmptyOrganization = query({ path, routes: tab("owner", null, manifest(null, [])) })
/** Projects without fleets, and a fleet without emulators, are declared empty. */
export const ManagedWithEmptyProjects = query({
  path,
  routes: tab("owner", managed, manifest(managed, projects, fleets.slice(2))),
})

// ---- releasing

const release = "/orgs/org_acme/configuration/release"

export const Release = mutation({ path: release, routes: tab("admin", managed) })

export const ReleaseRefused = mutation({
  path: release,
  routes: { ...tab("admin", managed), "DELETE /orgs/org_acme/manifest": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

/** Nothing can change in a suspended organization. */
export const ReleaseWhileSuspended = mutation({
  path: release,
  routes: {
    ...tab("owner", managed),
    "DELETE /orgs/org_acme/manifest": suspended("unpaid invoice"),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Releasing = mutation({
  path: release,
  routes: { ...tab("admin", managed), "DELETE /orgs/org_acme/manifest": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

const released = org("admin")

/** Back on the Configuration tab, the organization is configured by hand again, and says so. */
export const Released = mutation({
  path: release,
  routes: {
    ...tab("admin", managed),
    "DELETE /orgs/org_acme/manifest": ok(released, {
      "GET /me": ok(me([released])),
      "GET /orgs/org_acme": ok(released),
      "GET /orgs/org_acme/manifest": ok(manifest(null)),
    }),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

/** Releasing is for admins. */
export const ReleaseAsMember = query({ path: release, routes: tab("member", managed) })

/** Nothing to release: the address opens the Configuration tab, which says so. */
export const ReleaseWhenByHand = query({ path: release, routes: tab("admin", null) })
