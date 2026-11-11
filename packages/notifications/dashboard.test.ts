import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Notification } from "./src/index.js"
import { TEST_IDS } from "./src/testids.js"
import type { AppHandle } from "./src/ui/app.js"
import { createDashboard, type DashboardOptions } from "./src/ui/dashboard.js"
import { DASHBOARD_ROOT_CLASS, DASHBOARD_STYLES } from "./src/ui/dashboard-styles.js"
import type { MountOptions } from "./src/ui/mount.js"

/** Just enough DOM for the dashboard shell, which builds itself with a handful of element calls. */
class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | null = null
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: unknown) => void>>()
  className = ""
  hidden = false
  text = ""
  constructor(readonly tagName: string) {}
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean))
    return {
      add: (name: string) => {
        this.className = [...names().add(name)].join(" ")
      },
      remove: (name: string) => {
        const next = names()
        next.delete(name)
        this.className = [...next].join(" ")
      },
      contains: (name: string) => names().has(name),
    }
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("")
  }
  set textContent(value: string) {
    this.children = []
    this.text = value
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = []
    this.text = ""
    this.append(...nodes)
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set()
    this.listeners.set(type, set)
    set.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    const full = { preventDefault() {}, ...event }
    for (const listener of this.listeners.get(type) ?? []) listener(full)
  }
  focus() {
    focused = this
  }
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()])
  }
  find(testId: string, tab?: string): FakeElement {
    const found = this.all().find(
      (node) =>
        node.getAttribute("data-testid") === testId &&
        (tab === undefined || node.getAttribute("data-tab") === tab),
    )
    if (!found) throw new Error(`no ${testId} ${tab ?? ""}`)
    return found
  }
}

let focused: FakeElement | null = null
const scope = globalThis as Record<string, unknown>
const saved = { document: scope.document, location: scope.location, history: scope.history }
const page = { href: "http://harness.test/" }

