import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MockingbirdProvider } from "@crvouga/mockingbird-ui/react"
import { createElement } from "react"
import { renderToString } from "react-dom/server.edge"
import type { Notification } from "./src/index.js"
import { TEST_IDS } from "./src/testids.js"
import { Dashboard } from "./src/ui/dashboard.js"
import { createDashboardModel } from "./src/ui/dashboard-model.js"
import type { DashboardOptions } from "./src/ui/types.js"

const scope = globalThis as Record<string, unknown>
const saved = { location: scope.location, history: scope.history }
const page = { href: "http://harness.test/" }

beforeEach(() => {
  page.href = "http://harness.test/"
  scope.location = page
  scope.history = {
    state: null,
    replaceState(_state: unknown, _title: string, url: URL | string) {
      page.href = String(url)
    },
  }
})
afterEach(() => {
  Object.assign(scope, saved)
})

/** A stand-in for the element a tab draws into. */
const panel = () => ({ children: [] as string[] }) as unknown as HTMLElement

const setup = (options: Partial<DashboardOptions> = {}) => {
  const log: string[] = []
  const model = createDashboardModel({
    emulators: {
      mount() {
        log.push("mount emulators")
        return () => log.push("dispose emulators")
      },
    },
    notifications: {},
    ...options,
  })
  for (const id of model.tabs()) model.attach(id, panel())
  const arrive = (count: number) =>
    model.arrive(Array.from({ length: count }, (_, i) => ({ id: `n${i}` }) as Notification))
  const html = (title = "Mockingbird") =>
    renderToString(
      createElement(MockingbirdProvider, null, createElement(Dashboard, { model, title })),
    )
  return { model, log, arrive, html }
}

/** The attributes of the first element matching `testid` (and `data-tab`) in server-rendered markup. */
const tagOf = (html: string, testId: string, tab?: string): string => {
  const tags = html.match(/<[a-z]+\b[^>]*>/g) ?? []
  const found = tags.find(
    (tag) =>
      tag.includes(`data-testid="${testId}"`) &&
      (tab === undefined || tag.includes(`data-tab="${tab}"`)),
  )
  if (!found) throw new Error(`no ${testId} ${tab ?? ""}`)
  return found
}

