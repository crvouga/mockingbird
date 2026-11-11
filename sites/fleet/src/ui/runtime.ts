/**
 * What every screen shares: the API client, the mounted root, the address bar, and the few
 * pieces of markup that mean the same thing everywhere.
 */
import { type Child, h, type Props } from "./dom.js"
import type { CatalogEntry, Json } from "./types.js"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's own name for what went wrong: `quota_exceeded`, `org_suspended`, … */
    readonly code = "",
    /** For a 400, one string per problem, such as `body.slug: …`. */
    readonly details?: unknown,
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
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown }
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload.error?.message ?? `HTTP ${response.status}`,
      payload.error?.code,
      payload.error?.details,
    )
  return payload as T
}

/** Refuse to draw a screen the caller's role may not use; the router shows the no-access state. */
export function deny(why: string): never {
  throw new ApiError(403, why, "forbidden")
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

/**
 * What a mutation leaves for the screen it lands on: which item changed and what to say beside
 * it ("Created just now"). It is shown by that one screen and gone on the next navigation.
 */
export type Note = { about: string; text: string }

/** A secret the API returns exactly once, held for its result screen and nowhere else. */
export type Secret = { id: string; value: string; for?: string }

/** The one mounted dashboard. `mount` (see `router.ts`) fills it in. */
export const ui: {
  root: HTMLElement
  address: Address
  render: () => Promise<void>
  note: Note | undefined
  secret: Secret | undefined
  catalog: CatalogEntry[] | undefined
} = {
  root: undefined as unknown as HTMLElement,
  address: browserAddress,
  render: async () => {},
  note: undefined,
  secret: undefined,
  catalog: undefined,
}

export const link = (href: string, props: Props, ...children: Child[]) =>
  h("a", { href, ...props, onclick: (event) => navigate(event, href) }, ...children)

/** A link that looks like a button: the one obvious next step on a query screen. */
export const action = (
  href: string,
  label: Child,
  kind: "primary" | "plain" | "danger" = "plain",
) => link(href, { class: `button${kind === "plain" ? "" : ` ${kind}`}` }, label)

/** Follow a link: whatever the last mutation left behind does not come along. */
export function navigate(event: Event | undefined, href: string) {
  const mouse = event as MouseEvent | undefined
  if (mouse && (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button !== 0)) return
  event?.preventDefault()
  ui.note = undefined
  ui.secret = undefined
  ui.address.push(href)
  void ui.render()
}

/**
 * Where a mutation goes when it has succeeded: the screen its result lives on, with what to say
 * there. The mutation's own address is replaced, so Back does not return to a spent form.
 */
export function land(href: string, left: { note?: Note; secret?: Secret } = {}): Promise<void> {
  ui.note = left.note
  ui.secret = left.secret
  ui.address.replace(href)
  return ui.render()
}

/** Where signing in returns to: a path on this site, never another one. */
export function returnTo(search: string): string {
  const wanted = new URLSearchParams(search).get("return_to") ?? ""
  return /^\/(?!\/)/.test(wanted) && !wanted.startsWith("/sign-") ? wanted : "/"
}

/** "Created just now", beside the thing a mutation just changed; nothing when it was not this. */
export const justNow = (about: string) =>
  ui.note?.about === about && h("span.just-now", { role: "status" }, ui.note.text)

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

/** The roles, lowest first, and whether one is at least another. */
const RANK = ["viewer", "member", "admin", "owner"]
export const atLeast = (role: string | undefined, minimum: string) =>
  RANK.indexOf(role ?? "") >= RANK.indexOf(minimum)

/** "an owner", "a member". */
export const aRole = (role: string | undefined) =>
  `${role === "owner" || role === "admin" ? "an" : "a"} ${role ?? "member"}`

/** A value with a button that copies it. Copying changes nothing on the server. */
export function copyable(value: string, label = "Copy") {
  const button = h("button.small", { type: "button", "data-local": "copy" }, label)
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value).catch(() => {})
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
    items
      .filter((item) => item !== false && item !== undefined && item !== null)
      .map((item, index) => [
        index > 0 && h("span.sep", { "aria-hidden": "true" }, "/"),
        h("span", {}, item),
      ]),
  )

/** The top of a screen: its heading, a sentence about it, and its one obvious action. */
export const head = (title: Child, sub: Child, ...actions: Child[]) =>
  h(
    ".head",
    {},
    h("div.head-text", {}, h("h1", { tabindex: "-1" }, title), sub && h("p.sub", {}, sub)),
    actions.some(Boolean) && h(".head-actions", {}, actions),
  )

/**
 * The current settings of a thing, as labelled values. Each row may carry the link to the screen
 * that changes it; a query screen never changes a value in place.
 */
export const properties = (
  label: string,
  rows: (false | { name: string; value: Child; about?: string; change?: Child })[],
) =>
  h(
    "dl.props",
    { "aria-label": label },
    rows.map(
      (row) =>
        row &&
        h(
          ".prop",
          {},
          h("dt", {}, row.name),
          h("dd", {}, h(".prop-value", {}, row.value), row.about && justNow(row.about)),
          row.change && h("dd.prop-change", {}, row.change),
        ),
    ),
  )

/** A section of a query screen: a heading, optionally its action, then its content. */
export const section = (title: string, actions: Child, ...content: Child[]) =>
  h(
    "section",
    {},
    h(".section-head", {}, h("h2", {}, title), actions && h(".head-actions", {}, actions)),
    content,
  )

/** What a list says when something was just taken out of it. */
export const removed = (about: string) => {
  const note = justNow(about)
  return note && h("p.removed", {}, note)
}

/** A screen-sized statement: nothing here, not found, no access. */
export const statement = (title: string, body: Child, ...links: Child[]) =>
  h(
    ".statement",
    {},
    h("h1", { tabindex: "-1" }, title),
    h("p", {}, body),
    links.some(Boolean) && h(".statement-links", {}, links),
  )

export const day = (value: unknown) =>
  typeof value === "string"
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "never"

/** "1 fleet", "3 fleets". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
