/**
 * Steps for the dashboard in a real browser: getting to a screen, acting on it and reading it,
 * the way a person does. "They" is whoever's browser was mentioned last. Steps about one area of
 * the dashboard live in `dashboard-<area>.steps.ts`.
 *
 * The dashboard's screens are queries (text and links) or mutations (one form, one submit button
 * and a Cancel link). A change is made by following a link from a query to the mutation's own
 * screen, filling its form and pressing its button; the dashboard then lands on the screen the
 * result lives on, with a note beside the thing that changed. Problems are written in the form:
 * under the field they are about, or in the form's summary.
 */
import { expect } from "@playwright/test"
import { literal, PHONE, TAB_PATHS } from "../support/dashboard.js"
import { idOf, userId } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const tabPath = (world: World, tab: string, org: string) => {
  const path = TAB_PATHS[tab]
  if (path === undefined) throw new Error(`An organization has no "${tab}" tab`)
  return `/orgs/${idOf(world, org)}${path}`
}

/** Where a kind of thing lives: `/orgs/<id>`, `/projects/<id>`, `/fleets/<id>`. */
const COLLECTIONS: Record<string, string> = {
  organization: "orgs",
  project: "projects",
  fleet: "fleets",
}
const addressOf = (world: World, kind: string, name: string) => {
  const collection = COLLECTIONS[kind]
  if (!collection) throw new Error(`The dashboard has no address for a ${kind}`)
  return `/${collection}/${idOf(world, name)}`
}

// ---- who is at the browser -----------------------------------------------------------------

Given("{word} is signed in to the dashboard", async ({ dash }, person: string) => {
  await dash.signedIn(person)
})

Given("{word} is signed in to the dashboard on a phone", async ({ dash }, person: string) => {
  await dash.signedIn(person, PHONE)
})

Given("a visitor who is not signed in", async ({ dash }) => {
  await dash.visitor()
})

Given("a visitor on a phone who is not signed in", async ({ dash }) => {
  await dash.visitor("visitor", PHONE)
})

When("{word} returns to her/his own browser", async ({ dash }, person: string) => {
  dash.switchTo(person)
})

// ---- getting to a screen -------------------------------------------------------------------

When("they open the dashboard", async ({ dash }) => {
  await dash.goto("/")
})

When("they open the dashboard at {string}", async ({ dash }, path: string) => {
  await dash.goto(path)
})

When(
  "they open the address of the {word} {string} followed by {string}",
  async ({ dash, world }, kind: string, name: string, rest: string) => {
    await dash.goto(`${addressOf(world, kind, name)}${rest}`)
  },
)

When(
  "they open the address of the member {word} of {string} followed by {string}",
  async ({ dash, world }, person: string, org: string, rest: string) => {
    await dash.goto(`/orgs/${idOf(world, org)}/members/${await userId(world, person)}${rest}`)
  },
)

When("they open the organization {string}", async ({ dash, world }, org: string) => {
  await dash.goto(`/orgs/${idOf(world, org)}`)
})

When(
  "they open the {string} tab of {string}",
  async ({ dash, world }, tab: string, org: string) => {
    await dash.goto(tabPath(world, tab, org))
  },
)

When("they open the project {string}", async ({ dash, world }, project: string) => {
  await dash.goto(`/projects/${idOf(world, project)}`)
})

When("they open the fleet {string}", async ({ dash, world }, fleet: string) => {
  await dash.goto(`/fleets/${idOf(world, fleet)}`)
})

When("they reload the page", async ({ dash }) => {
  await dash.page.reload()
  await dash.settled()
})

When("they go back", async ({ dash }) => {
  await dash.idle()
  await dash.page.goBack()
  await dash.idle()
})

When("they go forward", async ({ dash }) => {
  await dash.idle()
  await dash.page.goForward()
  await dash.idle()
})

When("they follow {string}", async ({ dash }, name: string) => {
  await dash.idle()
  await dash.page.getByRole("link", { name, exact: true }).first().click()
  await dash.idle()
})

When("they cancel", async ({ dash }) => {
  await dash.idle()
  await dash.form.getByRole("link", { name: "Cancel", exact: true }).click()
  await dash.idle()
})

for (const [kind, list] of [
  ["organization", "Organizations"],
  ["project", "Projects"],
  ["fleet", "Fleets"],
] as const) {
  When(`they follow the ${kind} {string}`, async ({ dash }, name: string) => {
    await dash.idle()
    await dash.page
      .getByRole("navigation", { name: list, exact: true })
      .getByRole("link")
      .filter({ hasText: name })
      .click()
    await dash.idle()
  })
}

