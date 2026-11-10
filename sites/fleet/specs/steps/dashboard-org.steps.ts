/** An organization's tabs in the browser: its list, members, invites, usage, keys, audit log. */
import { expect, type Locator } from "@playwright/test"
import type { Dashboard } from "../support/dashboard.js"
import { idOf, keyOf } from "../support/tenancy.js"
import { Given, Then, When } from "./common.steps.js"

// ---- the list of organizations -------------------------------------------------------------

Then(
  "the organization {string} is listed with the role {string}",
  async ({ dash }, name: string, role: string) => {
    const row = dash.page
      .getByRole("navigation", { name: "Organizations", exact: true })
      .getByRole("link")
      .filter({ hasText: name })
    await expect(row.getByText(role, { exact: true })).toBeVisible()
  },
)

Given(
  "the operator has suspended {string} for {string}",
  async ({ world }, org: string, reason: string) => {
    await world.must("operator", "PATCH", `/admin/orgs/${idOf(world, org)}`, { suspended: reason })
  },
)

// ---- members -------------------------------------------------------------------------------

const member = (dash: Dashboard, email: string) => dash.row("Members", email)

/** A member's role as the row shows it: the chosen option where it can be changed, else a tag. */
async function expectRole(row: Locator, role: string) {
  await expect(row).toBeVisible()
  const select = row.getByRole("combobox")
  if ((await select.count()) > 0) await expect(select).toHaveValue(role)
  else await expect(row.getByText(role, { exact: true })).toBeVisible()
}

Then(
  "the member {word} is listed as {string}",
  async ({ dash, world }, person: string, text: string) => {
    await expect(member(dash, world.email(person))).toContainText(text)
  },
)

Then("the role of {word} is {string}", async ({ dash, world }, person: string, role: string) => {
  await expect(async () => expectRole(member(dash, world.email(person)), role)).toPass()
})

When(
  "they change the role of {word} to {string}",
  async ({ dash, world }, person: string, role: string) => {
    await dash.idle()
    await dash.field(`Role of ${world.email(person)}`).selectOption(role)
  },
)

for (const [answer, accept] of [
  ["confirm", true],
  ["decline", false],
] as const)
  When(`they remove the member {word} and ${answer}`, async ({ dash, world }, person: string) => {
    await dash.idle()
    dash.answerNext(accept)
    await dash.button("Remove", member(dash, world.email(person))).click()
  })

Then("they were asked to remove {word}", async ({ dash, world }, person: string) => {
  await expect.poll(() => dash.questions).toContain(`Remove ${world.email(person)}?`)
})

Then("{word} is no longer listed as a member", async ({ dash, world }, person: string) => {
  await expect(member(dash, world.email(person))).toHaveCount(0)
})

Then("nobody's role can be changed", async ({ dash }) => {
  const list = dash.page.getByRole("list", { name: "Members", exact: true })
  await expect(list).toBeVisible()
  await expect(list.getByRole("combobox")).toHaveCount(0)
})

Then("the only button among the members is {string}", async ({ dash }, name: string) => {
  const list = dash.page.getByRole("list", { name: "Members", exact: true })
  await expect(list.getByRole("button")).toHaveText([name])
})

Then(
  "the role of {word} can be changed to {string}",
  async ({ dash, world }, person: string, roles: string) => {
    const select = dash.field(`Role of ${world.email(person)}`)
    await expect(select).toBeEnabled()
    await expect(select.getByRole("option")).toHaveText(roles.split(", "))
  },
)

Then("the role of {word} cannot be changed", async ({ dash, world }, person: string) => {
  const row = member(dash, world.email(person))
  await expect(row).toBeVisible()
  await expect(row.getByRole("combobox")).toHaveCount(0)
})

Then("{word} can be removed", async ({ dash, world }, person: string) => {
  await expect(dash.button("Remove", member(dash, world.email(person)))).toBeVisible()
})

Then("{word} cannot be removed", async ({ dash, world }, person: string) => {
  const row = member(dash, world.email(person))
  await expect(row).toBeVisible()
  await expect(row.getByRole("button")).toHaveCount(0)
})

// ---- invites -------------------------------------------------------------------------------

const pending = (dash: Dashboard) =>
  dash.page.getByRole("list", { name: "Pending invites", exact: true })

When("they invite {word} as a {string}", async ({ dash, world }, person: string, role: string) => {
  await dash.idle()
  await dash.field("Email").fill(world.email(person))
  await dash.field("Role").selectOption(role)
  await dash.button("Create invite link").click()
  await expect(dash.secretNotice).toBeVisible()
})

Then("an invite link is shown", async ({ dash, world }) => {
  expect(await dash.revealed()).toMatch(
    new RegExp(`^${world.url.replace(/[.]/g, "\\.")}/invite/[\\w-]{16,}$`),
  )
})

Then(
  "the pending invite for {word} says {string}",
  async ({ dash, world }, person: string, text: string) => {
    await expect(dash.row("Pending invites", world.email(person))).toContainText(text)
  },
)