describe("mountDashboard's tabs", () => {
  test("tabs are the embedder's, then Emulators, then Notifications", () => {
    const { model, html } = setup({ tabs: [{ id: "app", label: "App", mount() {} }] })
    expect(model.tabs()).toEqual(["app", "emulators", "notifications"])
    expect(model.active()).toBe("app")
    const markup = html("Acme lab")
    expect(markup).toContain("Acme lab")
    expect(markup).toContain(">Emulators<")
    expect(markup).toContain(">Notifications<")
    expect(tagOf(markup, TEST_IDS.dashboard)).toContain('data-tab="app"')
  })

  test("labels and the open tab are options", () => {
    const { model, html } = setup({
      emulators: { label: "Vendors", mount() {} },
      notifications: { label: "Inbox" },
      initialTab: "notifications",
    })
    expect(model.active()).toBe("notifications")
    const markup = html()
    expect(markup).toContain(">Vendors<")
    expect(markup).toContain(">Inbox<")
    expect(tagOf(markup, TEST_IDS.dashboard)).toContain('data-tab="notifications"')
  })

  test("a tab is mounted the first time it is shown and stays mounted", () => {
    const { model, log } = setup({ initialTab: "notifications" })
    expect(log).toEqual([])
    model.show("emulators")
    model.show("notifications")
    model.show("emulators")
    expect(log).toEqual(["mount emulators"])
  })

  test("a tab shown before its panel exists is mounted when the panel arrives", () => {
    const log: string[] = []
    const model = createDashboardModel({ emulators: { mount: () => void log.push("mount") } })
    expect(log).toEqual([])
    model.attach("emulators", panel())
    expect(log).toEqual(["mount"])
  })

  test("tabs carry the ARIA tab pattern and their test ids", () => {
    const { html, model } = setup()
    const markup = html()
    expect(markup).toContain('role="tablist"')
    const emulators = tagOf(markup, TEST_IDS.dashboardTab, "emulators")
    expect(emulators).toContain('role="tab"')
    expect(emulators).toContain('aria-selected="true"')
    expect(tagOf(markup, TEST_IDS.dashboardTab, "notifications")).toContain('aria-selected="false"')
    expect(tagOf(markup, TEST_IDS.dashboardPanel, "emulators")).toContain('role="tabpanel"')
    // Every panel stays in the page; the closed ones are inert and hidden.
    expect(tagOf(markup, TEST_IDS.dashboardPanel, "notifications")).toContain('data-inert="true"')
    model.show("notifications")
    expect(tagOf(html(), TEST_IDS.dashboardTab, "notifications")).toContain('aria-selected="true"')
  })

  test("showing a tab reports the change, once per change", () => {
    const changes: string[] = []
    const { model } = setup({ onTabChange: (id) => changes.push(id) })
    model.show("notifications")
    model.show("notifications")
    model.show("emulators")
    model.show("nope")
    expect(model.active()).toBe("emulators")
    expect(changes).toEqual(["notifications", "emulators"])
  })

  test("the badge counts what arrives while another tab is open, and clears on open", () => {
    const seen: number[] = []
    const { model, arrive, html } = setup({
      notifications: { onArrive: (added) => seen.push(added.length) },
    })
    expect(tagOf(html(), TEST_IDS.dashboardBadge)).toContain("hidden")
    arrive(2)
    arrive(1)
    expect(model.unread()).toBe(3)
    const badge = tagOf(html(), TEST_IDS.dashboardBadge)
    expect(badge).toContain('data-count="3"')
    expect(badge).not.toContain("hidden")
    model.show("notifications")
    expect(model.unread()).toBe(0)
    arrive(4)
    expect(model.unread()).toBe(0)
    model.show("emulators")
    arrive(120)
    expect(html()).toContain(">99+<")
    expect(seen).toEqual([2, 1, 4, 120])
  })

  test("syncUrl reads ?tab= and keeps it current", () => {
    page.href = "http://harness.test/?tab=notifications&view=sms"
    const { model } = setup({ syncUrl: true, initialTab: "emulators" })
    expect(model.active()).toBe("notifications")
    model.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=emulators&view=sms")
  })

  test("syncUrl leaves a URL without ?tab= alone until the viewer switches", () => {
    const { model } = setup({ syncUrl: true, initialTab: "notifications" })
    expect(model.active()).toBe("notifications")
    expect(page.href).toBe("http://harness.test/")
    model.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=emulators")
  })

  test("without syncUrl the page URL is neither read nor written", () => {
    page.href = "http://harness.test/?tab=notifications"
    const { model } = setup()
    expect(model.active()).toBe("emulators")
    model.show("notifications")
    model.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=notifications")
  })

  test("an async mount shows progress, then its dispose runs on destroy", async () => {
    let finish: (dispose: () => void) => void = () => {}
    const log: string[] = []
    const { model, html } = setup({
      emulators: { mount: () => new Promise<() => void>((resolve) => (finish = resolve)) },
    })
    expect(model.entries[0]?.status).toEqual({ kind: "loading" })
    expect(html()).toContain('aria-busy="true"')
    expect(html()).toContain("Loading")
    finish(() => log.push("disposed"))
    await Promise.resolve()
    await Promise.resolve()
    expect(model.entries[0]?.status).toBeNull()
    model.destroy()
    expect(log).toEqual(["disposed"])
  })

  test("a mount that fails says why in its panel", async () => {
    const { model, html } = setup({
      tabs: [
        {
          id: "broken",
          label: "Broken",
          mount() {
            throw new Error("no canvas")
          },
        },
      ],
      emulators: { mount: () => Promise.reject(new Error("admin UI did not load")) },
    })
    expect(html()).toContain("no canvas")
    model.show("emulators")
    await Promise.resolve()
    await Promise.resolve()
    expect(model.entries[1]?.status).toEqual({ kind: "error", message: "admin UI did not load" })
    expect(html()).toContain("admin UI did not load")
  })

  test("destroy disposes every tab, once", () => {
    const { model, log } = setup()
    model.destroy()
    model.destroy()
    expect(log).toEqual(["mount emulators", "dispose emulators"])
    expect(model.destroyed).toBe(true)
  })

  test("a mount that settles after destroy is disposed at once", async () => {
    let finish: (dispose: () => void) => void = () => {}
    const log: string[] = []
    const { model } = setup({
      emulators: { mount: () => new Promise<() => void>((resolve) => (finish = resolve)) },
    })
    model.destroy()
    finish(() => log.push("disposed"))
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(["disposed"])
  })

  test("needs at least one tab, and unique ids", () => {
    expect(() => createDashboardModel({})).toThrow("pass tabs")
    expect(() =>
      createDashboardModel({
        tabs: [{ id: "emulators", label: "Mine", mount() {} }],
        emulators: { mount() {} },
      }),
    ).toThrow("duplicate tab id emulators")
  })
})
