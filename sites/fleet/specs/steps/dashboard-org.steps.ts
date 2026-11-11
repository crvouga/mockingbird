/** An organization's tabs in the browser: its list, members, invites, usage, keys, audit log. */
import { expect } from "@playwright/test"
import type { Dashboard } from "../support/dashboard.js"
import { idOf, keyOf } from "../support/tenancy.js"
import type { World } from "../support/world.js"
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

When(
  "they type the slug of {string} into the confirmation",
  async ({ dash, world }, org: string) => {
    const { slug } = world.thing<{ slug: string }>(org)
    await dash.idle()
    await dash.field(`Type ${slug} to confirm`).fill(slug)
  },
)

When("they type {string} into the confirmation", async ({ dash }, text: string) => {
  await dash.idle()
  await dash.page.getByLabel(/^Type .* to confirm$/).fill(text)
})

Then("the confirmation says {string}", async ({ dash }, text: string) => {
  const control = dash.page.getByLabel(/^Type .* to confirm$/)
  await expect(control).toHaveAttribute("aria-invalid", "true")
  await expect(control).toHaveAccessibleDescription(new RegExp(text.replace(/[.]/g, "\\.")))
})

// ---- members -------------------------------------------------------------------------------

const member = (dash: Dashboard, email: string) => dash.row("Members", email)

Then(
  "the member {word} is listed as {string}",
  async ({ dash, world }, person: string, text: string) => {
    await expect(member(dash, world.email(person))).toContainText(text)
  },
)

Then("the role of {word} is {string}", async ({ dash, world }, person: string, role: string) => {
  await expect(member(dash, world.email(person)).getByText(role, { exact: true })).toBeVisible()
})

Then(
  "the member {word} is noted {string}",
  async ({ dash, world }, person: string, note: string) => {
    await expect(member(dash, world.email(person)).getByRole("status")).toHaveText(note)
  },
)

When(
  "they follow {string} beside {word}",
  async ({ dash, world }, link: string, person: string) => {
    await dash.idle()
    await member(dash, world.email(person)).getByText(link, { exact: true }).click()
    await dash.idle()
  },
)

Then("they see the form to change the role of {word}", async ({ dash, world }, person: string) => {
  await expect(
    dash.page.getByRole("heading", {
      level: 1,
      name: `Change the role of ${world.email(person)}`,
      exact: true,
    }),
  ).toBeVisible()
})

Then(
  "they see the form to remove {word} from {string}",
  async ({ dash, world }, person: string, org: string) => {
    await expect(
      dash.page.getByRole("heading", {
        level: 1,
        name: `Remove ${world.email(person)} from ${org}`,
        exact: true,
      }),
    ).toBeVisible()
  },
)

Then("{word} is no longer listed as a member", async ({ dash, world }, person: string) => {
  await expect(dash.page.getByRole("list", { name: "Members", exact: true })).toBeVisible()
  await expect(member(dash, world.email(person))).toHaveCount(0)
})

Then("nobody's role can be changed", async ({ dash }) => {
  const list = dash.page.getByRole("list", { name: "Members", exact: true })
  await expect(list).toBeVisible()
  await expect(list.getByText("Change role", { exact: true })).toHaveCount(0)
})

Then("the only link among the members is {string}", async ({ dash }, name: string) => {
  const list = dash.page.getByRole("list", { name: "Members", exact: true })
  await expect(list.getByRole("link")).toHaveText([name])
  await expect(list.getByRole("button")).toHaveCount(0)
})

Then("the role of {word} can be changed", async ({ dash, world }, person: string) => {
  await expect(
    member(dash, world.email(person)).getByText("Change role", { exact: true }),
  ).toBeVisible()
})

Then("the role of {word} cannot be changed", async ({ dash, world }, person: string) => {
  const row = member(dash, world.email(person))
  await expect(row).toBeVisible()
  await expect(row.getByText("Change role", { exact: true })).toHaveCount(0)
})

Then("{word} can be removed", async ({ dash, world }, person: string) => {
  await expect(member(dash, world.email(person)).getByText("Remove", { exact: true })).toBeVisible()
})

Then("{word} cannot be removed", async ({ dash, world }, person: string) => {
  const row = member(dash, world.email(person))
  await expect(row).toBeVisible()
  await expect(row.getByText("Remove", { exact: true })).toHaveCount(0)
})

// ---- invites -------------------------------------------------------------------------------

const pending = (dash: Dashboard) =>
  dash.page.getByRole("list", { name: "Pending invites", exact: true })

/** From the Members tab: open the invite form, fill it in and create the link. */
async function invite(dash: Dashboard, world: World, person: string, role: string) {
  await dash.idle()
  await dash.page.getByRole("link", { name: "Invite someone", exact: true }).click()
  await dash.idle()
  await dash.field("Email").fill(world.email(person))
  await dash.choice("Role", role).check()
  await dash.button("Create invite link").click()
  await dash.idle()
}

