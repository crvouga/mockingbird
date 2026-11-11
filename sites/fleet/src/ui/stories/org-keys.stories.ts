import type { Meta } from "@storybook/html-vite"
import {
  type ApiKey,
  apiKeys,
  inOrg,
  invalid,
  newApiKey,
  notFound,
  projects,
  quotaExceeded,
  type Role,
} from "./fixtures.js"
import { created, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Organization/API keys" } satisfies Meta

const path = "/orgs/org_acme/keys"
const tab = (role: Role, keys: ApiKey[] = apiKeys): MockRoutes => ({
  ...inOrg(role),
  "GET /orgs/org_acme/projects": ok({ data: projects }),
  "GET /orgs/org_acme/api-keys": ok({ data: keys }),
})
const { key: _key, ...listedKey } = newApiKey

/** Organization and project keys; some used, some never, some expiring. */
export const AsOwner = query({ path, routes: tab("owner") })
export const AsAdmin = query({ path, routes: tab("admin") })
export const Empty = query({ path, routes: tab("owner", []) })

/** Keys are for admins: anyone else is told so, and the API is not asked. */
export const AsMember = query({ path, routes: inOrg("member") })
export const AsViewer = query({ path, routes: inOrg("viewer") })

// ---- creating a key

const create = "/orgs/org_acme/keys/new"

export const NewKey = mutation({ path: create, routes: tab("admin") })

export const NewKeyWithoutAName = mutation({
  path: create,
  routes: tab("admin"),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

/** A project key cannot be an admin: the browser knows before asking. */
export const NewProjectKeyAsAdmin = mutation({
  path: create,
  routes: tab("admin"),
  steps: (page) => page.submit({ Name: "web deploy", Scope: "Project: Web app", Role: "admin" }),
  shows: ["field-error"],
})

export const NewKeyNameTooLong = mutation({
  path: create,
  routes: {
    ...tab("admin"),
    "POST /orgs/org_acme/api-keys": invalid("body.name: must be at most 80 characters"),
  },
  steps: (page) => page.submit({ Name: "deploy key for the staging environment ".repeat(3) }),
  shows: ["field-error"],
})

export const NewKeyOverQuota = mutation({
  path: create,
  routes: {
    ...tab("admin"),
    "POST /orgs/org_acme/api-keys": quotaExceeded(
      "This organization already has 50 API keys",
      "apiKeysPerOrg",
      50,
    ),
  },
  steps: (page) => page.submit({ Name: "one more" }),
  shows: ["form-error"],
})

export const NewKeyCreating = mutation({
  path: create,
  routes: { ...tab("admin"), "POST /orgs/org_acme/api-keys": PENDING },
  steps: (page) => page.submit({ Name: "deploy" }),
  shows: ["pending"],
})

/** The key is shown once, on its own screen, right after it is created. */
export const KeyCreated = mutation({
  path: create,
  routes: {
    ...tab("owner"),
    "POST /orgs/org_acme/api-keys": created(newApiKey, {
      "GET /orgs/org_acme/api-keys": ok({ data: [...apiKeys, listedKey] }),
    }),
  },
  steps: (page) => page.submit({ Name: "deploy" }),
  shows: ["secret"],
})

/** Opened again, the key is gone for good. */
export const KeyShownOnce = query({
  path: "/orgs/org_acme/keys/key_deploy/created",
  routes: tab("owner"),
})

// ---- revoking a key

const revoke = "/orgs/org_acme/keys/key_ci/revoke"

export const RevokeKey = mutation({ path: revoke, routes: tab("admin") })

export const RevokeKeyAlreadyRevoked = mutation({
  path: revoke,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/api-keys/key_ci": notFound("API key") },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const KeyRevoked = mutation({
  path: revoke,
  routes: {
    ...tab("admin"),
    "DELETE /orgs/org_acme/api-keys/key_ci": ok(
      { ok: true },
      { "GET /orgs/org_acme/api-keys": ok({ data: apiKeys.slice(1) }) },
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

export const RevokingKey = mutation({
  path: revoke,
  routes: { ...tab("admin"), "DELETE /orgs/org_acme/api-keys/key_ci": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})