beforeEach(() => {
  focused = null
  page.href = "http://harness.test/"
  scope.document = { createElement: (tag: string) => new FakeElement(tag) }
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

type Arrive = NonNullable<MountOptions["onArrive"]>
const setup = (options: Partial<DashboardOptions> = {}) => {
  const host = new FakeElement("div")
  const log: string[] = []
  const ui: { options?: MountOptions; panel?: FakeElement; destroyed: boolean } = {
    destroyed: false,
  }
  const dashboard = createDashboard(
    host as unknown as HTMLElement,
    {
      injectStyles: false,
      emulators: {
        mount(panel) {
          log.push("mount emulators")
          const child = new FakeElement("div")
          child.setAttribute("data-testid", "admin")
          ;(panel as unknown as FakeElement).append(child)
          return () => log.push("dispose emulators")
        },
      },
      notifications: {},
      ...options,
    },
    (panel, mountOptions = {}) => {
      ui.options = mountOptions
      ui.panel = panel as unknown as FakeElement
      return {
        destroy: () => {
          ui.destroyed = true
        },
      } as unknown as AppHandle
    },
  )
  const arrive = (count: number) =>
    (ui.options as { onArrive: Arrive }).onArrive(
      Array.from({ length: count }, (_, i) => ({ id: `n${i}` }) as Notification),
    )
  const tab = (id: string) => host.find(TEST_IDS.dashboardTab, id)
  const panel = (id: string) => host.find(TEST_IDS.dashboardPanel, id)
  return {
    host,
    dashboard,
    log,
    ui,
    arrive,
    tab,
    panel,
    badge: () => host.find(TEST_IDS.dashboardBadge),
  }
}

describe("mountDashboard", () => {
  test("tabs are the embedder's, then Emulators, then Notifications", () => {
    const { dashboard, host, tab } = setup({
      title: "Acme lab",
      tabs: [{ id: "app", label: "App", mount() {} }],
    })
    expect(dashboard.tabs()).toEqual(["app", "emulators", "notifications"])
    expect(dashboard.active()).toBe("app")
    expect(tab("emulators").textContent).toBe("Emulators")
    expect(tab("notifications").textContent).toStartWith("Notifications")
    expect(host.classList.contains(DASHBOARD_ROOT_CLASS)).toBe(true)
    expect(host.getAttribute("data-testid")).toBe(TEST_IDS.dashboard)
    expect(host.getAttribute("data-theme")).toBe("dark")
    expect(host.textContent).toContain("Acme lab")
  })

  test("labels, theme and the open tab are options", () => {
    const { dashboard, host, tab } = setup({
      emulators: { label: "Vendors", mount() {} },
      notifications: { label: "Inbox" },
      initialTab: "notifications",
      theme: "auto",
    })
    expect(tab("emulators").textContent).toBe("Vendors")
    expect(tab("notifications").textContent).toStartWith("Inbox")
    expect(dashboard.active()).toBe("notifications")
    expect(host.getAttribute("data-theme")).toBe("auto")
    expect(host.getAttribute("data-tab")).toBe("notifications")
  })

  test("a tab is mounted the first time it is shown and stays mounted", () => {
    const { dashboard, log, panel } = setup({ initialTab: "notifications" })
    expect(log).toEqual([])
    expect(panel("emulators").hidden).toBe(true)
    expect(panel("notifications").hidden).toBe(false)
    dashboard.show("emulators")
    dashboard.show("notifications")
    dashboard.show("emulators")
    expect(log).toEqual(["mount emulators"])
    expect(panel("emulators").hidden).toBe(false)
    expect(panel("notifications").hidden).toBe(true)
    expect(panel("emulators").find("admin")).toBeDefined()
  })

  test("tabs carry the ARIA tab pattern", () => {
    const { dashboard, host, tab, panel } = setup()
    const list = host.all().find((node) => node.getAttribute("role") === "tablist")
    expect(list?.children.map((child) => child.getAttribute("role"))).toEqual(["tab", "tab"])
    expect(tab("emulators").getAttribute("aria-selected")).toBe("true")
    expect(tab("emulators").getAttribute("tabindex")).toBe("0")
    expect(tab("notifications").getAttribute("aria-selected")).toBe("false")
    expect(tab("notifications").getAttribute("tabindex")).toBe("-1")
    expect(panel("emulators").getAttribute("role")).toBe("tabpanel")
    expect(panel("emulators").getAttribute("aria-labelledby")).toBe(
      tab("emulators").getAttribute("id"),
    )
    expect(tab("emulators").getAttribute("aria-controls")).toBe(
      panel("emulators").getAttribute("id"),
    )
    dashboard.show("notifications")
    expect(tab("notifications").getAttribute("aria-selected")).toBe("true")
    expect(tab("emulators").getAttribute("aria-selected")).toBe("false")
  })

  test("click and arrow keys switch tabs and move focus", () => {
    const changes: string[] = []
    const { dashboard, tab } = setup({ onTabChange: (id) => changes.push(id) })
    tab("notifications").dispatch("click")
    expect(dashboard.active()).toBe("notifications")
    tab("notifications").dispatch("keydown", { key: "ArrowRight" })
    expect(dashboard.active()).toBe("emulators")
    expect(focused).toBe(tab("emulators"))
    tab("emulators").dispatch("keydown", { key: "ArrowLeft" })
    expect(dashboard.active()).toBe("notifications")
    tab("notifications").dispatch("keydown", { key: "Home" })
    expect(dashboard.active()).toBe("emulators")
    tab("emulators").dispatch("keydown", { key: "End" })
    expect(dashboard.active()).toBe("notifications")
    tab("notifications").dispatch("keydown", { key: "a" })
    expect(changes).toEqual([
      "notifications",
      "emulators",
      "notifications",
      "emulators",
      "notifications",
    ])
  })

  test("the badge counts what arrives while another tab is open, and clears on open", () => {
    const seen: number[] = []
    const { dashboard, arrive, badge } = setup({
      notifications: { onArrive: (added) => seen.push(added.length) },
    })
    expect(badge().hidden).toBe(true)
    arrive(2)
    arrive(1)
    expect(badge().hidden).toBe(false)
    expect(badge().textContent).toBe("3")
    expect(badge().getAttribute("data-count")).toBe("3")
    dashboard.show("notifications")
    expect(badge().hidden).toBe(true)
    arrive(4)
    expect(badge().hidden).toBe(true)
    dashboard.show("emulators")
    arrive(120)
    expect(badge().textContent).toBe("99+")
    expect(seen).toEqual([2, 1, 4, 120])
  })

  test("the notifications UI gets its options, without the tab label", () => {
    const { ui, panel } = setup({ notifications: { label: "Inbox", namespace: "run-7" } })
    // Mounted one element down, so the UI's own `data-testid` and `data-tab` leave the panel's alone.
    expect(panel("notifications").children).toEqual([ui.panel as never])
    expect(panel("notifications").getAttribute("data-tab")).toBe("notifications")
    expect(ui.options?.namespace).toBe("run-7")
    expect(ui.options && "label" in ui.options).toBe(false)
  })

  test("syncUrl reads ?tab= and keeps it current", () => {
    page.href = "http://harness.test/?tab=notifications&view=sms"
    const { dashboard } = setup({ syncUrl: true, initialTab: "emulators" })
    expect(dashboard.active()).toBe("notifications")
    dashboard.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=emulators&view=sms")
  })

  test("syncUrl leaves a URL without ?tab= alone until the viewer switches", () => {
    const { dashboard } = setup({ syncUrl: true, initialTab: "notifications" })
    expect(dashboard.active()).toBe("notifications")
    expect(page.href).toBe("http://harness.test/")
    dashboard.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=emulators")
  })

  test("without syncUrl the page URL is neither read nor written", () => {
    page.href = "http://harness.test/?tab=notifications"
    const { dashboard } = setup()
    expect(dashboard.active()).toBe("emulators")
    dashboard.show("notifications")
    dashboard.show("emulators")
    expect(page.href).toBe("http://harness.test/?tab=notifications")
  })

  test("an async mount shows progress, then its dispose runs on destroy", async () => {
    let finish: (dispose: () => void) => void = () => {}
    const log: string[] = []
    const { dashboard, panel } = setup({
      emulators: { mount: () => new Promise<() => void>((resolve) => (finish = resolve)) },
    })
    expect(panel("emulators").getAttribute("aria-busy")).toBe("true")
    expect(panel("emulators").textContent).toContain("Loading")
    finish(() => log.push("disposed"))
    await Promise.resolve()
    await Promise.resolve()
    expect(panel("emulators").getAttribute("aria-busy")).toBeNull()
    expect(panel("emulators").textContent).toBe("")
    dashboard.destroy()
    expect(log).toEqual(["disposed"])
  })

  test("a mount that fails says why in its panel", async () => {
    const { panel, dashboard } = setup({
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
    expect(panel("broken").textContent).toBe("no canvas")
    dashboard.show("emulators")
    await Promise.resolve()
    await Promise.resolve()
    expect(panel("emulators").textContent).toBe("admin UI did not load")
  })

  test("destroy disposes every tab, the notifications UI and the host", () => {
    const { dashboard, host, log, ui, tab } = setup()
    const button = tab("notifications")
    dashboard.destroy()
    dashboard.destroy()
    expect(log).toEqual(["mount emulators", "dispose emulators"])
    expect(ui.destroyed).toBe(true)
    expect(host.children).toEqual([])
    expect(host.classList.contains(DASHBOARD_ROOT_CLASS)).toBe(false)
    expect(host.getAttribute("data-testid")).toBeNull()
    expect([...button.listeners.values()].every((set) => set.size === 0)).toBe(true)
  })

  test("needs at least one tab, and unique ids", () => {
    const host = new FakeElement("div") as unknown as HTMLElement
    const mountUi = () => ({ destroy() {} }) as unknown as AppHandle
    expect(() => createDashboard(host, {}, mountUi)).toThrow("pass tabs")
    expect(() =>
      createDashboard(
        host,
        { tabs: [{ id: "emulators", label: "Mine", mount() {} }], emulators: { mount() {} } },
        mountUi,
      ),
    ).toThrow("duplicate tab id emulators")
  })

  test("every style rule is scoped to the dashboard root", () => {
    const selectors = DASHBOARD_STYLES.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]*\{/g, "")
      .split("}")
      .map((rule) => rule.split("{")[0]?.trim() ?? "")
      .filter(Boolean)
      .flatMap((selector) => selector.split(","))
    expect(selectors.length).toBeGreaterThan(10)
    for (const selector of selectors)
      expect(selector.trim()).toStartWith(`.${DASHBOARD_ROOT_CLASS}`)
  })
})
