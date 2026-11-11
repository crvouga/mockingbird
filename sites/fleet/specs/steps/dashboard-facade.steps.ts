/** The dashboard as a client of the API: what it requests, how it is served, what it lists. */
import { expect } from "@playwright/test"
import { Then, When } from "./common.steps.js"

type Operation = { summary: string; tags: string[] }
type OpenApi = { servers: { url: string }[]; paths: Record<string, Record<string, Operation>> }

const openapi = async (url: string) =>
  (await (await fetch(`${url}/api/openapi.json`)).json()) as OpenApi

// ---- what the page asks for ----------------------------------------------------------------

const FILES = new Set(["document", "stylesheet", "script"])

Then("the page consisted of the files {string}", async ({ dash, world }, files: string) => {
  const loaded = dash.requests
    .filter((request) => FILES.has(request.type) && request.url.startsWith(world.url))
    .map((request) => new URL(request.url).pathname)
  expect([...new Set(loaded)].sort()).toEqual(files.split(", ").sort())
})

Then("every other request went to {string}", async ({ dash, world }, prefixes: string) => {
  const allowed = prefixes.split(", ")
  const calls = dash.requests
    .filter((request) => !FILES.has(request.type) && request.url.startsWith(world.url))
    // The browser asks for an icon by itself; the page does not.
    .filter((request) => new URL(request.url).pathname !== "/favicon.ico")
    .map((request) => new URL(request.url).pathname)
  expect(calls.length).toBeGreaterThan(20)
  expect(calls.filter((path) => !allowed.some((prefix) => path.startsWith(prefix)))).toEqual([])
  for (const prefix of allowed)
    expect(
      calls.some((path) => path.startsWith(prefix)),
      prefix,
    ).toBe(true)
})

Then("nothing was requested from another origin", async ({ dash, world }) => {
  const elsewhere = dash.requests
    .map((request) => request.url)
    .filter((url) => !url.startsWith(`${world.url}/`) && !url.startsWith("blob:"))
  expect(elsewhere).toEqual([])
})

Then(
  "the page's content security policy only allows resources from the server itself",
  async ({ dash, world }) => {
    const response = await dash.page.request.get(`${world.url}/`)
    const policy = response.headers()["content-security-policy"] ?? ""
    expect(policy).toContain("default-src 'self'")
    expect(policy).not.toContain("unsafe-inline")
    expect(policy).not.toContain("unsafe-eval")
  },
)

Then("the page has no inline scripts or styles", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  const inline = await dash.page.evaluate(() => ({
    styled: document.querySelectorAll("[style]").length,
    styles: document.querySelectorAll("style").length,
    scripts: document.querySelectorAll("script:not([src])").length,
    handlers: [...document.querySelectorAll("*")].filter((element) =>
      element.getAttributeNames().some((name) => name.startsWith("on")),
    ).length,
  }))
  expect(inline).toEqual({ styled: 0, styles: 0, scripts: 0, handlers: 0 })
})

Then("the browser reported no blocked resources", async ({ dash }) => {
  expect(dash.blocked).toEqual([])
})

// ---- the API reference ---------------------------------------------------------------------

Then(
  "the server's API address is on screen with a {string} button",
  async ({ dash, world }, button: string) => {
    const copy = dash.copyable((await openapi(world.url)).servers[0]?.url ?? "")
    await expect(copy).toBeVisible()
    await expect(dash.button(button, copy)).toBeVisible()
  },
)

Then(
  "the address of the OpenAPI document is on screen with a {string} button",
  async ({ dash, world }, button: string) => {
    const copy = dash.copyable(`${world.url}/api/openapi.json`)
    await expect(copy).toBeVisible()
    await expect(dash.button(button, copy)).toBeVisible()
  },
)

Then(
  "every operation of the OpenAPI document is listed with its method, path and summary",
  async ({ dash, world }) => {
    const { paths } = await openapi(world.url)
    const expected = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).map(
        ([method, operation]) => `${method.toUpperCase()} ${path} ${operation.summary}`,
      ),
    )
    expect(expected.length).toBeGreaterThan(30)
    await expect(dash.page.getByRole("heading", { level: 1, name: "API reference" })).toBeVisible()
    const shown = (await dash.page.getByRole("main").innerText()).replace(/\s+/g, " ")
    for (const line of expected) expect(shown).toContain(line)
  },
)

Then("there is a section for every tag of the OpenAPI document", async ({ dash, world }) => {
  const { paths } = await openapi(world.url)
  const tags = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.tags[0] ?? "Other"),
    ),
  )
  await expect(dash.page.getByRole("heading", { level: 2 })).toHaveText([...tags])
})

const apiAddress = async (url: string) => (await openapi(url)).servers[0]?.url ?? ""

When(
  "they press {string} beside the server's API address",
  async ({ dash, world }, button: string) => {
    await dash.idle()
    await dash.button(button, dash.copyable(await apiAddress(world.url))).click()
  },
)

Then("the clipboard holds the server's API address", async ({ dash, world }) => {
  const address = await apiAddress(world.url)
  await expect.poll(() => dash.page.evaluate(() => navigator.clipboard.readText())).toBe(address)
})
