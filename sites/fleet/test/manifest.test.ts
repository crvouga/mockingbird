import { afterEach, expect, test } from "bun:test"
import { loadConfig } from "../src/config.js"
import { harness, ORIGIN } from "./harness.js"

const open: { close(): Promise<void> }[] = []
const start = (...args: Parameters<typeof harness>) => {
  const created = harness(...args)
  open.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()))
})

type Change = { action: string; kind: string; name: string; detail?: string }
type Result = { organization: string | null; applied: boolean; changes: Change[] }
type ErrorBody = { error: { code: string; message: string; details?: unknown } }

const file = `
version: 1
organization: acme
name: Acme
projects:
  web:
    name: Web app
    fleets:
      acme-staging:
        name: Staging
        access: open
        services:
          resend: { durability: strict }
          mail: { target: resend }
          db: { target: postgres, protocol: postgres, port: 5432, local: true }
`
const brief = (changes: Change[]) =>
  changes.filter((c) => c.action !== "unchanged").map((c) => `${c.action} ${c.kind} ${c.name}`)

/** Apply YAML exactly as `curl --data-binary @mockingbird.yaml` would send it. */
const apply = (
  client: {
    raw: ReturnType<typeof harness>["client"] extends (...a: never[]) => infer C
      ? C extends { raw: infer R }
        ? R
        : never
      : never
  },
  yaml: string,
  query = "",
) =>
  client
    .raw("PUT", `/api/v1/manifest${query}`, {
      body: yaml,
      headers: { "content-type": "application/yaml" },
    })
    .then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Result & ErrorBody,
    }))

test("one file creates an organization, its projects, fleets and emulators", async () => {
  const h = start()
  const ada = await h.signIn("ada@example.test")
  const plan = await apply(ada, file, "?dryRun=true")
  expect([plan.status, plan.body.applied, plan.body.organization]).toEqual([200, false, null])
  expect((await ada.api<{ data: unknown[] }>("GET", "/orgs")).body.data).toEqual([])

  const done = await apply(ada, file)
  expect(done.status).toBe(200)
  expect(brief(done.body.changes)).toEqual([
    "create organization acme",
    "create project web",
    "create fleet acme-staging",
    "create emulator acme-staging/resend",
    "create emulator acme-staging/mail",
  ])
  // The local-only PostgreSQL service is not a hosted emulator.
  const sent = await h.client().raw("POST", "/f/acme-staging/resend/emails", {
    headers: { authorization: "Bearer re_x", "content-type": "application/json" },
    body: JSON.stringify({
      from: "a@example.test",
      to: "b@example.test",
      subject: "hi",
      html: "x",
    }),
  })
  expect(sent.status).toBe(200)
  expect((await h.client().raw("GET", "/f/acme-staging/db/")).status).toBe(404)
  const org = (
    await ada.api<{ managed: { appliedBy: string }; role: string }>(
      "GET",
      `/orgs/${done.body.organization}`,
    )
  ).body
  expect([org.role, org.managed.appliedBy]).toEqual(["owner", "ada@example.test"])

  // Applying the same file again changes nothing, and keeps the emulator's state.
  expect(brief((await apply(ada, file)).body.changes)).toEqual([])
  expect(h.objects.objects.size).toBe(1)
})

