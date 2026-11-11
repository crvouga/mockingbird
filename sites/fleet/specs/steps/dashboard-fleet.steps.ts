/** A project's fleets and a fleet's emulators in the browser. */
import { readFile } from "node:fs/promises"
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import { type Dashboard, literal } from "../support/dashboard.js"
import { idOf } from "../support/tenancy.js"
import type { Reply, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

type Emulator = { target: string; durability: string; url: string }
type Fleet = { id: string; slug: string; url: string; emulators: Record<string, Emulator> }

const fleetOf = (world: World, name: string) => world.thing<Fleet>(name)

/** The fleet as the API describes it now, asked by whoever owns its organization. */
async function current(world: World, name: string): Promise<Fleet> {
  for (const [person, credential] of world.people) {
    if (credential.kind !== "session") continue
    const reply = await world.api(person, "GET", `/fleets/${fleetOf(world, name).id}`)
    if (reply.status === 200) return reply.body as Fleet
  }
  throw new Error(`Nobody in this scenario can read the fleet "${name}"`)
}

/** Call an emulator the way its vendor's SDK would, with the vendor's own credential only. */
async function call(world: World, fleet: string, emulator: string): Promise<Reply> {
  const { slug, emulators } = await current(world, fleet)
  if (emulators[emulator]?.target === "stripe")
    return world.emulator(slug, emulator, "GET", "/v1/customers", {
      headers: { authorization: "Bearer sk_test_spec" },
    })
  return sendEmail(world, slug, emulator)
}

const sendEmail = (world: World, slug: string, emulator: string) =>
  world.emulator(slug, emulator, "POST", "/emails", {
    headers: { authorization: "Bearer re_spec_key" },
    body: {
      from: "sender@example.test",
      to: "receiver@example.test",
      subject: "Hello from the spec",
      html: "<p>Hello</p>",
    },
  })

const readEmail = (world: World, fleet: string, emulator: string) =>
  world.emulator(
    fleetOf(world, fleet).slug,
    emulator,
    "GET",
    `/emails/${world.thing<{ id: string }>("the email that was sent").id}`,
    { headers: { authorization: "Bearer re_spec_key" } },
  )

// ---- what exists before the browser opens --------------------------------------------------

Given(
  "{word} has a fleet {string} in the project {string} at the slug {string}",
  async ({ world }, person: string, name: string, project: string, slug: string) => {
    world.things.set(
      name,
      await world.must(person, "POST", `/projects/${idOf(world, project)}/fleets`, {
        name,
        slug: world.slug(slug),
      }),
    )
  },
)

Given(
  "{word} has a fleet {string} in the project {string} running:",
  async ({ world }, person: string, name: string, project: string, table: DataTable) => {
    world.things.set(
      name,
      await world.must(person, "POST", `/projects/${idOf(world, project)}/fleets`, {
        name,
        slug: world.slug(name),
        emulators: Object.fromEntries(
          table.hashes().map((row) => [
            row.name,
            {
              target: row.emulator,
              durability: row.durability,
              // Long enough that "unsaved changes" stays on screen until someone saves.
              ...(row.durability === "buffered" ? { flushIntervalMs: 60_000 } : {}),
            },
          ]),
        ),
      }),
    )
  },
)

Given("the fleet {string} requires an API key", async ({ world }, name: string) => {
  const fleet = fleetOf(world, name)
  for (const [person, credential] of world.people)
    if (credential.kind === "session") {
      const reply = await world.api(person, "PATCH", `/fleets/${fleet.id}`, { access: "key" })
      if (reply.status === 200) return
    }
  throw new Error(`Nobody in this scenario could protect "${name}"`)
})

Given(
  "{int} email(s) has/have been sent through the {string} emulator of {string}",
  async ({ world }, count: number, emulator: string, fleet: string) => {
    for (let sent = 0; sent < count; sent++) {
      const reply = await sendEmail(world, fleetOf(world, fleet).slug, emulator)
      expect(reply.status, reply.text).toBe(200)
      world.things.set("the email that was sent", reply.body as Record<string, unknown>)
    }
  },
)

// ---- a project's fleets --------------------------------------------------------------------

When(
  "they type a slug of their own {string} into {string}",
  async ({ dash, world }, slug: string, label: string) => {
    await dash.field(label).fill(world.slug(slug))
  },
)

Then("the fleet's address on screen is under {string}", async ({ dash, world }, path: string) => {
  await expect(dash.page.getByText(new RegExp(`^${world.url}${path}[a-z0-9-]+$`))).toBeVisible()
})

Then(
  "the fleet's address on screen ends with the slug {string}",
  async ({ dash, world }, slug: string) => {
    await expect(
      dash.page.getByText(`${world.url}/f/${world.slug(slug)}`, { exact: true }),
    ).toBeVisible()
  },
)

Then(
  "the fleet {string} is listed with {string}",
  async ({ dash, world }, name: string, text: string) => {
    const row = dash.page
      .getByRole("navigation", { name: "Fleets", exact: true })
      .getByRole("link")
      .filter({ hasText: fleetOf(world, name).url })
    await expect(row).toContainText(name)
    await expect(row.getByText(text, { exact: true })).toBeVisible()
  },
)

// ---- addresses -----------------------------------------------------------------------------

Then(
  "the address of the fleet {string} is on screen with a {string} button",
  async ({ dash, world }, name: string, button: string) => {
    const copy = dash.copyable(fleetOf(world, name).url, dash.setting("URL"))
    await expect(copy).toBeVisible()
    await expect(dash.button(button, copy)).toBeVisible()
  },
)

Then(
  "the address of the {string} emulator of {string} is on its card with a {string} button",
  async ({ dash, world }, emulator: string, fleet: string, button: string) => {
    const copy = dash.copyable(`${fleetOf(world, fleet).url}/${emulator}`, dash.emulator(emulator))
    await expect(copy).toBeVisible()
    await expect(dash.button(button, copy)).toBeVisible()
  },
)

When(
  "they press {string} beside the address of the fleet {string}",
  async ({ dash, world }, button: string, name: string) => {
    await dash.idle()
    await dash.button(button, dash.copyable(fleetOf(world, name).url)).click()
  },
)

Then(
  "the clipboard holds the address of the fleet {string}",
  async ({ dash, world }, name: string) => {
    await expect
      .poll(() => dash.page.evaluate(() => navigator.clipboard.readText()))
      .toBe(fleetOf(world, name).url)
  },
)

Then("the address of the fleet {string} no longer answers", async ({ world }, name: string) => {
  const reply = await world.emulator(fleetOf(world, name).slug, "resend", "GET", "/emails")
  expect(reply.status, reply.text).toBe(404)
})

// ---- who can call, and how often -----------------------------------------------------------

Then(
  "a caller without a key can use the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await expect.poll(async () => (await call(world, fleet, emulator)).status).toBe(200)
  },
)