// ---- acting --------------------------------------------------------------------------------

When("they press {string}", async ({ dash }, name: string) => {
  await dash.idle()
  await dash.button(name).first().click()
  await dash.idle()
})

When("they type {string} into {string}", async ({ dash }, value: string, label: string) => {
  await dash.idle()
  await dash.field(label).fill(value)
})

When(
  "they type the email of {word} into {string}",
  async ({ dash, world }, person: string, label: string) => {
    await dash.idle()
    await dash.field(label).fill(world.email(person))
  },
)

When("they clear {string}", async ({ dash }, label: string) => {
  await dash.idle()
  await dash.field(label).fill("")
})

When("they choose {string} as the {string}", async ({ dash }, option: string, label: string) => {
  await dash.idle()
  const select = dash.field(label)
  if ((await select.count()) > 0) await select.selectOption({ label: option })
  else await dash.choice(label, option).check()
})

// ---- reading -------------------------------------------------------------------------------

Then("they see the page {string}", async ({ dash }, title: string) => {
  await expect(dash.page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
})

Then("they see {string}", async ({ dash }, text: string) => {
  await expect(dash.page.getByText(text).first()).toBeVisible()
})

Then("they do not see {string}", async ({ dash }, text: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.page.getByText(text)).toHaveCount(0)
})

Then("they see the email of {word}", async ({ dash, world }, person: string) => {
  await expect(dash.page.getByText(world.email(person)).first()).toBeVisible()
})

Then("there is a button {string}", async ({ dash }, name: string) => {
  await expect(dash.button(name).first()).toBeVisible()
})

Then("there is a link {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("link", { name, exact: true }).first()).toBeVisible()
})

Then("there is no link {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.page.getByRole("link", { name, exact: true })).toHaveCount(0)
})

// ---- what a change says, where it happened -------------------------------------------------

Then("the field {string} says {string}", async ({ dash }, label: string, text: string) => {
  const control = await dash.control(label)
  await expect(control).toHaveAttribute("aria-invalid", "true")
  await expect(control).toHaveAccessibleDescription(new RegExp(literal(text)))
  // The message is written under the field itself, not only announced.
  // A text field's holder contains it; a set of choices is its own holder.
  const holder =
    (await dash.field(label).count()) > 0
      ? dash.form.locator("[data-field]").filter({ has: control })
      : dash.choices(label)
  await expect(holder.locator(".field-error")).toContainText(text)
})

Then("the form says {string}", async ({ dash }, text: string) => {
  await expect(dash.formError).toBeVisible()
  await expect(dash.formError).toContainText(text)
})

Then("no field is marked wrong", async ({ dash }) => {
  await expect(dash.form).toBeVisible()
  await expect(dash.form.locator("[aria-invalid=true]")).toHaveCount(0)
})

Then("exactly {int} problem(s) is/are pointed out", async ({ dash }, count: number) => {
  await expect(dash.problems).toHaveCount(count)
})

Then("no problem is pointed out", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.problems).toHaveCount(0)
  await expect(dash.page.getByRole("alert")).toHaveCount(0)
})

Then("they see the note {string}", async ({ dash }, text: string) => {
  await expect(
    dash.page.getByRole("main").getByRole("status").filter({ hasText: text }),
  ).toBeVisible()
})

Then("no note is shown", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.page.getByRole("status")).toHaveCount(0)
})

Then("the setting {string} reads {string}", async ({ dash }, setting: string, value: string) => {
  await expect(dash.setting(setting).getByRole("definition").first()).toContainText(value)
})

Then(
  "the setting {string} reads the email of {word}",
  async ({ dash, world }, setting: string, person: string) => {
    await expect(dash.setting(setting).getByRole("definition").first()).toHaveText(
      world.email(person),
    )
  },
)

for (const what of ["slug", "id"] as const)
  Then(
    `the setting {string} reads the ${what} of {string}`,
    async ({ dash, world }, setting: string, name: string) => {
      const value = world.thing<Record<string, string>>(name)[what] ?? ""
      await expect(dash.setting(setting).getByRole("definition").first()).toContainText(value)
    },
  )

Then("the setting {string} is noted {string}", async ({ dash }, setting: string, note: string) => {
  await expect(dash.setting(setting).getByRole("status")).toHaveText(note)
})

