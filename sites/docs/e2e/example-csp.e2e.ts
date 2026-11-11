/**
 * End-to-end: the built site, served with its real Content-Security-Policy, running the
 * lab-ordering example in Chromium. The policy has no `'unsafe-eval'`, so anything that
 * evaluates a string (`new Function`, `eval`) is refused. That is what once broke the
 * Emulators tab. Every screen the example mounts has to work without it.
 *
 *   bun run build && bun run e2e   # needs Chromium: bunx playwright install chromium
 *
 * It is not part of `bun test`, which runs without a browser.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { type Browser, chromium, type Page } from "@playwright/test"
import { type Subprocess, spawn } from "bun"

/** The admin UI loads brand marks from here, so the page has to be served from it too. */
const ORIGIN = "https://mockingbird.chrisvouga.dev"

let server: Subprocess<"ignore", "pipe", "inherit">
let browser: Browser
let page: Page
let csp = ""
const problems: string[] = []

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

beforeAll(async () => {
  const port = freePort()
  server = spawn(["bun", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  const local = `http://127.0.0.1:${port}`
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${local}/healthz`)
      break
    } catch (error) {
      if (attempt > 100) throw error
      await Bun.sleep(100)
    }
  }
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace(ORIGIN, local),
      maxRedirects: 0,
    })
    await route.fulfill({ response })
  })
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`))
  await page.addInitScript(() => {
    const violations: string[] = []
    Object.assign(window, { __cspViolations: violations })
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  const response = await page.goto(`${ORIGIN}/examples/medical-testing`)
  csp = response?.headers()["content-security-policy"] ?? ""
  await page.locator("[data-example-open]").first().click()
  await tab("emulators").waitFor({ timeout: 60_000 })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

/** The example is one dashboard: Example | Emulators | Notifications. */
const tab = (id: string) => page.locator(`[data-testid="dashboard-tab"][data-tab="${id}"]`)
const panel = (id: string) => page.locator(`[data-testid="dashboard-panel"][data-tab="${id}"]`)

const violations = () =>
  page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)

test("the page is served with a policy that forbids evaluating strings", () => {
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toContain("unsafe-eval")
})

test("the example opens as one dashboard with three tabs", async () => {
  expect(await page.getByTestId("dashboard-tab").allInnerTexts()).toEqual([
    "Example",
    "Emulators",
    "Notifications",
  ])
  expect(await tab("app").getAttribute("aria-selected")).toBe("true")
  await panel("app").getByTestId("sign-in-email").waitFor({ timeout: 15_000 })
})

test("the Emulators tab mounts the admin UI and reads an emulator's state", async () => {
  await tab("emulators").click()
  const admin = panel("emulators")
  await admin.locator(".ant-menu-item", { hasText: "Overview" }).waitFor({ timeout: 30_000 })
  expect(await admin.innerText()).not.toContain("Content Security Policy")

  await admin.locator(".ant-select").first().click()
  const emulators = await admin.locator(".ant-select-item-option").allInnerTexts()
  expect(emulators).toEqual(
    expect.arrayContaining(["Google", "Stripe", "Junction", "Twilio", "Resend", "Slack"]),
  )
  await admin.locator(".ant-select-item-option", { hasText: "Junction" }).click()
  await admin.locator(".ant-menu-item", { hasText: "State" }).click()
  await admin.locator(".ant-table-row").first().waitFor({ timeout: 15_000 })

  // The admin UI keeps its emulator and screen to itself: the docs page URL does not change.
  expect(new URL(page.url()).pathname).toBe("/examples/medical-testing")
  expect(new URL(page.url()).hash).toBe("")
}, 90_000)

test("email sign-in: the code is read from the Notifications tab", async () => {
  await tab("app").click()
  const app = panel("app")
  await app.locator('[data-testid="demo-account"][data-email="admin@example.test"]').click()
  expect(await app.getByTestId("sign-in-email").inputValue()).toBe("admin@example.test")
  await app.getByTestId("sign-in-email-submit").click()
  await app.getByTestId("inbox-hint").waitFor({ timeout: 15_000 })
  expect(await app.getByTestId("inbox-hint").innerText()).toContain("admin@example.test")

  // The hint's button switches tabs and opens that mailbox.
  await app.getByTestId("open-inbox").click()
  expect(await tab("notifications").getAttribute("aria-selected")).toBe("true")
  const inbox = panel("notifications")
  const mail = inbox.locator('[data-testid="email-row"][data-to="admin@example.test"]').first()
  await mail.waitFor({ timeout: 15_000 })
  const subject = await mail.getByTestId("email-row-subject").innerText()
  const code = /^(\d{6}) is your Cove sign-in code/.exec(subject)?.[1]
  if (!code) throw new Error(`no code in the subject: ${subject}`)

  // The email itself renders: the branded layout, with the same code in its body.
  await mail.click()
  const body = inbox.frameLocator('[data-testid="email-body"]')
  await body.getByText(code).first().waitFor({ timeout: 15_000 })
  await body.getByText("Sign in to Cove").first().waitFor()

  await tab("app").click()
  await app.getByTestId("sign-in-code").fill(code)
  await app.getByTestId("sign-in-code-submit").click()
  await app.getByRole("button", { name: "Administration" }).waitFor({ timeout: 15_000 })
}, 90_000)

test("a phone number is verified with the code texted to the demo phone", async () => {
  const app = panel("app")
  await app.getByRole("button", { name: "Account", exact: true }).click()
  await app.getByTestId("phone-remove").click()
  await app.getByTestId("phone-input").fill("(415) 555-0142")
  await app.getByTestId("phone-send").click()
  await app.getByTestId("phone-code").waitFor({ timeout: 15_000 })
  await app.getByTestId("phone-card").getByTestId("open-inbox").click()
  const bubble = panel("notifications")
    .locator('[data-testid="sms-bubble"][data-to="+14155550142"][data-code]')
    .first()
  await bubble.waitFor({ timeout: 15_000 })
  const code = (await bubble.getAttribute("data-code")) ?? ""
  expect(code).toMatch(/^\d{4,8}$/)

  await tab("app").click()
  await app.getByTestId("phone-code").fill(code)
  await app.getByTestId("phone-verify").click()
  await app.getByTestId("phone-current").waitFor({ timeout: 15_000 })
  expect(await app.getByTestId("phone-current").innerText()).toBe("(415) 555-0142")

  // Sign out, so the next test signs in through the OAuth emulator instead.
  await app.getByRole("button", { name: "Sign out" }).click()
  await app.getByTestId("sign-in-email").waitFor({ timeout: 15_000 })
}, 90_000)

test("the OAuth pages work without their inline scripts", async () => {
  const app = panel("app")
  await app
    .getByRole("button", { name: /Google/ })
    .first()
    .click()
  await app.getByTestId("oauth-mock-account").first().waitFor({ timeout: 15_000 })
  await app.locator('input[name="oauth-theme"][value="dark"]').check()
  await app.locator('[data-testid="oauth-mock-account"][data-account-id="admin"] button').click()
  await app.getByTestId("oauth-mock-allow").waitFor({ timeout: 15_000 })
  expect(await app.locator('input[name="oauth-theme"][value="dark"]').isChecked()).toBe(true)
  await app.getByTestId("oauth-mock-allow").click()
  await app.getByRole("button", { name: "Administration" }).waitFor({ timeout: 15_000 })
}, 90_000)

test("the checkout page pays without its inline script, and the receipt is emailed", async () => {
  const app = panel("app")
  await app
    .getByRole("button", { name: /Order tests/ })
    .first()
    .click()
  await app
    .getByRole("button", { name: /Add test/ })
    .first()
    .click()
  await app.getByRole("checkbox").first().check()
  await app.getByRole("button", { name: /Continue to checkout/ }).click()
  await app.getByTestId("stripe-mock-pay").waitFor({ timeout: 20_000 })
  await app.getByTestId("stripe-mock-test-card").first().click()
  expect(await app.locator('input[name="card"]').inputValue()).toBe("4242 4242 4242 4242")
  const email = app.getByTestId("stripe-mock-email")
  if (await email.count()) await email.fill("alex@example.test")
  await app.getByTestId("stripe-mock-pay").click()
  await app.getByText("Payment successful").waitFor({ timeout: 20_000 })

  // Messages arrived while the Example tab was open: the Notifications tab counts them.
  await page.locator('[data-testid="dashboard-badge"]:not([hidden])').waitFor({ timeout: 15_000 })
  await app.locator(".cove-notice").getByTestId("open-inbox").click()
  const inbox = panel("notifications")
  const receipt = inbox
    .locator('[data-testid="email-row"][data-to="admin@example.test"]', {
      hasText: "Your Cove receipt for order",
    })
    .first()
  await receipt.waitFor({ timeout: 15_000 })
  await receipt.click()
  await inbox
    .frameLocator('[data-testid="email-body"]')
    .getByText("Total paid", { exact: true })
    .waitFor({ timeout: 15_000 })
}, 90_000)

test("the staff alert is posted to the chat workspace", async () => {
  const inbox = panel("notifications")
  const chat = inbox.locator('[data-testid="channel-tab"][data-value="chat"]')
  if (await chat.isVisible()) await chat.click()
  await inbox.locator('[data-testid="chat-channel"][data-to="#lab-orders"]').first().click()
  await inbox
    .locator('[data-testid="chat-message"]', { hasText: "New paid order" })
    .first()
    .waitFor({ timeout: 15_000 })
  expect(await inbox.getByTestId("chat-device").getAttribute("data-workspace")).toBe("Cove")
}, 60_000)

test("the members administration screen mounts", async () => {
  await tab("app").click()
  const app = panel("app")
  await app.getByRole("button", { name: "Administration" }).click()
  await app.locator(".ant-table-row").first().waitFor({ timeout: 15_000 })
}, 60_000)

test("nothing violated the policy or threw", async () => {
  expect(await violations()).toEqual([])
  expect(problems).toEqual([])
})
