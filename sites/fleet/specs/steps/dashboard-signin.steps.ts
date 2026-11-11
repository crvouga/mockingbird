/** Signing in to the dashboard in a browser: locally, with a token, and through a real provider. */
import { expect } from "@playwright/test"
import type { Dashboard } from "../support/dashboard.js"
import { startOidcProvider } from "../support/hosting.js"
import { startStack } from "../support/stack.js"
import { keyOf } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const CLIENT_ID = "fleet-dashboard"
type Provider = Awaited<ReturnType<typeof startOidcProvider>>
const providers = new WeakMap<World, Provider>()

Then("they are asked to sign in", async ({ dash }) => {
  await expect(
    dash.page.getByRole("heading", {
      level: 1,
      name: "Sign in to Mockingbird Fleet",
      exact: true,
    }),
  ).toBeVisible()
  await expect(ways(dash)).toBeVisible()
  await expect(dash.page.getByRole("link", { name: "Sign out", exact: true })).toHaveCount(0)
})

const ways = (dash: Dashboard) =>
  dash.page.getByRole("navigation", { name: "Ways to sign in", exact: true })
/** A way to sign in on the chooser, by its title ("Sign in locally"). */
const way = (dash: Dashboard, title: string) =>
  ways(dash).getByRole("link").filter({ hasText: title })

Then("they are offered to {string}", async ({ dash }, title: string) => {
  await expect(way(dash, title)).toBeVisible()
})

Then("they are offered the ways to sign in {string}", async ({ dash }, titles: string) => {
  await expect(ways(dash).getByRole("link")).toHaveCount(titles.split(", ").length)
  for (const title of titles.split(", ")) await expect(way(dash, title)).toBeVisible()
})

When("they choose to {string}", async ({ dash }, title: string) => {
  await dash.idle()
  await way(dash, title).click()
  await dash.idle()
})

/** Be on the screen of one way to sign in, going there from the chooser when not on it yet. */
async function onScreen(dash: Dashboard, title: string) {
  await dash.idle()
  const heading = dash.page.getByRole("heading", { level: 1, name: title, exact: true })
  if (await heading.isVisible()) return
  await way(dash, title).click()
  await expect(heading).toBeVisible()
}

When("they sign in locally as {word}", async ({ dash, world }, person: string) => {
  await onScreen(dash, "Sign in locally")
  await dash.field("Email").fill(world.email(person))
  await dash.button("Sign in").click()
  await dash.idle()
})

const withToken = async (dash: Dashboard, token: string) => {
  await onScreen(dash, "Sign in with a token")
  await dash.field("Personal token").fill(token)
  const answered = dash.page.waitForResponse((response) =>
    response.url().endsWith("/auth/token-login"),
  )
  await dash.button("Sign in").click()
  await answered
  await dash.idle()
}

When("they sign in with the personal token {string}", async ({ dash, world }, name: string) => {
  const credential = keyOf(world, name)
  await withToken(dash, credential.kind === "key" ? credential.key : "")
})

When("they sign in with the made-up token {string}", async ({ dash }, token: string) => {
  await withToken(dash, token)
})

// ---- single sign-on ------------------------------------------------------------------------

Given(
  "a dashboard that signs people in through an OpenID Connect provider",
  async ({ world, ownStacks, dash }) => {
    const provider = await startOidcProvider()
    dash.cleanups.push(provider.stop)
    const stack = await startStack({ OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: CLIENT_ID })
    ownStacks.push(stack)
    world.stack = stack
    await provider.registerClient(CLIENT_ID, [`${stack.url}/auth/callback`])
    providers.set(world, provider)
  },
)

const provider = (world: World) => {
  const found = providers.get(world)
  if (!found) throw new Error("This scenario has no identity provider")
  return found
}

Given("the provider has an account for {word}", async ({ world }, person: string) => {
  await provider(world).seedAccount({
    id: person.toLowerCase(),
    email: world.email(person),
    name: person,
  })
})

When(
  "they choose the account of {word} at the provider and allow access",
  async ({ dash, world }, person: string) => {
    // These are the provider's pages, not the dashboard's; it marks its controls for tests.
    await dash.page.waitForURL(`${provider(world).issuer}/**`)
    await dash.page.getByTestId(`oauth-mock-account-${person.toLowerCase()}`).click()
    await dash.page.getByTestId("oauth-mock-allow").click()
    await dash.page.waitForURL(`${world.url}/**`)
  },
)

When("they cancel at the provider", async ({ dash, world }) => {
  await dash.page.waitForURL(`${provider(world).issuer}/**`)
  await dash.page.getByTestId("oauth-mock-deny").first().click()
  await dash.page.waitForURL(`${world.url}/**`)
})

// ---- a server that cannot be asked ---------------------------------------------------------

When("the server stops", async ({ world }) => {
  await world.stack.server.stop("SIGTERM")
})

When("the server starts again", async ({ world }) => {
  await world.stack.restart()
})

When("they reload the page until the server refuses", async ({ dash }) => {
  const refused = dash.page.getByRole("heading", { name: "Mockingbird Fleet is not responding" })
  await expect(async () => {
    await dash.page.reload()
    await expect(refused).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 30_000 })
})
