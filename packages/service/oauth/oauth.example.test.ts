import { expect, test } from "bun:test"
import {
  APP,
  createExample,
  type ExampleProvider,
  IDENTITY,
  type Trace,
} from "./examples/google-login/app.js"
import { createBrowser } from "./examples/google-login/transport.js"
import type { BehaviorInput } from "./src/index.js"

function setup(behavior: BehaviorInput = {}, provider: ExampleProvider = "google") {
  const trace: Trace[] = []
  const example = createExample(behavior, (entry) => trace.push(entry), provider)
  const browser = createBrowser(example.dispatch)
  const post = (body: Record<string, string>) =>
    browser.navigate(`${IDENTITY}/interaction`, {
      method: "POST",
      body: new URLSearchParams(body),
      origin: IDENTITY,
    })
  const start = async () => {
    const page = await browser.navigate(`${APP}/auth/start`)
    const html = await page.response.text()
    expect(html).toContain("Choose an account")
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1]
    if (!transaction) throw new Error("Missing form transaction")
    return transaction
  }
  return { ...example, browser, post, start, trace }
}

test("portable example completes Hono → Google HTML login → verified app session with no network", async () => {
  const demo = setup()
  expect(await (await demo.browser.navigate(APP)).response.text()).toContain(
    "Continue with OAuth Mock",
  )
  const transaction = await demo.start()
  expect(
    await (await demo.post({ transaction, action: "select", account: "ada" })).response.text(),
  ).toContain("Allow &amp; continue")
  const complete = await demo.post({ transaction, action: "allow" })
  expect(complete.url).toBe(`${APP}/`)
  expect(await complete.response.text()).toContain("Welcome, Ada.")
  expect(await (await demo.browser.navigate(`${APP}/api/session`)).response.json()).toEqual({
    user: { sub: "ada", name: "Ada Lovelace", email: "ada@example.test" },
  })
  for (const endpoint of [
    "/.well-known/openid-configuration",
    "/token",
    "/oauth2/v3/certs",
    "/userinfo",
    "/auth/callback",
  ])
    expect(demo.trace.some((t) => t.url.endsWith(endpoint))).toBe(true)
  const signedOut = await demo.browser.navigate(`${APP}/auth/logout`, {
    method: "POST",
    origin: APP,
  })
  expect(await signedOut.response.text()).toContain("Continue with OAuth Mock")
  expect(await (await demo.browser.navigate(`${APP}/api/session`)).response.json()).toEqual({
    user: null,
  })
})

test("signup uses the provider HTML interaction and missing email still identifies by subject", async () => {
  const demo = setup({ preset: "missing_email" })
  const transaction = await demo.start()
  const signup = await demo.browser.navigate(
    `${IDENTITY}/interaction?transaction=${transaction}&screen=signup`,
  )
  expect(await signup.response.text()).toContain("Create your account")
  await demo.post({ transaction, action: "signup", name: "New Person", email: "new@example.test" })
  const done = await demo.post({ transaction, action: "allow" })
  expect(await done.response.text()).toContain("Email not shared")
  const { user } = await (await demo.browser.navigate(`${APP}/api/session`)).response.json()
  expect(user.name).toBe("New Person")
  expect(user.sub).toBeString()
  expect(user.email).toBeUndefined()
})

test("decline, token failures, and callback state tampering never establish an app session", async () => {
  for (const behavior of [
    {},
    { probabilities: { tokenUnavailable: 1 } },
  ] satisfies BehaviorInput[]) {
    const demo = setup(behavior)
    const transaction = await demo.start()
    await demo.post({ transaction, action: "select", account: "ada" })
    const page = await demo.post({ transaction, action: behavior.probabilities ? "allow" : "deny" })
    expect(await page.response.text()).toContain("Sign-in could not be completed")
    expect(await (await demo.browser.navigate(`${APP}/api/session`)).response.json()).toEqual({
      user: null,
    })
  }
  const demo = setup()
  const transaction = await demo.start()
  await demo.post({ transaction, action: "select", account: "ada" })
  const redirect = await demo.dispatch(
    new Request(`${IDENTITY}/interaction`, {
      method: "POST",
      body: new URLSearchParams({ transaction, action: "allow" }),
    }),
  )
  const target = new URL(redirect.headers.get("location") ?? "")
  target.searchParams.set("state", "tampered")
  expect((await demo.browser.navigate(target.href)).response.status).toBe(400)
  expect(await (await demo.browser.navigate(`${APP}/api/session`)).response.json()).toEqual({
    user: null,
  })
})

