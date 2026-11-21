/**
 * What every screen shares: the API client, the mounted root and the address bar. The markup that
 * means the same thing everywhere is in `kit.tsx`.
 */
import type { CatalogEntry, Json, Managed, Org } from "./types.js"

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

/** The API's code for a hand edit of something the organization's `mockingbird.yaml` declares. */
export const MANAGED_BY_DECLARATION = "managed_by_declaration"

/** The address of a hand edit that the organization's `mockingbird.yaml` controls. */
export class ManagedError extends Error {
  constructor(
    readonly org: Org,
    /** What was asked for: "Renaming a fleet". */
    readonly what: string,
    /** The screen that shows the thing, read-only. */
    readonly back: { href: string; label: string },
  ) {
    super(`${what} is controlled by mockingbird.yaml in ${org.name}.`)
  }
}

/**
 * Refuse to draw the form for something the organization's `mockingbird.yaml` declares; the router
 * says so in its place. An organization that cannot be read is left to the API to judge.
 */
export function declared(org: Org | undefined, what: string, back: ManagedError["back"]): void {
  if (org?.managed) throw new ManagedError(org, what, back)
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

/** The one mounted dashboard. `mount` (see `router.tsx`) fills it in. */
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
 * Every link of the dashboard is an ordinary `<a href>`. A click on one that stays inside it is
 * followed here, without loading the page again; the browser follows the rest itself: a link to
 * sign-in or the API, one opened in a new tab or window, or one that downloads a file.
 */
export function followLinks(root: HTMLElement): () => void {
  const listener = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    if (!(anchor instanceof HTMLAnchorElement) || !root.contains(anchor)) return
    if (anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return
    const href = anchor.getAttribute("href") ?? ""
    if (!/^\/(?!\/)/.test(href) || /^\/(auth|api|f)\//.test(href)) return
    navigate(event, href)
  }
  root.addEventListener("click", listener)
  return () => root.removeEventListener("click", listener)
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

/** "Nov 10, 2026, 9:30 AM". */
export const moment = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

/** "Last applied Nov 10, 2026, 9:30 AM by ada@example.com." */
export const lastApplied = (managed: Managed) =>
  `Last applied ${moment(managed.appliedAt)} by ${managed.appliedBy}.`

export const day = (value: unknown) =>
  typeof value === "string"
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "never"

/** "1 fleet", "3 fleets". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