When("they invite {word} as a {string}", async ({ dash, world }, person: string, role: string) => {
  await invite(dash, world, person, role)
  await expect(dash.secret).toBeVisible()
})

Then("an invite link is shown", async ({ dash, world }) => {
  await expect(dash.secret).toBeVisible()
  expect(await dash.revealed()).toMatch(
    new RegExp(`^${world.url.replace(/[.]/g, "\\.")}/invite/[\\w-]{16,}$`),
  )
  await expect(dash.page.getByText("It will not be shown again.")).toBeVisible()
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
  await expect(dash.page.getByText("No invite is waiting to be accepted.")).toBeVisible()
})

When(
  "{word} opens the invite link in a browser of his own and signs in locally",
  async ({ dash, world }, person: string) => {
    const link = await dash.revealed()
    await dash.visitor(person)
    await dash.goto(new URL(link).pathname)
    await expect(dash.page.getByText("Sign in to continue to the invite you opened.")).toBeVisible()
    await dash.page
      .getByRole("navigation", { name: "Ways to sign in", exact: true })
      .getByRole("link")
      .filter({ hasText: "Sign in locally" })
      .click()
    await dash.idle()
    await dash.field("Email").fill(world.email(person))
    await dash.button("Sign in").click()
    await dash.idle()
  },
)

When("they open the invite link for {word}", async ({ dash, world }, person: string) => {
  const { token } = world.thing<{ token: string }>(`the invite for ${person}`)
  await dash.goto(`/invite/${token}`)
})

When(
  "they follow {string} beside the invite for {word}",
  async ({ dash, world }, link: string, person: string) => {
    await dash.idle()
    await dash.row("Pending invites", world.email(person)).getByText(link, { exact: true }).click()
    await dash.idle()
  },
)

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

Then("the key {string} no longer works", async ({ world }, name: string) => {
  await expect
    .poll(async () => (await world.api(keyOf(world, name), "GET", "/me")).status)
    .toBe(401)
})

Then("the key {string} still works", async ({ world }, name: string) => {
  expect((await world.api(keyOf(world, name), "GET", "/me")).status).toBe(200)
})

Then(
  "the secret on screen can read the organization {string} through the API",
  async ({ dash, world }, org: string) => {
    await expect(dash.secret).toBeVisible()
    const key = await dash.revealed()
    const reply = await world.api({ kind: "key", key }, "GET", `/orgs/${idOf(world, org)}`)
    expect(reply.status, reply.text).toBe(200)
    expect((reply.body as { name: string }).name).toBe(org)
  },
)

When("someone uses the secret on screen to sign in from another browser", async ({ dash }) => {
  await expect(dash.secret).toBeVisible()
  const token = await dash.revealed()
  await dash.visitor("another browser")
  await dash.goto("/")
  await dash.page
    .getByRole("navigation", { name: "Ways to sign in", exact: true })
    .getByRole("link")
    .filter({ hasText: "Sign in with a token" })
    .click()
  await dash.idle()
  await dash.field("Personal token").fill(token)
  await dash.button("Sign in").click()
  await dash.idle()
})

Then("the details of the key {string} are shown in full", async ({ dash }, name: string) => {
  const details = dash.row("API keys", name).getByText("Last used")
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

Then("the token {string} says {string}", async ({ dash }, name: string, text: string) => {
  await expect(dash.row("Personal tokens", name)).toContainText(text)
})

Then(
  "the secret of the key/token {string} is not on the page",
  async ({ dash, world }, name: string) => {
    const credential = keyOf(world, name)
    const secret = credential.kind === "key" ? credential.key : ""
    expect(secret.length).toBeGreaterThan(20)
    await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
    expect(await dash.page.content()).not.toContain(secret)
    // What is shown instead is the start of it, to recognise it by.
    const prefix = world.thing<{ prefix: string }>(name).prefix
    await expect(dash.page.getByText(`${prefix}…`, { exact: true })).toBeVisible()
  },
)

Given(
  "the key {string} has created a project {string} in {string}",
  async ({ world }, key: string, name: string, org: string) => {
    world.things.set(
      name,
      await world.must(keyOf(world, key), "POST", `/orgs/${idOf(world, org)}/projects`, { name }),
    )
  },
)

Then(
  "the audit log shows {string} by the key {string}",
  async ({ dash }, action: string, key: string) => {
    await expect(
      dash
        .row("Audit log", action)
        .filter({ hasText: `${key} on ` })
        .first(),
    ).toBeVisible()
  },
)

Then("the project {string} is not listed", async ({ dash }, name: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(
    dash.page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("link")
      .filter({ hasText: name }),
  ).toHaveCount(0)
})

Then(
  "they see the page for revoking the invite for {word}",
  async ({ dash, world }, person: string) => {
    await expect(
      dash.page.getByRole("heading", {
        level: 1,
        name: `Revoke the invite for ${world.email(person)}`,
        exact: true,
      }),
    ).toBeVisible()
  },
)
