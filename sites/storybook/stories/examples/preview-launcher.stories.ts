import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  createPreviewLaunchDemo,
  PREVIEW_LAUNCH_DEMO_CONTROLS,
  type PreviewLaunchDemo,
} from "../../../../packages/adapters/preview/src/on-demand-demo.js"
import {
  mountPreviewLauncher,
  type PreviewLaunch,
  type PreviewLauncher,
  startPreviewLauncher,
} from "../../../../packages/ui/src/preview-launcher.js"

/**
 * The launcher page a pull request links to before anything is built: it starts the on-demand
 * build, shows it live and opens the preview when it is ready. Each story answers from a fake
 * relay (`fetch` is injected, nothing reaches the network); the Demo story runs the real relay
 * against `createPreviewLaunchDemo()`'s simulated builds.
 */
export default {
  title: "Examples/Preview launcher/Launcher page",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/preview-launcher.ts",
      "packages/ui/src/preview-launcher-view.ts",
      "packages/adapters/preview/src/on-demand-demo.ts",
    ],
  },
} satisfies Meta

const PR = 42
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const OLD = "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
const RELAY = "https://relay.example/launch"
const LIVE_URL = "https://pr-42.preview.example/"
const RUN_URL = "https://ci.example/runs/1234"
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

const STEPS: { name: string; state: "pending" | "running" | "done" | "failed" | "skipped" }[] = [
  { name: "Set up job", state: "done" },
  { name: "Run actions/checkout@v4", state: "done" },
  { name: "Run oven-sh/setup-bun@v2", state: "done" },
  { name: "Run bun install --frozen-lockfile", state: "running" },
  { name: "Run bun run build:preview", state: "pending" },
  { name: "Run bun run preview:publish", state: "pending" },
]

const at = (patch: Record<string, unknown>): PreviewLaunch =>
  ({ pullRequest: PR, head: HEAD, ...patch }) as PreviewLaunch

type Reply = { status?: number; body: unknown } | { html: string } | "hang"
type Relay = { calls: string[]; posts(): number }

let mounted: PreviewLauncher | undefined
let relay: Relay | undefined
let opened: string[] = []
let demo: PreviewLaunchDemo | undefined

/** A relay that answers `reply(method, posts so far)`, recording every call. */
function fakeFetch(reply: (method: string, posts: number) => Reply): {
  fetch: typeof fetch
  relay: Relay
} {
  const calls: string[] = []
  const posts = () => calls.filter((call) => call.startsWith("POST")).length
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push(`${method} ${String(input)}`)
    const answer = reply(method, posts())
    if (answer === "hang") return new Promise<Response>(() => {})
    if ("html" in answer)
      return new Response(answer.html, { headers: { "content-type": "text/html" } })
    return Response.json(answer.body, { status: answer.status ?? 200 })
  }) as typeof fetch
  return { fetch: fetcher, relay: { calls, posts } }
}

/** Mounts the launcher against a fake relay; `onLive` is captured, never navigating the frame. */
const launcher =
  (reply: (method: string, posts: number) => Reply, options: { stay?: boolean } = {}) =>
  () => {
    mounted?.destroy()
    opened = []
    const fake = fakeFetch(reply)
    relay = fake.relay
    const host = document.createElement("div")
    host.style.minHeight = "100vh"
    mounted = mountPreviewLauncher(host, {
      pullRequest: PR,
      relay: RELAY,
      fetch: fake.fetch,
      onLive: (url) => opened.push(url),
      ...(options.stay ? { stay: true } : {}),
    })
    return host
  }
const always = (launch: PreviewLaunch) => () => ({ body: launch })
const calls = () => {
  if (!relay) throw new Error("No relay mounted")
  return relay
}

const ui = (canvas: HTMLElement) => within(canvas)
const headline = (canvas: HTMLElement) => ui(canvas).getByTestId("preview-launcher-headline")
const settled = async (canvas: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(headline(canvas)).toHaveTextContent(text))
const phaseStatus = (canvas: HTMLElement) =>
  [...canvas.querySelectorAll<HTMLElement>(".mpl-phase")].map((node) => node.dataset.status)

