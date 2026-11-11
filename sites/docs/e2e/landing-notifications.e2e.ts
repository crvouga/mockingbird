/**
 * End-to-end: the landing page's live notifications demo, on the built site with its real
 * Content-Security-Policy. The demo loads only when its section is near the viewport, boots four
 * emulators in the tab and mounts the notifications harness's own UI, so this checks the things a
 * unit test cannot: the lazy load, the devices, autoplay, and that none of it trips the policy.
 *
 *   bun run build && bun run e2e   # needs Chromium: bunx playwright install chromium
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { type Browser, chromium, type Page } from "@playwright/test"
import { type Subprocess, spawn } from "bun"

const ORIGIN = "https://mockingbird.chrisvouga.dev"

let server: Subprocess<"ignore", "pipe", "inherit">
let browser: Browser
let page: Page
let local = ""
let csp = ""
const problems: string[] = []

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

/** A landing page with the policy's violations and the console's errors collected. */
const openLanding = async (viewport: { width: number; height: number }) => {
  const context = await browser.newContext({ viewport })
  const opened = await context.newPage()
  await opened.route(`${ORIGIN}/**`, async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace(ORIGIN, local),
      maxRedirects: 0,
    })
    await route.fulfill({ response })
  })
  opened.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`)
  })
  opened.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`))
  await opened.addInitScript(() => {
    const violations: string[] = []
    Object.assign(window, { __cspViolations: violations })
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  const response = await opened.goto(`${ORIGIN}/`)
  return { opened, csp: response?.headers()["content-security-policy"] ?? "" }
}

const demoState = (on: Page) =>
  on.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-notifications-demo]")
    const ui = root?.querySelector<HTMLElement>(".mb-notifications")
    return {
      state: root?.dataset.state,
      autoplay: root?.dataset.autoplay,
      layout: ui?.dataset.layout,
      tab: ui?.dataset.tab,
      count: Number(ui?.dataset.count ?? 0),
    }
  })

/** The page scrolls smoothly, which a test cannot wait on: jump. */
const scrollToDemo = (on: Page) =>
  on.evaluate(() => {
    const root = document.querySelector("[data-notifications-demo]")
    if (!root) throw new Error("no notifications demo on the landing page")
    window.scrollTo({
      top: root.getBoundingClientRect().top + window.scrollY - 80,
      behavior: "instant",
    })
  })

const ready = (on: Page) =>
  on.locator('[data-notifications-demo][data-state="ready"]').waitFor({ timeout: 60_000 })

/** Ids of the notifications a device is showing. */
const idsOn = (on: Page, device: string) =>
  on.evaluate(
    (testId) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-notifications-demo] [data-testid="${testId}"] [data-notification-id]`,
        ),
      ].map((el) => el.dataset.notificationId as string),
    device,
  )

/** Click a button and wait for a notification the device was not showing before. */
const sendAndWait = async (on: Page, action: string, device: string, service: string) => {
  const before = new Set(await idsOn(on, device))
  await on.locator(`[data-demo-action="${action}"]`).click()
  await on.waitForFunction(
    ([testId, seen, from]) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-notifications-demo] [data-testid="${testId}"] [data-notification-id]`,
        ),
      ].some(
        (el) =>
          !(seen as string[]).includes(el.dataset.notificationId as string) &&
          el.dataset.service === from,
      ),
    [device, [...before], service] as const,
    { timeout: 15_000 },
  )
}

const violations = (on: Page) =>
  on.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)

