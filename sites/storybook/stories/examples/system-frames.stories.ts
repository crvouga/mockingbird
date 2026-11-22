import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, waitFor, within } from "storybook/test"
import {
  mountSystemHarness,
  type SystemHarness,
  type SystemHarnessOptions,
  type SystemHarnessStorage,
  type SystemSurface,
} from "../../../../packages/ui/src/system-harness.js"

/**
 * URL-backed surfaces (#904): each app is a same-origin page the harness shows in an iframe
 * (`frame` in place of `mount`). The harness creates and removes the iframe, keeps each page's
 * last inner path in its `storage`, writes the tab's address from `address()` when the page
 * navigates (by event, never by polling), and keeps its own loading panel up until the page
 * says it is `ready`, or shows the error panel when it never does.
 *
 * The pages here are same-origin `blob:` documents with hash routes, so their inner path is the
 * hash; a host's own pages would use real paths the same way.
 */
export default {
  title: "Examples/System harness/Frame surfaces",
  beforeEach: () => () => {
    stop?.()
    stop = undefined
  },
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-frame.ts",
      "packages/ui/src/system-view.tsx",
    ],
  },
} satisfies Meta

/** A small hash-routed app that tells the shell it is ready once it has painted (unless `stuck`). */
const pageHtml = (id: string, title: string, links: string[], stuck = false) => `<!doctype html>
<meta charset="utf-8">
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 32px;color:#1f2328}
a,button{margin-right:12px;font:inherit}h1{font-size:20px;margin:0 0 8px}</style>
<h1>${title}</h1>
<p>At <code data-testid="where"></code></p>
<nav>${links.map((link) => `<a href="#${link}">${link}</a>`).join("")}<button type="button" id="push">Push #/pushed</button></nav>
<script>
var where = document.querySelector("[data-testid=where]")
function paint() { where.textContent = location.hash.slice(1) || "/" }
addEventListener("hashchange", paint)
addEventListener("popstate", paint)
document.getElementById("push").onclick = function () { history.pushState(null, "", "#/pushed"); paint() }
paint()
${stuck ? "" : `requestAnimationFrame(function () { parent.postMessage({ type: "frame-ready", page: ${JSON.stringify(id)} }, "*") })`}
</script>`

const blob = (html: string) => URL.createObjectURL(new Blob([html], { type: "text/html" }))

let pages: Record<string, string> | undefined
/** The pages' addresses, made once so a remount ("reload") reopens the same documents. */
const page = (id: string) => {
  pages ??= {
    shop: blob(pageHtml("shop", "Shop", ["/", "/orders/7", "/cart"])),
    admin: blob(pageHtml("admin", "Admin", ["/", "/users/3", "/users/4"])),
    stuck: blob(pageHtml("stuck", "Never ready", ["/"], true)),
  }
  const url = pages[id]
  if (!url) throw new Error(`No page ${id}`)
  return url
}

/** The tab's address for each app: `/shop/orders/7` is the shop page at `#/orders/7`. */
const appOf = (location: Location) => location.pathname.match(/^\/(shop|admin|stuck)(\/|$)/)?.[1]
const hashOf = (path: string | undefined) =>
  path?.includes("#") ? path.slice(path.indexOf("#")) : undefined

/** Ready when the page posts `frame-ready`: the harness's loading panel stays up until then. */
const ready = (frame: HTMLIFrameElement, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== "frame-ready") return
      removeEventListener("message", onMessage)
      resolve()
    }
    addEventListener("message", onMessage)
    signal.addEventListener("abort", () => removeEventListener("message", onMessage))
  })

/** A frame surface, as a host declares it: the whole of its host code. */
const framed = (id: string, label: string): SystemSurface => ({
  id,
  label,
  frame: {
    // A deep link into this app wins; else where it was last; else its start page.
    src: (last) => {
      const deep = appOf(location) === id ? location.pathname.slice(id.length + 1) : ""
      return page(id) + (deep && deep !== "/" ? `#${deep}` : (hashOf(last) ?? "#/"))
    },
    address: (inner) => `/${id}${inner.hash.slice(1) || "/"}`,
    ready,
  },
})

const memory = (): SystemHarnessStorage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
}

let harness: SystemHarness | undefined
let stop: (() => void) | undefined
let store = memory()

const current = (): SystemHarness => {
  if (!harness) throw new Error("No harness")
  return harness
}

const options = (extra: SystemHarnessOptions = {}): SystemHarnessOptions => ({
  storage: store,
  url: {
    read: appOf,
    write: (id) => (id === "system" ? "/system" : `/${id}/`),
  },
  ...extra,
})