/** Opening the page starts the build: exactly one start request, then Queued. */
export const Starting: StoryObj = {
  render: launcher((method, posts) =>
    method === "POST" || posts > 0
      ? { status: method === "POST" ? 202 : 200, body: at({ state: "queued", steps: [] }) }
      : { body: at({ state: "idle" }) },
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Waiting for a build machine…")
    await expect(calls().calls).toEqual([`GET ${RELAY}?pr=42`, `POST ${RELAY}?pr=42`])
    await expect(ui(canvasElement).getByTestId("preview-launcher-title")).toHaveTextContent(
      "Pull request #42",
    )
    await expect(ui(canvasElement).getByTestId("preview-launcher-commit")).toHaveTextContent(
      "a1b2c3d",
    )
    await expect(ui(canvasElement).getByTestId("preview-launcher-status")).toHaveAttribute(
      "aria-live",
      "polite",
    )
  },
}

/** Idle, before the start request answers: Starting a build… (the start never answers here). */
export const Idle: StoryObj = {
  render: launcher((method) => (method === "POST" ? "hang" : { body: at({ state: "idle" }) })),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(calls().posts()).toBe(1))
    await settled(canvasElement, "Starting a build…")
    await expect(phaseStatus(canvasElement)).toEqual(["current", "todo", "todo", "todo"])
  },
}

/** Queued: the stepper on Queued, elapsed time from the run's creation. */
export const Queued: StoryObj = {
  render: launcher(
    always(at({ state: "queued", steps: [], run: { url: RUN_URL, startedAt: ago(4) } })),
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Waiting for a build machine…")
    await expect(phaseStatus(canvasElement)).toEqual(["current", "todo", "todo", "todo"])
    await expect(ui(canvasElement).getByTestId("preview-launcher-log")).toHaveAttribute(
      "href",
      RUN_URL,
    )
    await expect(calls().posts()).toBe(0)
  },
}

/** Building with an estimate: friendly step names, elapsed time ticking, a determinate bar. */
export const Building: StoryObj = {
  render: launcher(
    always(
      at({
        state: "building",
        estimateSeconds: 120,
        run: { url: RUN_URL, startedAt: ago(42) },
        steps: STEPS,
      }),
    ),
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Building the preview…")
    const page = ui(canvasElement)
    await expect(phaseStatus(canvasElement)).toEqual(["done", "current", "todo", "todo"])
    const steps = page.getByTestId("preview-launcher-steps")
    await expect(steps).toHaveTextContent("Getting the code")
    await expect(steps).toHaveTextContent("Setting up Bun")
    await expect(steps).toHaveTextContent("Installing dependencies")
    await expect(steps.querySelector('[data-state="running"] .mpl-spin')).not.toBeNull()
    const progress = page.getByRole("progressbar", { name: "Build progress" })
    await expect(Number(progress.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(35)
    await expect(Number(progress.getAttribute("aria-valuenow"))).toBeLessThan(100)
    const elapsed = page.getByTestId("preview-launcher-elapsed")
    await expect(elapsed).toHaveTextContent(/Elapsed 0:4\d · usually about 2 min/)
    const first = elapsed.textContent
    await waitFor(() => expect(elapsed.textContent).not.toBe(first), { timeout: 2500 })
    await expect(page.getByRole("link", { name: /View build log/ })).toHaveAttribute(
      "href",
      RUN_URL,
    )
    await expect(page.queryByTestId("preview-launcher-current")).not.toBeVisible()
  },
}

/** Building with no estimate: the bar is indeterminate. */
export const BuildingWithoutEstimate: StoryObj = {
  render: launcher(
    always(at({ state: "building", run: { url: RUN_URL, startedAt: ago(8) }, steps: STEPS })),
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Building the preview…")
    const progress = ui(canvasElement).getByRole("progressbar")
    await expect(progress).toHaveAttribute("data-mode", "indeterminate")
    await expect(progress).not.toHaveAttribute("aria-valuenow")
    await expect(ui(canvasElement).getByTestId("preview-launcher-elapsed")).not.toHaveTextContent(
      "usually",
    )
  },
}

/** Publishing: the build is done and the preview is being published; the bar never shows 100%. */
export const Publishing: StoryObj = {
  render: launcher(
    always(
      at({
        state: "publishing",
        estimateSeconds: 30,
        run: { url: RUN_URL, startedAt: ago(75) },
        steps: STEPS.map((step) => ({
          ...step,
          state: step.name.includes("publish") ? ("running" as const) : ("done" as const),
        })),
      }),
    ),
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Publishing the preview…")
    await expect(phaseStatus(canvasElement)).toEqual(["done", "done", "current", "todo"])
    await expect(ui(canvasElement).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "95")
  },
}

/** A newer commit builds while an older one is live: offer the current version. */
export const BuildingWhileOlderIsLive: StoryObj = {
  render: launcher(
    always(
      at({
        state: "building",
        estimateSeconds: 90,
        run: { url: RUN_URL, startedAt: ago(20) },
        steps: STEPS,
        live: { commit: OLD, url: LIVE_URL },
      }),
    ),
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Building the preview…")
    const current = ui(canvasElement).getByRole("link", {
      name: "Open the current version (b9c8d7e)",
    })
    await expect(current).toHaveAttribute("href", LIVE_URL)
    current.focus()
    await expect(document.activeElement).toBe(current)
  },
}

/** Ready, staying: an Open button, and the page keeps watching. */
export const ReadyStay: StoryObj = {
  render: launcher(always(at({ state: "live", commit: HEAD, url: LIVE_URL })), { stay: true }),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "The preview is ready.")
    await expect(ui(canvasElement).getByRole("link", { name: "Open preview" })).toHaveAttribute(
      "href",
      LIVE_URL,
    )
    await expect(phaseStatus(canvasElement)).toEqual(["done", "done", "done", "current"])
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(opened).toEqual([])
  },
}