beforeAll(async () => {
  const port = freePort()
  server = spawn(["bun", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  local = `http://127.0.0.1:${port}`
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
  const landing = await openLanding({ width: 1440, height: 900 })
  page = landing.opened
  csp = landing.csp
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

test("the landing page keeps its strict policy", () => {
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toContain("unsafe-eval")
  expect(csp).toContain("frame-src 'none'")
  expect(csp).toContain("connect-src 'self'")
})

test("the demo waits, with its buttons off, until its section is near the viewport", async () => {
  await page.waitForTimeout(500)
  expect((await demoState(page)).state).toBe("idle")
  expect(await page.locator("[data-notifications-demo] .mb-notifications").count()).toBe(0)
  expect(await page.locator('[data-demo-action="email"]').isDisabled()).toBe(true)
})

test("scrolling to the section mounts the harness UI without moving the page", async () => {
  const before = await page.locator("[data-notifications-demo]").boundingBox()
  await scrollToDemo(page)
  await ready(page)
  const after = await page.locator("[data-notifications-demo]").boundingBox()
  expect(after?.height).toBe(before?.height as number)
  const state = await demoState(page)
  expect(state.layout).toBe("grid")
  expect(await page.locator('[data-demo-action="email"]').isDisabled()).toBe(false)
  for (const device of ["sms-device", "push-device", "email-device", "chat-device"])
    expect(await page.getByTestId(device).isVisible()).toBe(true)
}, 90_000)

test("autoplay delivers notifications with nobody touching it", async () => {
  expect((await demoState(page)).autoplay).toBe("playing")
  await page.waitForFunction(
    () =>
      Number(
        document.querySelector<HTMLElement>("[data-notifications-demo] .mb-notifications")?.dataset
          .count ?? 0,
      ) >= 2,
    null,
    { timeout: 20_000 },
  )
  expect(await page.locator("[data-demo-call] code").innerText()).toMatch(/\w+\.\w+\//)
}, 30_000)

test("each button makes a call that lands on its own device, and stops autoplay", async () => {
  await sendAndWait(page, "code", "sms-device", "twilio")
  expect((await demoState(page)).autoplay).toBe("off")
  expect(await page.locator("[data-demo-call] code").innerText()).toContain("verify.twilio.com")
  expect(await page.locator("[data-demo-call] .badge").innerText()).toBe("201")

  await sendAndWait(page, "whatsapp", "sms-device", "twilio")
  expect(await page.locator("[data-demo-call] code").innerText()).toContain("Messages.json")

  await sendAndWait(page, "push", "push-device", "fcm")
  expect(await page.locator("[data-demo-call] code").innerText()).toContain("messages:send")

  await sendAndWait(page, "chat", "chat-device", "slack")
  expect(await page.locator("[data-demo-call] code").innerText()).toContain("chat.postMessage")

  await sendAndWait(page, "email", "email-device", "resend")
  expect(await page.locator("[data-demo-call] code").innerText()).toContain("api.resend.com/emails")

  // Autoplay stays off: nothing more arrives once the visitor has taken over.
  const settled = (await demoState(page)).count
  await page.waitForTimeout(3000)
  expect((await demoState(page)).count).toBe(settled)
}, 90_000)

test("the receipt opens in the mail window and its HTML renders under the policy", async () => {
  const heading = page
    .frameLocator('[data-notifications-demo] [data-testid="email-device"] iframe')
    .locator("h1")
  await heading.waitFor({ timeout: 15_000 })
  expect(await heading.innerText()).toContain("Thanks for your order, Ada!")
}, 30_000)

test("a checkout sends one message to every device, a few moments apart", async () => {
  const before = (await demoState(page)).count
  await page.locator('[data-demo-action="checkout"]').click()
  expect(await page.locator('[data-demo-action="email"]').isDisabled()).toBe(true)
  await page.waitForFunction(
    (target) =>
      Number(
        document.querySelector<HTMLElement>("[data-notifications-demo] .mb-notifications")?.dataset
          .count ?? 0,
      ) >= target,
    before + 4,
    { timeout: 20_000 },
  )
  await page.locator('[data-demo-action="email"]:not([disabled])').waitFor({ timeout: 10_000 })
  expect((await demoState(page)).count).toBe(before + 4)
}, 40_000)

test("reset empties every emulator and the devices", async () => {
  await page.locator('[data-demo-action="reset"]').click()
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-notifications-demo] .mb-notifications")?.dataset
        .count === "0",
    null,
    { timeout: 15_000 },
  )
  expect(await page.locator("[data-demo-call] code").innerText()).toBe("/__admin/reset")
  expect(await idsOn(page, "sms-device")).toEqual([])
}, 30_000)

test("a narrow viewport shows one device at a time, and a send brings its tab forward", async () => {
  const { opened } = await openLanding({ width: 390, height: 844 })
  try {
    await scrollToDemo(opened)
    await ready(opened)
    expect((await demoState(opened)).layout).toBe("tabs")
    await sendAndWait(opened, "push", "push-device", "fcm")
    expect((await demoState(opened)).tab).toBe("push")
    await sendAndWait(opened, "chat", "chat-device", "slack")
    expect((await demoState(opened)).tab).toBe("chat")
    // Nothing in the section is wider than the screen.
    const overflow = await opened.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-notifications-demo]")
      return root ? root.getBoundingClientRect().right - window.innerWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await violations(opened)).toEqual([])
  } finally {
    await opened.context().close()
  }
}, 120_000)

test("none of it violates the policy or logs an error", async () => {
  expect(await violations(page)).toEqual([])
  expect(problems).toEqual([])
})