Then("the field {string} holds {string}", async ({ dash }, label: string, value: string) => {
  await expect(dash.field(label)).toHaveValue(value)
})

Then("{string} is chosen for {string}", async ({ dash }, option: string, label: string) => {
  await expect(dash.choice(label, option)).toBeChecked()
})

Then("the choices for {string} are {string}", async ({ dash }, label: string, names: string) => {
  const radios = dash.choices(label).getByRole("radio")
  const expected = names.split(", ")
  await expect(radios).toHaveCount(expected.length)
  for (const [index, name] of expected.entries())
    await expect(radios.nth(index)).toHaveAccessibleName(new RegExp(`^${literal(name)}`))
})

// ---- the screen as a whole -----------------------------------------------------------------

Then("they are told they have no access", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", { level: 1, name: "You do not have access", exact: true }),
  ).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: "forbidden" })
  await expect(dash.page.locator("form")).toHaveCount(0)
})

Then("they are told the page does not exist", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", { level: 1, name: "Page not found", exact: true }),
  ).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: "not-found" })
})

Then("they are told it was not found", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", { level: 1, name: "Not found", exact: true }),
  ).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: "not-found" })
  await expect(dash.page.locator("form")).toHaveCount(0)
})

Then("the breadcrumb reads {string}", async ({ dash }, trail: string) => {
  const crumbs = dash.page.getByRole("navigation", { name: "Breadcrumb", exact: true })
  // The trail reads as its items separated by slashes: "Organizations / Acme / Web app".
  await expect
    .poll(async () => (await crumbs.innerText()).split("/").map((item) => item.trim()))
    .toEqual(trail.split(", "))
})

Then("the screen is the {string} form", async ({ dash }, route: string) => {
  await expect(dash.form).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "mutation", route })
})

// ---- where they are ------------------------------------------------------------------------

const addressIs = (dash: { page: { url(): string } }, path: string) =>
  expect.poll(() => new URL(dash.page.url()).pathname).toBe(path)

Then("the address is {string}", async ({ dash }, path: string) => {
  await addressIs(dash, path)
})

Then("the address is that of the organization {string}", async ({ dash, world }, org: string) => {
  await addressIs(dash, `/orgs/${idOf(world, org)}`)
})

Then("the address is that of the project {string}", async ({ dash, world }, project: string) => {
  await addressIs(dash, `/projects/${idOf(world, project)}`)
})

Then("the address is that of the fleet {string}", async ({ dash, world }, fleet: string) => {
  await addressIs(dash, `/fleets/${idOf(world, fleet)}`)
})

Then(
  "the address is that of the {string} tab of {string}",
  async ({ dash, world }, tab: string, org: string) => {
    await addressIs(dash, tabPath(world, tab, org))
  },
)

const tabs = (dash: { page: import("@playwright/test").Page }) =>
  dash.page.getByRole("navigation", { name: "Organization", exact: true }).getByRole("link")

Then("the {string} tab is the current one", async ({ dash }, tab: string) => {
  await expect(tabs(dash).filter({ hasText: tab })).toHaveAttribute("aria-current", "page")
})

Then("the organization's tabs are {string}", async ({ dash }, names: string) => {
  await expect(tabs(dash)).toHaveText(names.split(", "))
})

Then("the page was loaded only once", async ({ dash }) => {
  expect(dash.requests.filter((request) => request.type === "document")).toHaveLength(1)
})

// ---- secrets shown once --------------------------------------------------------------------

Then("a secret starting with {string} is shown", async ({ dash }, prefix: string) => {
  await expect(dash.secret).toBeVisible()
  expect(await dash.revealed()).toMatch(new RegExp(`^${prefix}\\S{20,}$`))
  await expect(dash.page.getByText("It will not be shown again.")).toBeVisible()
})

Then("they are told the secret was shown once", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", { level: 1, name: "This was shown once", exact: true }),
  ).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: "gone" })
  await expect(dash.secret).toHaveCount(0)
})

Then("no secret is shown", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.secret).toHaveCount(0)
  await expect(dash.page.getByText("It will not be shown again.")).toHaveCount(0)
})

// ---- small screens -------------------------------------------------------------------------

Then("nothing reaches past the edge of the screen", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  const { content, window } = await dash.overflow()
  expect(window).toBe(PHONE.width)
  expect(content, "the page scrolls sideways").toBeLessThanOrEqual(window)
})
