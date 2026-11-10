import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { createRoutes } from "../src/api.js"
import { openApiDocument } from "../src/openapi.js"
import { type Client, harness, ORIGIN } from "./harness.js"

const open: { close(): Promise<void> }[] = []
const start = (...args: Parameters<typeof harness>) => {
  const created = harness(...args)
  open.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()))
})

type Fleet = {
  id: string
  slug: string
  url: string
  access: string
  emulators: Record<
    string,
    { target: string; durability: string; url: string; status: { dirty: boolean } }
  >
}

/** An org, a project and a fleet with one emulator, owned by a freshly signed-in user. */
async function tenant(
  h: ReturnType<typeof harness>,
  email = "owner@example.test",
  durability = "strict",
) {
  const owner = await h.signIn(email)
  const org = (await owner.api<{ id: string }>("POST", "/orgs", { name: "Acme" })).body
  const project = (
    await owner.api<{ id: string }>("POST", `/orgs/${org.id}/projects`, { name: "Web" })
  ).body
  const created = await owner.api<Fleet>("POST", `/projects/${project.id}/fleets`, {
    name: "Staging",
    emulators: { resend: { target: "resend", durability } },
  })
  expect(created.status).toBe(201)
  return { owner, org, project, fleet: created.body }
}

const sendEmail = (client: Client, fleet: Fleet, headers: Record<string, string> = {}) =>
  client.raw("POST", `/f/${fleet.slug}/resend/emails`, {
    headers: {
      authorization: "Bearer re_vendor_key",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      from: "a@example.test",
      to: "b@example.test",
      subject: "hi",
      html: "<p>hi</p>",
    }),
  })

test("health answers without a database, a session or a body", async () => {
  const h = start()
  const response = await h.client().raw("GET", "/health")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: "ok" })
})

test("the API refuses anonymous callers and unknown keys", async () => {
  const h = start()
  expect((await h.client().api("GET", "/me")).status).toBe(401)
  expect((await h.client({ key: "mbf_o_nope" }).api("GET", "/me")).status).toBe(401)
  expect((await h.client().api("GET", "/config")).status).toBe(200)
})

test("a fleet gets a stable URL and serves its emulator from object storage", async () => {
  const h = start()
  const { fleet } = await tenant(h)
  expect(fleet.url).toBe(`${ORIGIN}/f/${fleet.slug}`)
  expect(fleet.emulators.resend?.url).toBe(`${ORIGIN}/f/${fleet.slug}/resend`)

  // The vendor SDK needs nothing but the URL: no Mockingbird credential on an open fleet.
  const sent = await sendEmail(h.client(), fleet)
  expect(sent.status).toBe(200)
  const { id } = (await sent.json()) as { id: string }
  expect(h.objects.objects.size).toBe(1)

  const read = await h.client().raw("GET", `/f/${fleet.slug}/resend/emails/${id}`, {
    headers: { authorization: "Bearer re_vendor_key" },
  })
  expect(read.status).toBe(200)

  const discovery = await h.client().raw("GET", `/f/${fleet.slug}`)
  expect(((await discovery.json()) as { emulators: object }).emulators).toHaveProperty("resend")
  expect((await h.client().raw("GET", `/f/${fleet.slug}/stripe/v1/customers`)).status).toBe(404)
  expect((await h.client().raw("GET", "/f/no-such-fleet/resend/emails")).status).toBe(404)
})