Then(
  "a caller without a key is refused by the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await expect.poll(async () => (await call(world, fleet, emulator)).status).toBe(401)
  },
)

Then(
  "after {int} requests in a row the {string} emulator of {string} refuses the next as too many",
  async ({ world }, allowed: number, emulator: string, fleet: string) => {
    const statuses: number[] = []
    for (let sent = 0; sent <= allowed; sent++)
      statuses.push((await call(world, fleet, emulator)).status)
    expect(statuses).toEqual([...Array.from({ length: allowed }, () => 200), 429])
  },
)

Then(
  "the API reports no requests per minute of its own for {string}",
  async ({ world }, fleet: string) => {
    expect(
      ((await current(world, fleet)) as { requestsPerMinute?: number | null }).requestsPerMinute ??
        null,
    ).toBeNull()
  },
)

// ---- the catalog ---------------------------------------------------------------------------

const catalog = (dash: Dashboard) =>
  dash.page.getByRole("navigation", { name: "Catalog", exact: true }).getByRole("link")

/** A catalog entry is a link whose text starts with the emulator's display name. */
const offer = (dash: Dashboard, name: string) =>
  catalog(dash).filter({ has: dash.page.getByText(name, { exact: true }) })

Then("the search offers {string}", async ({ dash }, name: string) => {
  await expect(offer(dash, name).first()).toBeVisible()
})

Then("the search offers every emulator of the catalog", async ({ dash, world }) => {
  const { data } = await world.must<{ data: unknown[] }>("anonymous", "GET", "/catalog")
  expect(data.length).toBeGreaterThan(30)
  await expect(catalog(dash)).toHaveCount(data.length)
  await expect(dash.page.getByText(`${data.length} emulators, all HTTP APIs.`)).toBeVisible()
})

Then("the search does not offer {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(offer(dash, name)).toHaveCount(0)
})