const render =
  (surfaces: () => SystemSurface[], start: string, extra: SystemHarnessOptions = {}) =>
  () => {
    stop?.()
    store = memory()
    const original = location.href
    history.replaceState(null, "", start)
    const host = document.createElement("div")
    host.style.height = "100vh"
    let mounted = mountSystemHarness(host, surfaces(), options(extra))
    harness = mounted
    remount = () => {
      mounted.destroy()
      mounted = mountSystemHarness(host, surfaces(), options(extra))
      harness = mounted
    }
    stop = () => {
      mounted.destroy()
      history.replaceState(null, "", original)
    }
    return host
  }

/** Destroys the harness and mounts it again at the same address with the same storage: a reload. */
let remount: () => void = () => {}

const frameOf = (canvas: HTMLElement, id: string) =>
  canvas.querySelector<HTMLIFrameElement>(`section[data-surface="${id}"] iframe`)
/** Waits for the page in `id`'s frame to say it is at `path`. */
const at = async (canvas: HTMLElement, id: string, path: string) =>
  waitFor(
    () =>
      expect(
        frameOf(canvas, id)?.contentDocument?.querySelector("[data-testid=where]")?.textContent,
      ).toBe(path),
    { timeout: 3000 },
  )
const click = (canvas: HTMLElement, id: string, selector: string) => {
  const target = frameOf(canvas, id)?.contentDocument?.querySelector<HTMLElement>(selector)
  if (!target) throw new Error(`No ${selector} in ${id}`)
  target.click()
}

/** Two same-origin pages: deep links, in-page navigation, switching and a reload each keep their own path. */
export const TwoPages: StoryObj = {
  render: render(() => [framed("shop", "Shop"), framed("admin", "Admin")], "/admin/users/3"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByTestId("system-switcher", {}, { timeout: 3000 })
    // A deep link opens the admin page at that path, and the address stays.
    await expect(current().active()).toBe("admin")
    await at(canvasElement, "admin", "/users/3")
    await expect(location.pathname).toBe("/admin/users/3")
    await expect(current().frame("admin")).toBe(frameOf(canvasElement, "admin"))
    await expect(current().frame("admin")?.title).toBe("Admin")
    await expect(current().frame("shop")).toBeUndefined()

    // Navigating inside the page moves the tab's address with it, in the same task as the
    // navigation (the frame's navigation events, no polling): a link, then a pushState.
    click(canvasElement, "admin", 'a[href="#/users/4"]')
    expect(location.pathname).toBe("/admin/users/4")
    click(canvasElement, "admin", "#push")
    expect(location.pathname).toBe("/admin/pushed")
    click(canvasElement, "admin", 'a[href="#/users/4"]')
    expect(location.pathname).toBe("/admin/users/4")

    // Switching to the shop opens it at its start page; then it navigates on its own.
    await current().show("shop")
    await at(canvasElement, "shop", "/")
    await waitFor(() => expect(location.pathname).toBe("/shop/"))
    click(canvasElement, "shop", 'a[href="#/orders/7"]')
    await waitFor(() => expect(location.pathname).toBe("/shop/orders/7"))

    // Switching back and forth: each page is where it was, and so is the address.
    await current().show("admin")
    await expect(location.pathname).toBe("/admin/users/4")
    await at(canvasElement, "admin", "/users/4")
    await current().show("shop")
    await expect(location.pathname).toBe("/shop/orders/7")

    // A hidden page's own navigation leaves the address alone.
    const admin = current().frame("admin")
    if (admin?.contentWindow) admin.contentWindow.location.hash = "#/users/3"
    await at(canvasElement, "admin", "/users/3")
    await expect(location.pathname).toBe("/shop/orders/7")

    // A reload at the shop's address reopens the shop there, and the admin page where it was left.
    remount()
    await canvas.findByTestId("system-switcher", {}, { timeout: 3000 })
    await expect(current().active()).toBe("shop")
    await at(canvasElement, "shop", "/orders/7")
    await current().show("admin")
    await at(canvasElement, "admin", "/users/3")
    await waitFor(() => expect(location.pathname).toBe("/admin/users/3"))
  },
}

/** A page that never says it is ready: the harness's error panel, after the host's timeout. */
export const NeverReady: StoryObj = {
  render: render(() => [framed("stuck", "Never ready"), framed("shop", "Shop")], "/stuck/", {
    readyTimeoutMs: 400,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByTestId("system-switcher", {}, { timeout: 3000 })
    await expect(
      await canvas.findByText(
        /Never ready did not become ready within 400 ms/,
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
    // The frame is gone with its failed mount; the other page still opens.
    await expect(current().frame("stuck")).toBeUndefined()
    await current().show("shop")
    await at(canvasElement, "shop", "/")
  },
}
