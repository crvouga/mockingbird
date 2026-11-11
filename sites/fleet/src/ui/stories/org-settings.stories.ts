import type { Meta } from "@storybook/html-vite"
import {
  forbidden,
  globex,
  inOrg,
  invalid,
  managed,
  managedByDeclaration,
  me,
  org,
  type Role,
  suspended,
} from "./fixtures.js"
import { type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organization/Settings" } satisfies Meta

const path = "/orgs/org_acme/settings"
const tab = (role: Role, overrides = {}): MockRoutes => inOrg(role, overrides)

/** An owner can rename the organization and delete it. */
export const AsOwner = query({ path, routes: tab("owner") })
/** An admin can rename it; only an owner can delete it. */
export const AsAdmin = query({ path, routes: tab("admin") })
export const AsMember = query({ path, routes: tab("member") })
export const AsViewer = query({ path, routes: tab("viewer") })

// ---- renaming

const rename = "/orgs/org_acme/rename"

export const Rename = mutation({ path: rename, routes: tab("admin") })

export const RenameToNothing = mutation({
  path: rename,
  routes: tab("admin"),
  steps: (page) => page.submit({ Name: "" }),
  shows: ["field-error"],
})

export const RenameNameTooLong = mutation({
  path: rename,
  routes: {
    ...tab("admin"),
    "PATCH /orgs/org_acme": invalid("body.name: must be at most 80 characters"),
  },
  steps: (page) => page.submit({ Name: "Acme Corporation of America ".repeat(3) }),
  shows: ["field-error"],
})

/** A suspended organization cannot be changed: the API's reason is shown in the form. */
export const RenameWhileSuspended = mutation({
  path: rename,
  routes: {
    ...tab("owner", { suspended: "unpaid invoice" }),
    "PATCH /orgs/org_acme": suspended("unpaid invoice"),
  },
  steps: (page) => page.submit({ Name: "Acme Corp" }),
  shows: ["form-error"],
})

export const RenameSaving = mutation({
  path: rename,
  routes: { ...tab("admin"), "PATCH /orgs/org_acme": PENDING },
  steps: (page) => page.submit({ Name: "Acme Corp" }),
  shows: ["pending"],
})

const renamed = org("admin", { name: "Acme Corp" })

/** Back on the settings, the new name is noted where it is shown. */
export const Renamed = mutation({
  path: rename,
  routes: {
    ...tab("admin"),
    "PATCH /orgs/org_acme": ok(renamed, {
      "GET /me": ok(me([renamed])),
      "GET /orgs/org_acme": ok(renamed),
    }),
  },
  steps: (page) => page.submit({ Name: "Acme Corp" }),
  shows: ["landed"],
})

/** Settings are for admins, so is renaming. */
export const RenameAsMember = query({ path: rename, routes: tab("member") })

// ---- deleting

const remove = "/orgs/org_acme/delete"

export const Delete = mutation({ path: remove, routes: tab("owner") })

/** The slug typed does not match: the browser says so without asking. */
export const DeleteWrongConfirmation = mutation({
  path: remove,
  routes: tab("owner"),
  steps: (page) => page.submit({ "Type acme to confirm": "acme-corp" }),
  shows: ["field-error"],
})

export const DeleteRefused = mutation({
  path: remove,
  routes: { ...tab("owner"), "DELETE /orgs/org_acme": forbidden },
  steps: (page) => page.submit({ "Type acme to confirm": "acme" }),
  shows: ["form-error"],
})

export const Deleting = mutation({
  path: remove,
  routes: { ...tab("owner"), "DELETE /orgs/org_acme": PENDING },
  steps: (page) => page.submit({ "Type acme to confirm": "acme" }),
  shows: ["pending"],
})

/** Gone, the list of organizations says which one was deleted. */
export const Deleted = mutation({
  path: remove,
  routes: {
    ...tab("owner"),
    "DELETE /orgs/org_acme": ok({ ok: true }, { "GET /me": ok(me([globex])) }),
  },
  steps: (page) => page.submit({ "Type acme to confirm": "acme" }),
  shows: ["landed"],
})

/** Only an owner may delete the organization. */
export const DeleteAsAdmin = query({ path: remove, routes: tab("admin") })

// ---- configured by mockingbird.yaml

/** The name is the file's: it is shown without a link to rename it. Deleting stays. */
export const ManagedAsOwner = query({ path, routes: tab("owner", { managed }) })
export const ManagedAsAdmin = query({ path, routes: tab("admin", { managed }) })

/** The address of the form, in an organization the file controls: a statement, not the form. */
export const RenameWhenManaged = query({ path: rename, routes: tab("admin", { managed }) })

/** A file was applied while the form was open: the API's refusal is shown in the form. */
export const RenameBecameManaged = mutation({
  path: rename,
  routes: { ...tab("admin"), "PATCH /orgs/org_acme": managedByDeclaration },
  steps: (page) => page.submit({ Name: "Acme Corp" }),
  shows: ["form-error"],
})

/** Deleting the organization is not the file's to refuse. */
export const DeleteWhenManaged = mutation({ path: remove, routes: tab("owner", { managed }) })