When("they follow the offer {string}", async ({ dash }, name: string) => {
  await dash.idle()
  await offer(dash, name).first().click()
  await dash.idle()
})

Then("the offer {string} says {string}", async ({ dash }, name: string, text: string) => {
  await expect(offer(dash, name).first().getByText(text, { exact: true })).toBeVisible()
})

// ---- emulator cards ------------------------------------------------------------------------

Then("there is an emulator {string}", async ({ dash }, name: string) => {
  await expect(dash.emulator(name)).toBeVisible()
})

Then("there is no emulator {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.emulator(name)).toHaveCount(0)
})

Then(
  "the {string} emulator is labelled as {string}",
  async ({ dash }, name: string, label: string) => {
    const header = dash.emulator(name).locator("header")
    await expect(header.getByRole("heading")).toHaveText(name)
    await expect(header).toContainText(label)
  },
)

Then("the emulator {string} is noted {string}", async ({ dash }, name: string, note: string) => {
  await expect(dash.emulator(name).getByRole("status")).toHaveText(note)
})

Then("{string} is the durability of {string}", async ({ dash }, mode: string, emulator: string) => {
  await expect(
    dash.setting("Durability", dash.emulator(emulator)).getByRole("definition").first(),
  ).toContainText(mode)
})

Then(
  "the durability of {string} is noted {string}",
  async ({ dash }, emulator: string, note: string) => {
    await expect(
      dash.setting("Durability", dash.emulator(emulator)).getByRole("status"),
    ).toHaveText(note)
  },
)

When(
  "the emulator {string} is removed from {string} through the API",
  async ({ world }, emulator: string, fleet: string) => {
    const { id } = fleetOf(world, fleet)
    for (const [person, credential] of world.people)
      if (credential.kind === "session") {
        const reply = await world.api(person, "DELETE", `/fleets/${id}/emulators/${emulator}`)
        if (reply.status < 300) return
      }
    throw new Error(`Nobody in this scenario could remove "${emulator}"`)
  },
)

Then("the durability choices are:", async ({ dash }, table: DataTable) => {
  const radios = dash.choices("Durability").getByRole("radio")
  const rows = table.raw()
  await expect(radios).toHaveCount(rows.length)
  for (const [index, [mode = "", consequence = ""]] of rows.entries())
    await expect(radios.nth(index)).toHaveAccessibleName(
      new RegExp(`^${literal(mode)}.*${literal(consequence)}$`),
    )
})

Then(
  "the API reports the durability of the {string} emulator of {string} as {string}",
  async ({ world }, emulator: string, fleet: string, mode: string) => {
    expect((await current(world, fleet)).emulators[emulator]?.durability).toBe(mode)
  },
)

Then("the state of {string} reads {string}", async ({ dash }, emulator: string, state: string) => {
  await expect(dash.emulator(emulator).getByText(state).first()).toBeVisible()
})

// ---- an emulator's state -------------------------------------------------------------------

When("they download the state of {string}", async ({ dash }, emulator: string) => {
  await dash.idle()
  const download = dash.page.waitForEvent("download")
  await dash.button(`Download the state of ${emulator}`, dash.emulator(emulator)).click()
  dash.download = await download
})

Then(
  "a file named after the fleet {string} and the emulator {string} is saved",
  async ({ dash, world }, fleet: string, emulator: string) => {
    expect(dash.download?.suggestedFilename()).toBe(
      `${fleetOf(world, fleet).slug}-${emulator}-state.json`,
    )
  },
)

Then("the saved file holds the email that was sent", async ({ dash, world }) => {
  const path = await dash.download?.path()
  if (!path) throw new Error("Nothing was downloaded")
  const text = await readFile(path, "utf8")
  expect(() => JSON.parse(text)).not.toThrow()
  expect(text).toContain(world.thing<{ id: string }>("the email that was sent").id)
})

Then(
  "the email that was sent is gone from the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await expect.poll(async () => (await readEmail(world, fleet, emulator)).status).toBe(404)
  },
)

Then(
  "the email that was sent is still in the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    expect((await readEmail(world, fleet, emulator)).status).toBe(200)
  },
)

Then(
  "the {string} emulator of {string} no longer answers",
  async ({ world }, emulator: string, fleet: string) => {
    await expect
      .poll(async () => (await sendEmail(world, fleetOf(world, fleet).slug, emulator)).status)
      .toBe(404)
  },
)