/** Ready: shows Ready for a moment, then opens the preview (captured here, not navigated). */
export const ReadyRedirect: StoryObj = {
  render: launcher(always(at({ state: "live", commit: HEAD, url: LIVE_URL }))),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Ready. Opening the preview…")
    await expect(opened).toEqual([])
    await waitFor(() => expect(opened).toEqual([LIVE_URL]), { timeout: 2000 })
    await expect(ui(canvasElement).queryByTestId("preview-launcher-open")).not.toBeVisible()
  },
}

/** Failed: the reason, Try again (a start request) and the log. */
export const Failed: StoryObj = {
  render: launcher((method, posts) =>
    method === "POST" || posts > 0
      ? { status: method === "POST" ? 202 : 200, body: at({ state: "queued", steps: [] }) }
      : {
          body: at({
            state: "failed",
            reason: "The build failed.",
            retryable: true,
            run: { url: RUN_URL, startedAt: ago(300) },
          }),
        },
  ),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "The build failed.")
    const page = ui(canvasElement)
    await expect(page.getByTestId("preview-launcher-detail")).toHaveTextContent("The build failed.")
    await expect(page.getByRole("link", { name: /View build log/ })).toHaveAttribute(
      "href",
      RUN_URL,
    )
    await expect(calls().posts()).toBe(0)
    const retry = page.getByRole("button", { name: "Try again" })
    await userEvent.click(retry)
    await waitFor(() => expect(calls().posts()).toBe(1))
    await settled(canvasElement, "Waiting for a build machine…")
    await expect(calls().calls.at(-1)).toBe(`POST ${RELAY}?pr=42`)
  },
}

const terminal = (state: "unsupported" | "closed" | "unavailable", message: string, text: string) =>
  ({
    render: launcher(always(at({ state, message }))),
    play: async ({ canvasElement }) => {
      await settled(canvasElement, text)
      await expect(ui(canvasElement).getByTestId("preview-launcher-detail")).toHaveTextContent(
        message,
      )
      await expect(ui(canvasElement).getByTestId("preview-launcher-retry")).not.toBeVisible()
      await new Promise((resolve) => setTimeout(resolve, 300))
      await expect(calls().calls).toEqual([`GET ${RELAY}?pr=42`])
    },
  }) satisfies StoryObj

/** The branch predates on-demand previews: the message, no retry. */
export const Unsupported: StoryObj = terminal(
  "unsupported",
  "This branch predates on-demand previews. Merge the base branch into it, then open this page again.",
  "This branch cannot build a preview yet.",
)

/** Closed, merged, from a fork or missing: the message, no retry. */
export const Closed: StoryObj = terminal(
  "closed",
  "This pull request is closed, merged, from a fork, or does not exist.",
  "This pull request has no preview.",
)

/** The relay is switched off or not configured: the message, no retry. */
export const Unavailable: StoryObj = terminal(
  "unavailable",
  "On-demand previews are not configured for this repository.",
  "Previews are not available right now.",
)

