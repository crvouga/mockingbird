import type { Meta } from "@storybook/html-vite"
import { apiKeys, inOrg, newApiKey, projects, quotaExceeded } from "./fixtures.js"
import { created, ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Organization/API keys" } satisfies Meta

const path = "/orgs/org_acme/keys"
const base = { ...inOrg("owner"), "GET /orgs/org_acme/projects": ok({ data: projects }) }
const { key: _key, ...listedKey } = newApiKey

/** Organization and project keys, some used, some expiring. */
export const Populated = story({
  path,
  routes: { ...base, "GET /orgs/org_acme/api-keys": ok({ data: apiKeys }) },
})

/** An admin manages keys too; the API refuses a key that would outrank its creator. */
export const AsAdmin = story({
  path,
  routes: {
    ...inOrg("admin"),
    "GET /orgs/org_acme/projects": ok({ data: projects }),
    "GET /orgs/org_acme/api-keys": ok({ data: apiKeys }),
  },
})

export const Empty = story({
  path,
  routes: { ...base, "GET /orgs/org_acme/api-keys": ok({ data: [] }) },
})

/** The secret is shown once, right after the key is created. */
export const KeyCreated = story({
  path,
  routes: {
    ...base,
    "GET /orgs/org_acme/api-keys": ok({ data: apiKeys }),
    "POST /orgs/org_acme/api-keys": created(newApiKey, {
      "GET /orgs/org_acme/api-keys": ok({ data: [...apiKeys, listedKey] }),
    }),
  },
  steps: async (page) => {
    page.type("Key name", "deploy")
    await page.press("Create key")
  },
  shows: ["secret:api-key"],
})

export const CreateRefused = story({
  path,
  routes: {
    ...base,
    "GET /orgs/org_acme/api-keys": ok({ data: apiKeys }),
    "POST /orgs/org_acme/api-keys": quotaExceeded(
      "This organization already has 50 API keys",
      "apiKeysPerOrg",
      50,
    ),
  },
  steps: async (page) => {
    page.type("Key name", "one more")
    await page.press("Create key")
  },
  shows: ["flash"],
})