test("a managed organization is changed by its file, not by hand", async () => {
  const h = start()
  const ada = await h.signIn("ada@example.test")
  const org = (await apply(ada, file)).body.organization as string
  const project = (await ada.api<{ data: { id: string }[] }>("GET", `/orgs/${org}/projects`)).body
    .data[0]?.id
  const fleet = (await ada.api<{ data: { id: string }[] }>("GET", `/projects/${project}/fleets`))
    .body.data[0]?.id
  const refused = async (method: string, path: string, body?: unknown) => {
    const response = await ada.api<ErrorBody>(method, path, body)
    expect([path, response.status, response.body.error.code]).toEqual([
      path,
      409,
      "managed_by_declaration",
    ])
    expect(response.body.error.message).toContain("mockingbird.yaml")
  }
  await refused("PATCH", `/orgs/${org}`, { name: "Renamed" })
  await refused("POST", `/orgs/${org}/projects`, { name: "By hand" })
  await refused("PATCH", `/projects/${project}`, { name: "Renamed" })
  await refused("DELETE", `/projects/${project}`)
  await refused("POST", `/projects/${project}/fleets`, { name: "By hand" })
  await refused("PATCH", `/fleets/${fleet}`, { access: "key" })
  await refused("DELETE", `/fleets/${fleet}`)
  await refused("PUT", `/fleets/${fleet}/emulators/stripe`, { target: "stripe" })
  await refused("PATCH", `/fleets/${fleet}/emulators/resend`, { durability: "ephemeral" })
  await refused("DELETE", `/fleets/${fleet}/emulators/resend`)
  // Operating the fleet, and managing people and keys, is not configuration.
  expect((await ada.api("POST", `/fleets/${fleet}/emulators/resend/reset`)).status).toBe(200)
  expect((await ada.api("POST", `/orgs/${org}/api-keys`, { name: "ci" })).status).toBe(201)
  expect((await ada.api("POST", `/orgs/${org}/invites`, { email: "b@example.test" })).status).toBe(
    201,
  )

  // Released, it can be changed by hand again, and nothing was deleted.
  expect(
    (await ada.api<{ managed: null }>("DELETE", `/orgs/${org}/manifest`)).body.managed,
  ).toBeNull()
  expect((await ada.api("PATCH", `/fleets/${fleet}`, { access: "key" })).status).toBe(200)
})

test("changes are planned, described, and deletions need prune", async () => {
  const h = start()
  const ada = await h.signIn("ada@example.test")
  const org = (await apply(ada, file)).body.organization as string
  const next = file
    .replace("access: open", "access: key")
    .replace("resend: { durability: strict }", "resend: { durability: buffered }")
    .replace("mail: { target: resend }", "stripe: {}")
  const plan = await apply(ada, next, "?dryRun=true")
  expect(plan.body.changes.filter((c) => c.action !== "unchanged")).toEqual([
    { action: "update", kind: "fleet", name: "acme-staging", detail: "access open → key" },
    {
      action: "update",
      kind: "emulator",
      name: "acme-staging/resend",
      detail: "durability strict → buffered",
    },
    { action: "create", kind: "emulator", name: "acme-staging/stripe", detail: "buffered" },
    {
      action: "delete",
      kind: "emulator",
      name: "acme-staging/mail",
      detail: "its stored state is erased",
    },
  ])
  // A dry run changed nothing.
  expect(brief((await apply(ada, file, "?dryRun=true")).body.changes)).toEqual([])

  const blocked = await apply(ada, next)
  expect([blocked.status, blocked.body.error.code]).toEqual([409, "prune_required"])
  expect(blocked.body.error.message).toContain("emulator acme-staging/mail")
  expect((await apply(ada, next, "?prune=true")).status).toBe(200)
  expect((await h.client().raw("GET", "/f/acme-staging/mail/emails")).status).toBe(401)

  // Dropping the project from the file deletes its fleets too.
  const empty = "version: 1\norganization: acme\nprojects: {}\n"
  expect(brief((await apply(ada, empty, "?prune=true")).body.changes)).toEqual([
    "delete fleet acme-staging",
    "delete project web",
  ])
  expect((await ada.api<{ data: unknown[] }>("GET", `/orgs/${org}/projects`)).body.data).toEqual([])
  expect(h.objects.objects.size).toBe(0)
})