/** HTTP 503 from the relay: a calm Reconnecting…, retried shortly. */
export const Reconnecting: StoryObj = {
  render: launcher(() => ({
    status: 503,
    body: at({ state: "unavailable", message: "The build service is not answering." }),
  })),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Reconnecting…")
    await expect(canvasElement.querySelector(".mpl")).toHaveAttribute("data-tone", "reconnecting")
  },
}

/** A proxy's HTML fallback instead of a launch: Reconnecting…, never an error page. */
export const ReconnectingFromFallback: StoryObj = {
  render: launcher(() => ({ html: "<!doctype html><title>Not found</title><h1>Not found</h1>" })),
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Reconnecting…")
    await expect(canvasElement).not.toHaveTextContent("Not found")
  },
}

/** An address that is not a pull request's (`/pr/042`): says so and asks nothing. */
export const NotAPullRequest: StoryObj = {
  render: () => {
    mounted?.destroy()
    mounted = undefined
    const host = document.createElement("div")
    startPreviewLauncher({ relay: RELAY, pathname: "/pr/042", host })
    return host
  },
  play: async ({ canvasElement }) => {
    await expect(headline(canvasElement)).toHaveTextContent("This is not a pull request address.")
  },
}

/** On a phone: the stepper, steps and actions fit the width, and nothing scrolls sideways. */
export const Phone: StoryObj = {
  ...BuildingWhileOlderIsLive,
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    await settled(canvasElement, "Building the preview…")
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
    const card = canvasElement.querySelector<HTMLElement>(".mpl-card")
    if (!card) throw new Error("No card")
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
  },
}

/**
 * The real relay against simulated builds (`createPreviewLaunchDemo()`, a 4 s build): the page
 * starts a build, watches it to Ready and stays. The buttons push a commit (the page builds it
 * while offering the live one), fail the next build, take the relay offline and switch its token.
 */
export const Demo: StoryObj = {
  render: () => {
    mounted?.destroy()
    opened = []
    const sim = createPreviewLaunchDemo({
      pullRequest: PR,
      buildSeconds: 4,
      queueSeconds: 1,
      publishSeconds: 1,
    })
    demo = sim
    const route = (input: RequestInfo | URL, init?: RequestInit) =>
      sim.fetch(new Request(new URL(String(input), RELAY), init))
    const host = document.createElement("div")
    host.style.minHeight = "100vh"
    const bar = document.createElement("div")
    bar.setAttribute("role", "toolbar")
    bar.setAttribute("aria-label", "Demo controls")
    bar.style.cssText =
      "display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;font:13px system-ui;border-bottom:1px solid #8884"
    for (const key of PREVIEW_LAUNCH_DEMO_CONTROLS) {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = key
      button.dataset.testid = `demo-${key}`
      button.addEventListener("click", async () => {
        await route(`/demo/${key}`, { method: "POST" })
        mounted?.refresh()
      })
      bar.append(button)
    }
    const page = document.createElement("div")
    host.append(bar, page)
    mounted = mountPreviewLauncher(page, {
      pullRequest: PR,
      relay: RELAY,
      fetch: route as typeof fetch,
      stay: true,
      onLive: (url) => opened.push(url),
    })
    return host
  },
  play: async ({ canvasElement }) => {
    const sim = demo
    if (!sim) throw new Error("No demo")
    const page = ui(canvasElement)
    await waitFor(() => expect(sim.dispatches()).toBe(1))
    await expect(page.getByRole("link", { name: /Open the current version/ })).toBeVisible()
    await settled(canvasElement, /Building the preview…|Waiting for a build machine…/)
    await waitFor(
      () => expect(headline(canvasElement)).toHaveTextContent("The preview is ready."),
      {
        timeout: 15_000,
      },
    )
    await expect(page.getByRole("link", { name: "Open preview" })).toBeVisible()

    // Push a commit while staying on Ready: the page builds the new head, offering the live one.
    await userEvent.click(page.getByTestId("demo-push"))
    await waitFor(() => expect(sim.dispatches()).toBe(2), { timeout: 3000 })
    await settled(canvasElement, /Building the preview…|Waiting for a build machine…/)
    await expect(page.getByRole("link", { name: /Open the current version/ })).toBeVisible()

    // Offline: Reconnecting…; online again: back to the build.
    await userEvent.click(page.getByTestId("demo-offline"))
    await settled(canvasElement, "Reconnecting…")
    await userEvent.click(page.getByTestId("demo-online"))
    await settled(canvasElement, /Building the preview…|Waiting for a build machine…|ready/)
    await expect(opened).toEqual([])
  },
}
