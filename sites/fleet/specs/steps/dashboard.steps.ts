/**
 * Steps for the dashboard in a real browser: getting to a screen, acting on it and reading it,
 * the way a person does. "They" is whoever's browser was mentioned last. Steps about one area of
 * the dashboard live in `dashboard-<area>.steps.ts`.
 */
import { expect } from "@playwright/test"
import { PHONE, TAB_PATHS } from "../support/dashboard.js"
import { idOf } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const tabPath = (world: World, tab: string, org: string) => {
  const path = TAB_PATHS[tab]
  if (path === undefined) throw new Error(`An organization has no "${tab}" tab`)
  return `/orgs/${idOf(world, org)}${path}`
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
  "they open the dashboard at the organization {string} followed by {string}",
  async ({ dash, world }, org: string, rest: string) => {
    await dash.goto(`/orgs/${idOf(world, org)}${rest}`)
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
})

When("they go forward", async ({ dash }) => {
  await dash.idle()
  await dash.page.goForward()
})

When("they follow {string}", async ({ dash }, name: string) => {
  await dash.idle()
  await dash.page.getByRole("link", { name, exact: true }).click()
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
  })
}

// ---- acting --------------------------------------------------------------------------------

When("they press {string}", async ({ dash }, name: string) => {
  await dash.idle()
  await dash.button(name).first().click()
})

When("they press {string} and confirm", async ({ dash }, name: string) => {
  await dash.idle()
  dash.answerNext(true)
  await dash.button(name).click()
})

When("they press {string} and decline", async ({ dash }, name: string) => {
  await dash.idle()
  dash.answerNext(false)
  await dash.button(name).click()
})

When("they type {string} into {string}", async ({ dash }, value: string, label: string) => {
  await dash.idle()
  await dash.field(label).fill(value)
})

When("they put the cursor in {string}", async ({ dash }, label: string) => {
  await dash.idle()
  await dash.field(label).focus()
})

When("they choose {string} as the {string}", async ({ dash }, option: string, label: string) => {
  await dash.idle()
  await dash.field(label).selectOption({ label: option })
})

// ---- reading -------------------------------------------------------------------------------

Then("they see the page {string}", async ({ dash }, title: string) => {
  await expect(dash.page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
})

Then("they see {string}", async ({ dash }, text: string) => {
  await expect(dash.page.getByText(text).first()).toBeVisible()
})

Then("they do not see {string}", async ({ dash }, text: string) => {
  await expect(dash.page.getByText(text)).toHaveCount(0)
})

Then("they see the error {string}", async ({ dash }, text: string) => {
  await expect(dash.page.getByRole("alert").filter({ hasText: text })).toBeVisible()
})

Then("exactly {int} error(s) is/are shown", async ({ dash }, count: number) => {
  await expect(dash.page.getByRole("alert")).toHaveCount(count)
})

Then("no error is shown", async ({ dash }) => {
  await expect(dash.page.getByRole("alert")).toHaveCount(0)
})

Then("there is a button {string}", async ({ dash }, name: string) => {
  await expect(dash.button(name).first()).toBeVisible()
})

Then("there is no button {string}", async ({ dash }, name: string) => {
  await expect(dash.button(name)).toHaveCount(0)
})

Then("there is a link {string}", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("link", { name, exact: true })).toBeVisible()
})

Then("they were asked {string}", async ({ dash }, question: string) => {
  await expect.poll(() => dash.questions).toContain(question)
})

Then("they see the email of {word}", async ({ dash, world }, person: string) => {
  await expect(dash.page.getByText(world.email(person)).first()).toBeVisible()
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
  await expect(dash.page.getByRole("link", { name: tab, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
})

Then("the organization's tabs are {string}", async ({ dash }, names: string) => {
  await expect(tabs(dash)).toHaveText(names.split(", "))
})

Then("the page was loaded only once", async ({ dash }) => {
  expect(dash.requests.filter((request) => request.type === "document")).toHaveLength(1)
})

// ---- secrets shown once --------------------------------------------------------------------

Then("a secret starting with {string} is shown", async ({ dash }, prefix: string) => {
  await expect(dash.secretNotice).toBeVisible()
  expect(await dash.revealed()).toMatch(new RegExp(`^${prefix}\\S{20,}$`))
})

Then("no secret is shown", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(dash.secretNotice).toHaveCount(0)
  await expect(dash.page.getByText("it will not be shown again")).toHaveCount(0)
})

// ---- small screens -------------------------------------------------------------------------

Then("nothing reaches past the edge of the screen", async ({ dash }) => {
  const { content, window } = await dash.overflow()
  expect(window).toBe(PHONE.width)
  expect(content, "the page scrolls sideways").toBeLessThanOrEqual(window)
})