test("an invalid file is refused with the path of every problem, and changes nothing", async () => {
  const h = start()
  const ada = await h.signIn("ada@example.test")
  const bad = await apply(
    ada,
    file
      .replace("durability: strict", "durability: eventual")
      .replace("access: open", "access: public"),
  )
  expect(bad.status).toBe(400)
  expect(bad.body.error.details).toEqual([
    "projects.web.fleets.acme-staging.access: must be one of open, key",
    "projects.web.fleets.acme-staging.services.resend.durability: must be one of strict, buffered, ephemeral",
  ])
  const wire = await apply(ada, file.replace(", local: true", ""))
  expect(wire.status).toBe(400)
  expect(wire.body.error.message).toContain("projects.web.fleets.acme-staging.services.db")
  expect(wire.body.error.message).toContain("local: true")
  expect((await apply(ada, "version: 1\n  organization: [")).status).toBe(400)
  expect((await ada.api<{ data: unknown[] }>("GET", "/orgs")).body.data).toEqual([])
})

test("who may apply: admins of the organization, and only a person can create one", async () => {
  const h = start({
    config: { limits: { ...loadConfig({ AUTH_DEV_LOGIN: "1" }).limits, fleetsPerOrg: 1 } },
  })
  const ada = await h.signIn("ada@example.test")
  const org = (await apply(ada, file)).body.organization as string
  const keys = async (role: string) =>
    h.client({
      key: (await ada.api<{ key: string }>("POST", `/orgs/${org}/api-keys`, { name: role, role }))
        .body.key,
    })
  expect((await apply(await keys("admin"), file)).status).toBe(200)
  expect((await apply(await keys("member"), file)).status).toBe(403)
  // Someone outside cannot tell the organization exists, and a key cannot create a new one.
  expect((await apply(await h.signIn("eve@example.test"), file)).status).toBe(404)
  expect(
    (await apply(await keys("admin"), file.replace("organization: acme", "organization: other")))
      .status,
  ).toBe(404)
  expect((await apply(h.client(), file)).status).toBe(401)
  // A fleet slug belongs to one organization across the whole service.
  const taken = await apply(
    await h.signIn("bob@example.test"),
    file.replace("organization: acme", "organization: bobs"),
  )
  expect([taken.status, taken.body.error.code]).toEqual([409, "conflict"])
  // Quotas apply to what the file declares.
  const two = file.replace(
    "      acme-staging:",
    "      acme-preview: { services: { resend: {} } }\n      acme-staging:",
  )
  const over = await apply(ada, two)
  expect([over.status, over.body.error.code]).toEqual([403, "quota_exceeded"])
})

test("any organization can be exported as a file that reproduces it", async () => {
  const h = start()
  const ada = await h.signIn("ada@example.test")
  const org = (await ada.api<{ id: string }>("POST", "/orgs", { name: "Globex", slug: "globex" }))
    .body
  const project = (
    await ada.api<{ id: string }>("POST", `/orgs/${org.id}/projects`, { name: "API", slug: "api" })
  ).body
  await ada.api("POST", `/projects/${project.id}/fleets`, {
    name: "Preview",
    slug: "globex-preview",
    access: "key",
    requestsPerMinute: 120,
    emulators: { resend: { target: "resend", durability: "strict" }, mail: { target: "resend" } },
  })
  const view = (
    await ada.api<{ managed: null; yaml: string; declaration: object }>(
      "GET",
      `/orgs/${org.id}/manifest`,
    )
  ).body
  expect(view.managed).toBeNull()
  expect(view.declaration).toEqual({
    version: 1,
    organization: "globex",
    name: "Globex",
    projects: {
      api: {
        name: "API",
        fleets: {
          "globex-preview": {
            name: "Preview",
            access: "key",
            requestsPerMinute: 120,
            services: {
              resend: { durability: "strict" },
              mail: { target: "resend", durability: "buffered" },
            },
          },
        },
      },
    },
  })
  // Adopting: the exported file applies with nothing to change, and the organization is managed.
  const adopted = await apply(ada, view.yaml)
  expect([adopted.status, brief(adopted.body.changes)]).toEqual([200, []])
  const managed = (
    await ada.api<{ managed: object; yaml: string }>("GET", `/orgs/${org.id}/manifest`)
  ).body
  expect(managed.managed).not.toBeNull()
  expect(Bun.YAML.parse(managed.yaml)).toEqual(view.declaration)
  expect(ORIGIN).toBeString()
})
