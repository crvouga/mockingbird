/**
 * What every screen shares: the API client, the mounted root, the address bar, and the helpers
 * that run an action and redraw.
 */
import { type Child, h, type Props } from "./dom.js"
import type { CatalogEntry, Json } from "./types.js"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path.startsWith("/auth/") ? path : `/api/v1${path}`, {
    method,
    headers: {
      "x-mockingbird-csrf": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok)
    throw new ApiError(response.status, payload.error?.message ?? `HTTP ${response.status}`)
  return payload as T
}

/** Where the dashboard is: the browser's address bar, or a stand-in when mounted elsewhere. */
export type Address = {
  path(): string
  search(): string
  origin(): string
  push(href: string): void
  replace(href: string): void
}

export const browserAddress: Address = {
  path: () => location.pathname,
  search: () => location.search,
  origin: () => location.origin,
  push: (href) => history.pushState(null, "", href),
  replace: (href) => history.replaceState(null, "", href),
}

/** An address held in memory, for mounting the dashboard somewhere that is not its own page. */
export function memoryAddress(initial: string, origin: string): Address {
  let current = new URL(initial, origin)
  const go = (href: string) => {
    current = new URL(href, origin)
  }
  return {
    path: () => current.pathname,
    search: () => current.search,
    origin: () => origin,
    push: go,
    replace: go,
  }
}

/** The one mounted dashboard. `mount` (see `router.ts`) fills it in. */
export const ui: {
  root: HTMLElement
  address: Address
  render: () => Promise<void>
  /** A secret the API returns exactly once, kept on screen until the next navigation. */
  revealed: { label: string; value: string } | undefined
  catalog: CatalogEntry[] | undefined
  lastPath: string | undefined
} = {
  root: undefined as unknown as HTMLElement,
  address: browserAddress,
  render: async () => {},
  revealed: undefined,
  catalog: undefined,
  lastPath: undefined,
}

export const link = (href: string, props: Props, ...children: Child[]) =>
  h("a", { href, ...props, onclick: (event) => navigate(event, href) }, ...children)

export function navigate(event: Event | undefined, href: string) {
  const mouse = event as MouseEvent | undefined
  if (mouse && (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button !== 0)) return
  event?.preventDefault()
  ui.address.push(href)
  void ui.render()
}

let working = 0

/**
 * Mark the dashboard busy while `work` runs (`aria-busy` on its root), so assistive technology
 * and tests can tell a screen that is being redrawn from one that has come to rest.
 */
export async function busy<T>(work: () => Promise<T>): Promise<T> {
  working++
  ui.root.setAttribute("aria-busy", "true")
  try {
    return await work()
  } finally {
    if (--working === 0) ui.root.removeAttribute("aria-busy")
  }
}

/** Run an action, then redraw the current screen from the API; show a failure where it happened. */
export function act(work: () => Promise<unknown>, after?: () => void) {
  return async (event: Event) => {
    event.preventDefault()
    const control = ((event as SubmitEvent).submitter ??
      event.currentTarget) as HTMLButtonElement | null
    if (control) control.disabled = true
    const path = ui.address.path()
    try {
      await busy(async () => {
        await work()
        // A secret belongs to the screen that asked for it, never the one moved to since.
        if (ui.address.path() !== path) ui.revealed = undefined
        after?.()
        await ui.render()
      })
    } catch (error) {
      if (control) control.disabled = false
      flash((error as Error).message)
    }
  }
}

/**
 * Where a failed action is reported. Every screen puts one under its header, so the message is
 * always in the same place: below the title (and tabs), above the content it is about.
 */
export const flashSlot = () => h(".flash", {})

/** Report a failed action. It replaces the previous report and nothing else on screen. */
export function flash(message: string) {
  const notice = h("p.notice.error", { role: "alert" }, message)
  const slot = ui.root.querySelector(".flash")
  if (slot) slot.replaceChildren(notice)
  else (ui.root.querySelector("main") ?? ui.root).prepend(h(".flash", {}, notice))
}

/** The roles, lowest first, and whether one is at least another. */
const RANK = ["viewer", "member", "admin", "owner"]
export const atLeast = (role: string | undefined, minimum: string) =>
  RANK.indexOf(role ?? "") >= RANK.indexOf(minimum)

/** What a screen shows in place of something the caller's role may not see. */
export const noAccess = (why: string) =>
  h(".empty", { role: "alert" }, h("strong", {}, "You do not have access"), why)

export const confirmThen =
  (question: string, work: () => Promise<unknown>, after?: () => void) => (event: Event) => {
    event.preventDefault()
    if (window.confirm(question)) void act(work, after)(event)
  }

export function copyable(value: string, label = "Copy") {
  const button = h("button.small", { type: "button" }, label)
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value)
    button.textContent = "Copied"
    setTimeout(() => (button.textContent = label), 1500)
  })
  return h(".copy", {}, h("code", { title: value }, value), button)
}

/** Breadcrumb trail; the last item is the current page. */
export const crumbs = (...items: Child[]) =>
  h(
    "nav.crumbs",
    { "aria-label": "Breadcrumb" },
    items.map((item, index) => [
      index > 0 && h("span", { "aria-hidden": "true" }, "/"),
      h("span", {}, item),
    ]),
  )

/** The first form on screen matching `selector`. */
export const form = (selector = "form") => ui.root.querySelector(selector) as HTMLFormElement

export const field = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim()
export const day = (value: unknown) =>
  typeof value === "string"
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "never"

export const secretNotice = () =>
  ui.revealed &&
  h(
    ".notice.secret",
    { role: "status" },
    h("p", {}, h("strong", {}, ui.revealed.label), " Copy it now; it will not be shown again."),
    copyable(ui.revealed.value),
  )