test("durability is set per emulator and changing it takes effect at once", async () => {
  const h = start()
  const { owner, fleet } = await tenant(h)
  await owner.api("PUT", `/fleets/${fleet.id}/emulators/outbox`, {
    target: "resend",
    durability: "ephemeral",
  })
  await sendEmail(h.client(), fleet)
  await h.client().raw("POST", `/f/${fleet.slug}/outbox/emails`, {
    headers: { authorization: "Bearer re_x", "content-type": "application/json" },
    body: JSON.stringify({ from: "a@example.test", to: "b@example.test", subject: "x", html: "x" }),
  })
  // Only the strict emulator is stored.
  expect([...h.objects.objects.keys()]).toEqual([`fleets/${fleet.id}/resend/state.json.gz`])

  const patched = await owner.api<Fleet>("PATCH", `/fleets/${fleet.id}/emulators/resend`, {
    durability: "ephemeral",
  })
  expect(patched.body.emulators.resend?.durability).toBe("ephemeral")
  expect(h.objects.objects.size).toBe(0)

  await owner.api("PATCH", `/fleets/${fleet.id}/emulators/outbox`, {
    durability: "buffered",
    flushIntervalMs: 100,
  })
  expect([...h.objects.objects.keys()]).toEqual([`fleets/${fleet.id}/outbox/state.json.gz`])

  expect(
    (await owner.api("PATCH", `/fleets/${fleet.id}/emulators/resend`, { durability: "eventually" }))
      .status,
  ).toBe(400)
  expect(
    (await owner.api("PUT", `/fleets/${fleet.id}/emulators/db`, { target: "postgres" })).status,
  ).toBe(400)
})

test("reset, export and delete manage an emulator's stored state", async () => {
  const h = start()
  const { owner, fleet } = await tenant(h)
  await sendEmail(h.client(), fleet)
  const state = await owner.api<{ format: string; target: string }>(
    "GET",
    `/fleets/${fleet.id}/emulators/resend/state`,
  )
  expect(state.body).toMatchObject({ format: "mockingbird.fleet-cloud.state/v1", target: "resend" })
  expect(JSON.stringify(state.body)).toContain("b@example.test")

  expect((await owner.api("POST", `/fleets/${fleet.id}/emulators/resend/reset`)).status).toBe(200)
  expect(h.objects.objects.size).toBe(0)
  const after = await owner.api("GET", `/fleets/${fleet.id}/emulators/resend/state`)
  expect(JSON.stringify(after.body)).not.toContain("b@example.test")

  await sendEmail(h.client(), fleet)
  expect(h.objects.objects.size).toBe(1)
  expect((await owner.api("DELETE", `/fleets/${fleet.id}`)).status).toBe(200)
  expect(h.objects.objects.size).toBe(0)
  expect((await sendEmail(h.client(), fleet)).status).toBe(404)
})

test("a key-protected fleet and every emulator admin route need an API key", async () => {
  const h = start()
  const { owner, org, fleet } = await tenant(h)
  const key = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "ci",
      role: "member",
    })
  ).body.key
  const viewer = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "ro",
      role: "viewer",
    })
  ).body.key
  expect(key).toMatch(/^mbf_o_/)

  // Admin routes can reset and rewrite state, so the URL alone is never enough for them,
  // and neither is a dashboard session: a page served by an emulator could ride on that.
  expect((await h.client().raw("GET", `/f/${fleet.slug}/resend/__admin/state`)).status).toBe(401)
  expect((await owner.raw("GET", `/f/${fleet.slug}/resend/__admin/state`)).status).toBe(401)
  expect(
    (
      await h.client().raw("GET", `/f/${fleet.slug}/resend/__admin/state`, {
        headers: { "x-mockingbird-api-key": viewer },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await h.client().raw("GET", `/f/${fleet.slug}/resend/__admin/state`, {
        headers: { "x-mockingbird-api-key": key },
      })
    ).status,
  ).toBe(200)

  await owner.api("PATCH", `/fleets/${fleet.id}`, { access: "key" })
  expect((await sendEmail(h.client(), fleet)).status).toBe(401)
  expect(
    (await sendEmail(h.client(), fleet, { "x-mockingbird-api-key": "mbf_o_wrong" })).status,
  ).toBe(401)
  expect((await sendEmail(h.client(), fleet, { "x-mockingbird-api-key": viewer })).status).toBe(200)
})

