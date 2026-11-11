import type { Meta } from "@storybook/html-vite"
import {
  catalog,
  conflict,
  fleet,
  fleets,
  forbidden,
  inProject,
  invalid,
  managed,
  managedByDeclaration,
  project,
  projects,
  quotaExceeded,
  suspended,
} from "./fixtures.js"
import { created, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Project" } satisfies Meta

const path = "/projects/prj_web"

/** An owner or admin can also delete the project. */
export const AsOwner = query({ path, routes: inProject("owner") })
export const AsAdmin = query({ path, routes: inProject("admin") })
/** A member can create and rename, not delete. */
export const AsMember = query({ path, routes: inProject("member") })
/** A viewer sees the fleets and their URLs, and nothing that changes them. */
export const AsViewer = query({ path, routes: inProject("viewer") })

export const NoFleets = query({ path, routes: inProject("owner", []) })
export const NoFleetsAsViewer = query({ path, routes: inProject("viewer", []) })

/** The organization cannot be read, so the role is unknown: what a member may do is offered. */
export const OrganizationUnavailable = query({
  path,
  routes: { ...inProject("member"), "GET /orgs/org_acme": forbidden },
})

// ---- renaming

const rename = "/projects/prj_web/rename"

export const Rename = mutation({ path: rename, routes: inProject("member") })

export const RenameToNothing = mutation({
  path: rename,
  routes: inProject("member"),
  steps: (page) => page.submit({ Name: "" }),
  shows: ["field-error"],
})

export const RenameNameTooLong = mutation({
  path: rename,
  routes: {
    ...inProject("member"),
    "PATCH /projects/prj_web": invalid("body.name: must be at most 80 characters"),
  },
  steps: (page) => page.submit({ Name: "The web application and its marketing site ".repeat(2) }),
  shows: ["field-error"],
})

export const RenameSaving = mutation({
  path: rename,
  routes: { ...inProject("member"), "PATCH /projects/prj_web": PENDING },
  steps: (page) => page.submit({ Name: "Website" }),
  shows: ["pending"],
})

const website = { ...project, name: "Website" }

export const Renamed = mutation({
  path: rename,
  routes: {
    ...inProject("member"),
    "PATCH /projects/prj_web": ok(website, { "GET /projects/prj_web": ok(website) }),
  },
  steps: (page) => page.submit({ Name: "Website" }),
  shows: ["landed"],
})

export const RenameAsViewer = query({ path: rename, routes: inProject("viewer") })

// ---- deleting

const remove = "/projects/prj_web/delete"

/** The consequence names every fleet that goes with it. */
export const Delete = mutation({ path: remove, routes: inProject("admin") })
export const DeleteWithoutFleets = mutation({ path: remove, routes: inProject("admin", []) })

export const DeleteRefused = mutation({
  path: remove,
  routes: { ...inProject("admin"), "DELETE /projects/prj_web": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

/** Gone, the organization's projects say which one was deleted. */
export const Deleted = mutation({
  path: remove,
  routes: {
    ...inProject("admin"),
    "DELETE /projects/prj_web": ok(
      { ok: true },
      { "GET /orgs/org_acme/projects": ok({ data: projects.slice(1) }) },
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

/** Deleting a project is for admins. */
export const DeleteAsMember = query({ path: remove, routes: inProject("member") })

// ---- creating a fleet

const create = "/projects/prj_web/fleets/new"

export const NewFleet = mutation({ path: create, routes: inProject("member") })

export const NewFleetWithoutAName = mutation({
  path: create,
  routes: inProject("member"),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

/** The browser checks the slug's shape before asking. */
export const NewFleetBadSlug = mutation({
  path: create,
  routes: inProject("member"),
  steps: (page) => page.submit({ Name: "QA", "URL slug (optional)": "-QA env-" }),
  shows: ["field-error"],
})

/** Slugs are unique across the server: the API's 409 is written under the slug. */
export const NewFleetSlugTaken = mutation({
  path: create,
  routes: {
    ...inProject("member"),
    "POST /projects/prj_web/fleets": conflict('Fleet slug "acme-staging" is already taken'),
  },
  steps: (page) => page.submit({ Name: "Staging 2", "URL slug (optional)": "acme-staging" }),
  shows: ["field-error"],
})

/** The API names both fields it refuses. */
export const NewFleetInvalid = mutation({
  path: create,
  routes: {
    ...inProject("member"),
    "POST /projects/prj_web/fleets": invalid(
      "body.name: must be at most 80 characters",
      "body.slug: Lowercase letters, digits and hyphens; 1 to 40 characters.",
    ),
  },
  steps: (page) => page.submit({ Name: "Staging ".repeat(11), "URL slug (optional)": "staging" }),
  shows: ["field-error"],
})

export const NewFleetOverQuota = mutation({
  path: create,
  routes: {
    ...inProject("member"),
    "POST /projects/prj_web/fleets": quotaExceeded(
      "This organization already has 50 fleets",
      "fleetsPerOrg",
      50,
    ),
  },
  steps: (page) => page.submit({ Name: "QA" }),
  shows: ["form-error"],
})

export const NewFleetCreating = mutation({
  path: create,
  routes: { ...inProject("member"), "POST /projects/prj_web/fleets": PENDING },
  steps: (page) => page.submit({ Name: "QA" }),
  shows: ["pending"],
})

const qa = fleet([], { id: "flt_qa", slug: "acme-qa", name: "QA" })

/** Created, the dashboard opens the new fleet and says so. */
export const NewFleetCreated = mutation({
  path: create,
  routes: {
    ...inProject("member"),
    "POST /projects/prj_web/fleets": created(qa, {
      "GET /fleets/flt_qa": ok(qa),
      "GET /catalog": ok(catalog),
      "GET /projects/prj_web/fleets": ok({ data: [...fleets, qa] }),
    }),
  },
  steps: (page) => page.submit({ Name: "QA", "URL slug (optional)": "acme-qa" }),
  shows: ["landed"],
})

export const NewFleetAsViewer = query({ path: create, routes: inProject("viewer") })

// ---- states every mutation is shown in

/** A suspended organization cannot be changed: the API's reason is shown in the form. */
export const RenameWhileSuspended = mutation({
  path: rename,
  routes: { ...inProject("member"), "PATCH /projects/prj_web": suspended("unpaid invoice") },
  steps: (page) => page.submit({ Name: "Website" }),
  shows: ["form-error"],
})

export const Deleting = mutation({
  path: remove,
  routes: { ...inProject("admin"), "DELETE /projects/prj_web": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

// ---- configured by mockingbird.yaml

const declared = { managed }

/** The file declares the project and its fleets: no link creates, renames or deletes. */
export const ManagedAsOwner = query({ path, routes: inProject("owner", fleets, declared) })
export const ManagedAsMember = query({ path, routes: inProject("member", fleets, declared) })
export const ManagedAsViewer = query({ path, routes: inProject("viewer", fleets, declared) })
export const ManagedNoFleets = query({ path, routes: inProject("owner", [], declared) })

/** The address of a form the file controls: a statement, not the form. */
export const RenameWhenManaged = query({
  path: rename,
  routes: inProject("member", fleets, declared),
})
export const DeleteWhenManaged = query({
  path: remove,
  routes: inProject("admin", fleets, declared),
})
export const NewFleetWhenManaged = query({
  path: create,
  routes: inProject("member", fleets, declared),
})

/** A file was applied while the form was open: the refusal belongs to no field, not to the slug. */
export const NewFleetBecameManaged = mutation({
  path: create,
  routes: { ...inProject("member"), "POST /projects/prj_web/fleets": managedByDeclaration },
  steps: (page) => page.submit({ Name: "QA", "URL slug (optional)": "acme-qa" }),
  shows: ["form-error"],
})
