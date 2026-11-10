/** Signing in to the dashboard in a browser: locally, with a token, and through a real provider. */
import { expect } from "@playwright/test"
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
    dash.page.getByRole("heading", { level: 1, name: "Mockingbird Fleet", exact: true }),
  ).toBeVisible()
  await expect(dash.button("Sign in with a token")).toBeVisible()
  await expect(dash.button("Sign out")).toHaveCount(0)
})

When("they sign in locally as {word}", async ({ dash, world }, person: string) => {
  await dash.idle()
  await dash.field("Email").fill(world.email(person))
  await dash.button("Sign in locally").click()
})

const withToken = async (dash: import("../support/dashboard.js").Dashboard, token: string) => {
  await dash.idle()
  await dash.field("Personal token").fill(token)
  const answered = dash.page.waitForResponse((response) =>
    response.url().endsWith("/auth/token-login"),
  )
  await dash.button("Sign in with a token").click()
  await answered
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
