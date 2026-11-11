/**
 * An organization's `mockingbird.yaml` in the browser: the Configuration tab, the notice a
 * managed organization's screens carry, and the statement drawn in place of a hand edit the
 * file controls. An organization comes under a file through the API, never through the page.
 *
 * In a file a feature expects on screen, `<Acme>` stands for the slug of the thing the scenario
 * calls "Acme" (slugs are made unique per scenario).
 */
import { readFile } from "node:fs/promises"
import { expect } from "@playwright/test"
import type { Dashboard } from "../support/dashboard.js"
import { type Exported, parseYaml, sendFile, theFile } from "../support/declarative.js"
import { idOf, ownerOf } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const FILE = "mockingbird.yaml"

/** The block of the Configuration tab that shows the file, found by the name above it. */
const fileBlock = (dash: Dashboard) =>
  dash.page
    .getByRole("main")
    .locator("div")
    .filter({ has: dash.button(`Copy ${FILE}`) })
    .filter({ has: dash.page.locator("pre") })
    .last()

const fileOnScreen = async (dash: Dashboard) => {
  await expect(dash.button(`Copy ${FILE}`)).toBeVisible()
  return fileBlock(dash).getByRole("code").innerText()
}

/** `<Acme>` → the slug of the thing the scenario calls "Acme". */
const withSlugs = (world: World, text: string) =>
  text.replace(/<([^<>\n]+)>/g, (_, name: string) => world.thing<{ slug: string }>(name).slug)

// ---- coming under a file -------------------------------------------------------------------

/** Adopt the organization: apply the file Fleet Cloud exports for it, which changes nothing. */
Given(
  "the organization {string} has come under a mockingbird.yaml that declares it as it is",
  async ({ world }, org: string) => {
    const id = idOf(world, org)
    const owner = await ownerOf(world, id)
    const exported = await world.must<Exported>(owner, "GET", `/orgs/${id}/manifest`)
    const reply = await sendFile(world, owner, exported.yaml)
    expect(reply.status, reply.text).toBe(200)
  },
)

When(
  "the file on screen is applied as it is by {word}",
  async ({ dash, world }, person: string) => {
    await sendFile(world, person, await fileOnScreen(dash))
  },
)

// ---- the Configuration tab -----------------------------------------------------------------

Then("the file on screen is:", async ({ dash, world }, yaml: string) => {
  expect(parseYaml(await fileOnScreen(dash))).toEqual(parseYaml(withSlugs(world, yaml)))
})

Then("the file on screen is the mockingbird.yaml that was applied", async ({ dash, world }) => {
  expect(parseYaml(await fileOnScreen(dash))).toEqual(parseYaml(theFile(world)))
})

Then("the clipboard holds the file on screen", async ({ dash }) => {
  const shown = await fileOnScreen(dash)
  await expect
    .poll(async () => (await dash.page.evaluate(() => navigator.clipboard.readText())).trim())
    .toBe(shown.trim())
})

When("they download the file", async ({ dash }) => {
  await dash.idle()
  const download = dash.page.waitForEvent("download")
  await dash.button(`Download ${FILE}`).click()
  dash.download = await download
})

Then(
  "a file named {string} is saved, holding the file on screen",
  async ({ dash }, name: string) => {
    expect(dash.download?.suggestedFilename()).toBe(name)
    const saved = await readFile((await dash.download?.path()) ?? "", "utf8")
    expect(saved.trim()).toBe((await fileOnScreen(dash)).trim())
  },
)

Then(
  "the instructions name this server as the one to apply the file to",
  async ({ dash, world }) => {
    await expect(
      dash.page.getByRole("main").getByText(`export MOCKINGBIRD_FLEET_URL=${world.url}`),
    ).toBeVisible()
  },
)

Then(
  "the example on screen declares a fleet of {string} served by this server",
  async ({ dash, world }, org: string) => {
    const { slug } = world.thing<{ slug: string }>(org)
    await expect(
      dash.page.getByRole("main").getByText(`served at ${world.url}/f/${slug}-staging`),
    ).toBeVisible()
  },
)

/** "Nov 10, 2026, 9:30 AM by ada@example.test": when, then who. */
const lastApplied = (by: string) =>
  new RegExp(`^[A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{1,2}:\\d{2}\\s[AP]M by ${by}$`)

Then("the configuration was last applied by {word}", async ({ dash, world }, person: string) => {
  await expect(dash.setting("Last applied").getByRole("definition").first()).toHaveText(
    lastApplied(world.email(person).replace(/[.]/g, "\\.")),
  )
})

Then("the configuration was last applied by the key {string}", async ({ dash }, key: string) => {
  await expect(dash.setting("Last applied").getByRole("definition").first()).toHaveText(
    lastApplied(`API key ${key}`),
  )
})

Then("no time of applying is shown", async ({ dash }) => {
  await expect(dash.setting("Controlled by")).toBeVisible()
  await expect(dash.setting("Last applied")).toHaveCount(0)
})

// ---- what a managed organization's screens say ---------------------------------------------

const notice = (dash: Dashboard) =>
  dash.page
    .getByRole("main")
    .getByRole("paragraph")
    .filter({ hasText: `Configured by ${FILE}.` })

Then(
  "the screen says it is configured by mockingbird.yaml, last applied by {word}",
  async ({ dash, world }, person: string) => {
    await expect(notice(dash)).toHaveCount(1)
    await expect(notice(dash)).toContainText(`by ${world.email(person)}.`)
    await expect(
      notice(dash).getByRole("link", { name: "How to change it", exact: true }),
    ).toBeVisible()
  },
)

Then("the screen says {string} beside that", async ({ dash }, text: string) => {
  await expect(notice(dash)).toContainText(text)
})

Then("the screen does not say it is configured by mockingbird.yaml", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(notice(dash)).toHaveCount(0)
})

Then("they are told it is configured by mockingbird.yaml", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", {
      level: 1,
      name: `This is configured by ${FILE}`,
      exact: true,
    }),
  ).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: "managed" })
  await expect(dash.page.locator("form")).toHaveCount(0)
})

// ---- which way the dashboard points --------------------------------------------------------

/** The one link drawn as the screen's main action, if any. */
Then("the main action offered is {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.page.getByRole("main").locator("a.button.primary")).toHaveText([name])
})

Then("the form recommends mockingbird.yaml for {string}", async ({ dash }, what: string) => {
  await expect(dash.form).toBeVisible()
  const prompt = dash.page
    .getByRole("main")
    .getByRole("paragraph")
    .filter({ hasText: `Prefer ${FILE}:` })
  await expect(prompt).toContainText(`declare ${what} in the file and apply it`)
  await expect(prompt.getByRole("link", { name: `Use ${FILE} instead`, exact: true })).toBeVisible()
})