test("emulator responses cannot act as the dashboard on a shared origin", async () => {
  const h = start()
  const { owner, fleet } = await tenant(h)
  const response = await owner.raw("GET", `/f/${fleet.slug}/resend/emails/none`, {
    headers: { authorization: "Bearer re_x" },
  })
  expect(response.headers.get("content-security-policy")).toContain("sandbox")
  // The dashboard itself is not sandboxed and is the single-page app on any client route.
  const page = await h.client().raw("GET", "/orgs/anything")
  expect(page.status).toBe(200)
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
})

test("a dedicated fleet host serves fleets only, and the dashboard host serves none", async () => {
  const h = start({ config: { fleetUrl: "https://fleets.example.test", publicUrl: ORIGIN } })
  const { fleet } = await tenant(h)
  expect(fleet.url).toBe(`https://fleets.example.test/f/${fleet.slug}`)
  expect((await h.client().raw("GET", `/f/${fleet.slug}`)).status).toBe(404)
  const onFleetHost = (path: string) =>
    h.app.fetch(new Request(`https://fleets.example.test${path}`))
  expect((await onFleetHost(`/f/${fleet.slug}`)).status).toBe(200)
  expect((await onFleetHost("/api/v1/config")).status).toBe(404)
  expect((await onFleetHost("/health")).status).toBe(200)
})

test("a browser session changes state only with the CSRF header and our origin", async () => {
  const h = start()
  const owner = await h.signIn("owner@example.test")
  const cookie = (await owner.raw("GET", "/api/v1/me")).status
  expect(cookie).toBe(200)
  const post = (headers: Record<string, string>) =>
    owner.raw("POST", "/api/v1/orgs", {
      body: JSON.stringify({ name: "Acme" }),
      headers: { "content-type": "application/json", ...headers },
    })
  expect((await post({ "x-mockingbird-csrf": "" })).status).toBe(403)
  expect((await post({ origin: "https://evil.example" })).status).toBe(403)
  expect((await post({ origin: ORIGIN })).status).toBe(201)
})

test("organizations isolate tenants; roles bound what a member can do", async () => {
  const h = start()
  const { owner, org, project, fleet } = await tenant(h)
  const outsider = await h.signIn("outsider@example.test")
  // Someone outside the organization cannot tell its resources exist.
  for (const path of [
    `/orgs/${org.id}`,
    `/projects/${project.id}`,
    `/fleets/${fleet.id}`,
    `/orgs/${org.id}/members`,
  ])
    expect((await outsider.api("GET", path)).status).toBe(404)
  expect((await outsider.api("DELETE", `/fleets/${fleet.id}`)).status).toBe(404)

  const invite = (
    await owner.api<{ token: string; acceptUrl: string }>("POST", `/orgs/${org.id}/invites`, {
      email: "outsider@example.test",
      role: "viewer",
    })
  ).body
  expect(invite.acceptUrl).toBe(`${ORIGIN}/invite/${invite.token}`)
  expect((await outsider.api("POST", "/invites/accept", { token: invite.token })).status).toBe(200)
  expect((await outsider.api("POST", "/invites/accept", { token: invite.token })).status).toBe(404)

  expect((await outsider.api("GET", `/fleets/${fleet.id}`)).status).toBe(200)
  expect((await outsider.api("POST", `/orgs/${org.id}/projects`, { name: "x" })).status).toBe(403)
  expect(
    (await outsider.api("PUT", `/fleets/${fleet.id}/emulators/x`, { target: "resend" })).status,
  ).toBe(403)
  expect((await outsider.api("GET", `/orgs/${org.id}/api-keys`)).status).toBe(403)

  const members = (
    await owner.api<{ data: { userId: string; role: string }[] }>("GET", `/orgs/${org.id}/members`)
  ).body.data
  const me = members.find((member) => member.role === "owner")
  const them = members.find((member) => member.role === "viewer")
  expect(members).toHaveLength(2)
  // The last owner can neither leave nor be demoted.
  expect((await owner.api("DELETE", `/orgs/${org.id}/members/${me?.userId}`)).status).toBe(409)
  expect(
    (await owner.api("PATCH", `/orgs/${org.id}/members/${me?.userId}`, { role: "admin" })).status,
  ).toBe(409)
  expect(
    (await owner.api("PATCH", `/orgs/${org.id}/members/${them?.userId}`, { role: "admin" })).status,
  ).toBe(200)
  // An admin cannot make anyone an owner.
  expect(
    (await outsider.api("PATCH", `/orgs/${org.id}/members/${them?.userId}`, { role: "owner" }))
      .status,
  ).toBe(403)
  expect((await outsider.api("DELETE", `/orgs/${org.id}/members/${them?.userId}`)).status).toBe(200)
  expect((await outsider.api("GET", `/orgs/${org.id}`)).status).toBe(404)
})