Then("there are no pending invites", async ({ dash }) => {
  await expect(dash.page.getByRole("list", { name: "Members", exact: true })).toBeVisible()
  await expect(pending(dash)).toHaveCount(0)
})

When(
  "{word} opens the invite link in a browser of his own and signs in locally",
  async ({ dash, world }, person: string) => {
    const link = await dash.revealed()
    await dash.visitor(person)
    await dash.goto(new URL(link).pathname)
    await dash.field("Email").fill(world.email(person))
    await dash.button("Sign in locally").click()
  },
)

When("they open the invite link for {word}", async ({ dash, world }, person: string) => {
  const { token } = world.thing<{ token: string }>(`the invite for ${person}`)
  await dash.goto(`/invite/${token}`)
})

When("they revoke the invite for {word}", async ({ dash, world }, person: string) => {
  await dash.idle()
  await dash.button("Revoke", dash.row("Pending invites", world.email(person))).click()
})

// ---- usage ---------------------------------------------------------------------------------

const limit = (dash: Dashboard, label: string) =>
  dash.page
    .getByRole("list", { name: "Limits", exact: true })
    .getByRole("listitem")
    .filter({ has: dash.page.getByText(label, { exact: true }) })

Then("the limit {string} reads {string}", async ({ dash }, label: string, text: string) => {
  await expect(limit(dash, label).getByText(text, { exact: true })).toBeVisible()
})

Then("the limit {string} is marked as reached", async ({ dash }, label: string) => {
  await expect(limit(dash, label).getByTitle("Limit reached")).toBeVisible()
})

Then("the limit {string} is not marked as reached", async ({ dash }, label: string) => {
  await expect(limit(dash, label)).toBeVisible()
  await expect(limit(dash, label).getByTitle("Limit reached")).toHaveCount(0)
})

Then("today is listed under requests per day with {string}", async ({ dash }, count: string) => {
  const today = new Date().toISOString().slice(0, 10)
  await expect(dash.row("Requests per day", today).getByText(count, { exact: true })).toBeVisible()
})

// ---- keys and tokens -----------------------------------------------------------------------

Then("the key {string} is listed as {string}", async ({ dash }, name: string, role: string) => {
  await expect(dash.row("API keys", name).getByText(role, { exact: true })).toBeVisible()
})

Then("the key {string} says {string}", async ({ dash }, name: string, text: string) => {
  await expect(dash.row("API keys", name)).toContainText(text)
})

Then("the token {string} is listed", async ({ dash }, name: string) => {
  await expect(dash.row("Personal tokens", name)).toBeVisible()
})

for (const [answer, accept] of [
  ["confirm", true],
  ["decline", false],
] as const)
  When(`they revoke the key {string} and ${answer}`, async ({ dash }, name: string) => {
    await dash.idle()
    dash.answerNext(accept)
    await dash.button("Revoke", dash.row("API keys", name)).click()
  })

When("they revoke the token {string} and confirm", async ({ dash }, name: string) => {
  await dash.idle()
  dash.answerNext(true)
  await dash.button("Revoke", dash.row("Personal tokens", name)).click()
})

Then("the key {string} no longer works", async ({ world }, name: string) => {
  await expect
    .poll(async () => (await world.api(keyOf(world, name), "GET", "/me")).status)
    .toBe(401)
})

Then(
  "the secret on screen can read the organization {string} through the API",
  async ({ dash, world }, org: string) => {
    await expect(dash.secretNotice).toBeVisible()
    const key = await dash.revealed()
    const reply = await world.api({ kind: "key", key }, "GET", `/orgs/${idOf(world, org)}`)
    expect(reply.status, reply.text).toBe(200)
    expect((reply.body as { name: string }).name).toBe(org)
  },
)

When("someone uses the secret on screen to sign in from another browser", async ({ dash }) => {
  await expect(dash.secretNotice).toBeVisible()
  const token = await dash.revealed()
  await dash.visitor("another browser")
  await dash.goto("/")
  await dash.field("Personal token").fill(token)
  await dash.button("Sign in with a token").click()
})

Then("the details of the key {string} are shown in full", async ({ dash }, name: string) => {
  const details = dash.row("API keys", name).getByText("last used")
  await expect(details).toBeVisible()
  const { content, box } = await details.evaluate((element) => ({
    content: element.scrollWidth,
    box: element.clientWidth,
  }))
  expect(content, "the details are cut off").toBeLessThanOrEqual(box)
})

// ---- audit log -----------------------------------------------------------------------------

Then(
  "the audit log shows {string} by {word}",
  async ({ dash, world }, action: string, person: string) => {
    await expect(
      dash
        .row("Audit log", action)
        .filter({ hasText: world.email(person) })
        .first(),
    ).toBeVisible()
  },
)

Then("the first audit entry is {string}", async ({ dash }, action: string) => {
  const entries = dash.page
    .getByRole("list", { name: "Audit log", exact: true })
    .getByRole("listitem")
  await expect(entries.first()).toContainText(action)
})