test("separate examples isolate state and external origins cannot escape the dispatcher", async () => {
  const first = setup()
  const second = setup()
  const transaction = await first.start()
  await first.post({ transaction, action: "select", account: "ada" })
  await first.post({ transaction, action: "allow" })
  expect(await (await second.browser.navigate(`${APP}/api/session`)).response.json()).toEqual({
    user: null,
  })
  await expect(first.browser.navigate("https://example.com")).rejects.toThrow("in-process origins")
})

test("account choice remains configurable after login without losing provider sessions", async () => {
  const demo = setup()
  const transaction = await demo.start()
  await demo.post({ transaction, action: "select", account: "grace" })
  await demo.post({ transaction, action: "allow" })
  const logout = () => demo.browser.navigate(`${APP}/auth/logout`, { method: "POST", origin: APP })
  await logout()
  // Default stays interactive even though the provider has a valid remembered session.
  expect((await demo.browser.navigate(`${APP}/auth/start`)).url).toStartWith(IDENTITY)
  demo.preferences.reuseLastAccount = true
  const reused = await demo.browser.navigate(`${APP}/auth/start`)
  expect(reused.url).toBe(`${APP}/`)
  expect(await reused.response.text()).toContain("Welcome, Grace.")
  await logout()
  demo.preferences.reuseLastAccount = false
  expect(await (await demo.browser.navigate(`${APP}/auth/start`)).response.text()).toContain(
    "Choose an account",
  )
})

test("the in-process app completes Apple Hide My Email form_post and Microsoft OIDC", async () => {
  const apple = setup({ preset: "apple_private_relay" }, "apple")
  const appleTransaction = await apple.start()
  await apple.post({ transaction: appleTransaction, action: "select", account: "ada" })
  const formPost = await apple.post({ transaction: appleTransaction, action: "allow" })
  const html = await formPost.response.text()
  const callback = new URLSearchParams()
  for (const match of html.matchAll(/name="([^"]+)" value="([^"]*)"/g))
    callback.set(
      match[1] ?? "",
      (match[2] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    )
  const appleDone = await apple.browser.navigate(`${APP}/auth/callback`, {
    method: "POST",
    body: callback,
    origin: IDENTITY,
  })
  expect(appleDone.url).toBe(`${APP}/`)
  expect(await appleDone.response.text()).toContain("@privaterelay.appleid.com")
  expect(
    (await (await apple.browser.navigate(`${APP}/api/session`)).response.json()).user.name,
  ).toBe("Ada Lovelace")

  const microsoft = setup({}, "microsoft")
  const microsoftTransaction = await microsoft.start()
  await microsoft.post({ transaction: microsoftTransaction, action: "select", account: "grace" })
  const microsoftDone = await microsoft.post({
    transaction: microsoftTransaction,
    action: "allow",
  })
  expect(microsoftDone.url).toBe(`${APP}/`)
  expect(await microsoftDone.response.text()).toContain("Welcome, Grace.")
})

test("the in-process GitHub OAuth profile falls back from null public email to its email list", async () => {
  const github = setup({}, "github")
  const transaction = await github.start()
  await github.post({ transaction, action: "select", account: "ada" })
  const done = await github.post({ transaction, action: "allow" })
  expect(await done.response.clone().text()).toContain("Welcome, Ada.")
  expect(done.url).toBe(`${APP}/`)
  expect(await done.response.text()).toContain("ada@example.test")
  expect(
    (await (await github.browser.navigate(`${APP}/api/session`)).response.json()).user,
  ).toEqual({
    sub: "101",
    name: "Ada Lovelace",
    email: "ada@example.test",
  })
  expect(github.trace.some((entry) => entry.url.endsWith("/user/emails"))).toBe(true)
})