test("one invite link admits exactly one person, even when two use it at once", async () => {
  const h = start()
  const { owner, org } = await tenant(h)
  const invite = (
    await owner.api<{ token: string }>("POST", `/orgs/${org.id}/invites`, {
      email: "a@example.test",
    })
  ).body
  const [first, second] = await Promise.all([
    h.signIn("a@example.test"),
    h.signIn("b@example.test"),
  ])
  const results = await Promise.all(
    [first, second].map((client) => client.api("POST", "/invites/accept", { token: invite.token })),
  )
  expect(results.map((result) => result.status).sort()).toEqual([200, 404])
  const members = await owner.api<{ data: unknown[] }>("GET", `/orgs/${org.id}/members`)
  expect(members.body.data).toHaveLength(2)
  expect(
    (await owner.api<{ data: unknown[] }>("GET", `/orgs/${org.id}/invites`)).body.data,
  ).toEqual([])
})

test("API keys act within their scope and never above their creator", async () => {
  const h = start()
  const { owner, org, project, fleet } = await tenant(h)
  const other = (
    await owner.api<{ id: string }>("POST", `/orgs/${org.id}/projects`, { name: "Other" })
  ).body

  const token = (
    await owner.api<{ key: string; id: string }>("POST", "/tokens", { name: "laptop" })
  ).body
  const personal = h.client({ key: token.key })
  expect((await personal.api<{ kind: string }>("GET", "/me")).body.kind).toBe("user")
  expect((await personal.api("POST", "/orgs", { name: "Second" })).status).toBe(201)

  const projectKey = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "web",
      projectId: project.id,
    })
  ).body.key
  const scoped = h.client({ key: projectKey })
  expect(projectKey).toMatch(/^mbf_p_/)
  expect((await scoped.api("GET", `/fleets/${fleet.id}`)).status).toBe(200)
  expect(
    (await scoped.api("PUT", `/fleets/${fleet.id}/emulators/two`, { target: "resend" })).status,
  ).toBe(200)
  expect((await scoped.api("GET", `/projects/${other.id}`)).status).toBe(404)
  expect(
    (await scoped.api<{ data: unknown[] }>("GET", `/orgs/${org.id}/projects`)).body.data,
  ).toHaveLength(1)
  expect((await scoped.api("POST", `/orgs/${org.id}/projects`, { name: "x" })).status).toBe(404)
  expect((await scoped.api("POST", "/orgs", { name: "x" })).status).toBe(403)

  const admin = (
    await owner.api<{ key: string; id: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "ops",
      role: "admin",
    })
  ).body
  const ops = h.client({ key: admin.key })
  expect(
    (await ops.api("POST", `/orgs/${org.id}/api-keys`, { name: "x", role: "admin" })).status,
  ).toBe(201)
  expect((await ops.api("DELETE", `/orgs/${org.id}`)).status).toBe(403)
  expect(
    (await owner.api("POST", `/orgs/${org.id}/api-keys`, { name: "x", role: "owner" })).status,
  ).toBe(400)

  // The secret is shown once; listings carry only the prefix.
  const listed = (
    await owner.api<{ data: Record<string, unknown>[] }>("GET", `/orgs/${org.id}/api-keys`)
  ).body.data
  expect(listed.every((key) => key.key === undefined && typeof key.prefix === "string")).toBe(true)
  expect((await owner.api("DELETE", `/orgs/${org.id}/api-keys/${admin.id}`)).status).toBe(200)
  expect((await ops.api("GET", `/orgs/${org.id}`)).status).toBe(401)
  expect((await owner.api("DELETE", `/tokens/${token.id}`)).status).toBe(200)
  expect((await personal.api("GET", "/me")).status).toBe(401)
})

test("slugs are stable, unique and validated", async () => {
  const h = start()
  const { owner, project } = await tenant(h)
  const named = await owner.api<Fleet>("POST", `/projects/${project.id}/fleets`, {
    name: "Checkout",
    slug: "checkout",
  })
  expect(named.body.url).toBe(`${ORIGIN}/f/checkout`)
  expect(
    (await owner.api("POST", `/projects/${project.id}/fleets`, { name: "Again", slug: "checkout" }))
      .status,
  ).toBe(409)
  expect(
    (await owner.api("POST", `/projects/${project.id}/fleets`, { name: "Bad", slug: "Not A Slug" }))
      .status,
  ).toBe(400)
  expect(
    (await owner.api("POST", `/projects/${project.id}/fleets`, { name: "Bad", extra: 1 })).status,
  ).toBe(400)
  const renamed = await owner.api<Fleet>("PATCH", `/fleets/${named.body.id}`, {
    name: "Checkout v2",
  })
  expect(renamed.body.slug).toBe("checkout")
})

test("webhook delivery is off unless the emulator lists public https origins", async () => {
  const h = start()
  const { owner, fleet } = await tenant(h)
  const put = (webhookOrigins: string[]) =>
    owner.api("PUT", `/fleets/${fleet.id}/emulators/hooks`, { target: "resend", webhookOrigins })
  for (const origin of [
    "http://app.example.com",
    "https://localhost",
    "https://10.0.0.5",
    "https://db.internal",
    "https://app.example.com/path",
  ])
    expect((await put([origin])).status).toBe(400)
  expect((await put(["https://app.example.com"])).status).toBe(200)
})

test("deleting an organization removes its projects, fleets, keys and stored state", async () => {
  const h = start()
  const { owner, org, fleet } = await tenant(h)
  const key = (await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" }))
    .body.key
  await sendEmail(h.client(), fleet)
  expect((await owner.api("DELETE", `/orgs/${org.id}`)).status).toBe(200)
  expect(h.objects.objects.size).toBe(0)
  expect((await h.client({ key }).api("GET", "/me")).status).toBe(401)
  expect((await owner.api<{ data: unknown[] }>("GET", "/orgs")).body.data).toHaveLength(0)
  for (const table of ["projects", "fleets", "memberships", "api_keys"] as const)
    expect(await h.db.find(table, {})).toHaveLength(0)
})

test("the OpenAPI document covers every route and the committed copy is current", async () => {
  const h = start()
  const served = (await (await h.client().raw("GET", "/api/openapi.json")).json()) as {
    paths: Record<string, Record<string, { operationId: string }>>
  }
  const routes = createRoutes()
  const operations = Object.values(served.paths).flatMap((item) =>
    Object.values(item).map((op) => op.operationId),
  )
  expect(operations.sort()).toEqual(routes.map((route) => route.operationId).sort())
  expect(new Set(operations).size).toBe(operations.length)

  const committed = await Bun.file(join(import.meta.dir, "../openapi.json")).text()
  const expected = `${JSON.stringify(openApiDocument(routes, "https://mockingbird-fleet.chrisvouga.dev"), null, 2)}\n`
  expect(committed === expected).toBe(true)
})

test("the generated catalog is current with the service packages", () => {
  const check = Bun.spawnSync(["bun", "scripts/catalog.ts", "--check"], {
    cwd: join(import.meta.dir, ".."),
  })
  expect(check.stderr.toString()).toBe("")
  expect(check.exitCode).toBe(0)
})
