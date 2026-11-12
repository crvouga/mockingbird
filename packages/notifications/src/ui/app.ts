/// <reference lib="dom" />
/**
 * The harness UI. Plain DOM: each device re-renders from `state` when the harness reports a change.
 *
 * `createApp` mounts it on any element. Live, it reads a harness through `fetch` (a Fetch handler
 * for an in-process harness, or HTTP); otherwise it draws the notifications it is given, which is
 * how the Storybook catalog shows every state.
 *
 * Every element a test might look for has a `data-testid` from `../testids.ts`, and every element
 * that shows a notification carries its id, channel, service, recipient, sender and status as
 * `data-*` attributes. Every gesture (swipe, long press) also has a click or key equivalent.
 */
import { CHANNELS, type Channel, type Notification, type SourceStatus } from "../model.js"
import { TEST_IDS, type TestId } from "../testids.js"
import { emoji, mrkdwn, renderAttachments, renderBlocks } from "./chat.js"
import { icons } from "./icons.js"
import { createSoundPlayer, type SoundKind } from "./sounds.js"
import { ROOT_CLASS } from "./styles.js"
import {
  activeTab,
  type ChannelTab,
  type DeviceLayout,
  deviceScale,
  isCompact,
  isPhoneWidth,
  moveTab,
  phoneFit,
  TAB_LABELS,
  tabsFor,
} from "./tabs.js"

export type { ChannelTab, DeviceLayout } from "./tabs.js"

export type MotionPreference = "auto" | "full" | "reduce"

export type AppOptions = {
  /** Read a harness and follow its event stream. Default true. */
  live?: boolean
  /**
   * How to reach the harness: an in-process harness's `fetch`, or any Fetch-compatible function.
   * Default: the global `fetch` against `baseUrl`.
   */
  fetch?: (request: Request) => Promise<Response>
  /** Where the harness API lives. Default: the page's own URL (standalone), or a placeholder origin with `fetch`. */
  baseUrl?: string
  /** Read `?view=…` from the page URL and write `?namespace=` back to it. Default: true only for the standalone page. */
  syncUrl?: boolean
  /** Keep read state in `localStorage`. Default: same as `live`. */
  storage?: boolean
  /** Play alert sounds (and vibrate) on arrivals. Default false; the top bar toggles it. */
  sound?: boolean
  /** Animations. `auto` follows the viewer's reduced-motion setting. Default `auto`. */
  motion?: MotionPreference
  /** Fill the host element and scroll inside it, for a tab or panel in another app. */
  embedded?: boolean
  /** Which devices to show. Default all of them: `sms`, `push`, `email` and `chat`. */
  channels?: Channel[]
  /**
   * How the devices share the space. `auto` (default) lays them side by side and switches to one
   * device at a time, picked with the channel tabs, when the host element is narrower than 800px.
   * `tabs` always shows one device; `grid` never collapses.
   */
  layout?: DeviceLayout
  /** Show the channel tabs (`All | Text | Push | Email | Chat`). Default true; with `false`, `auto` never collapses. */
  tabs?: boolean
  /** Show the top bar (namespace, filter, view tabs, sound, emulator status). Default true. */
  chrome?: boolean
  /**
   * Draw the devices at this fraction of their full size (a phone is 362 by 760px), from 0.5 to 1,
   * for a host with less room than the full-size devices need. Default 1.
   */
  scale?: number
  /** Called with each batch of new notifications. */
  onArrive?: (added: Notification[]) => void

  /** Fixed notifications to draw when not live. */
  items?: Notification[]
  sources?: SourceStatus[]
  namespaces?: string[]
  namespace?: string
  discoveryError?: string | null
  /** Live-stream indicator when not live. Default true. */
  connected?: boolean
  /** Ids already read (when not live there is no browser storage). */
  seen?: string[]
  /** Ids drawn with their arrival animation. */
  arrived?: string[]
  /** Fixed clock in epoch ms, so relative times and the status bar never move. */
  now?: number
  title?: string
  /** A query string such as `?view=sms&to=…`, as a deep link would carry. */
  search?: string
  initial?: {
    view?: View
    only?: Channel | null
    search?: string
    follow?: boolean
    inspect?: string | null
    mailDetailsOpen?: boolean
    sms?: { to?: string | null; thread?: string | null; menu?: string | null }
    push?: {
      to?: string | null
      skin?: PushSkin
      expanded?: string | null
      preview?: string | null
      settings?: string | null
      openGroups?: string[]
    }
    email?: { to?: string | null; open?: string | null }
    chat?: { to?: string | null }
    toast?: string | null
    local?: {
      dismissed?: string[]
      pinned?: string[]
      muted?: string[]
      starred?: string[]
      silent?: string[]
      tapbacks?: Record<string, Tapback>
    }
  }
}

export type AppHandle = {
  render(): void
  state: { items: Notification[] }
  /** Resolves once the first read has been drawn (`data-ready="true"` on the root). */
  ready: Promise<void>
  /** Open one notification on its device, or a recipient on a device. */
  show(target: { id?: string; channel?: Channel; to?: string }): void
  setNamespace(namespace: string): void
  setSound(on: boolean): void
  /** Change the `scale` the devices are drawn at. */
  setScale(scale: number): void
  /** Stop streams and timers, remove listeners and empty the host. */
  destroy(): void
}

export type View = "devices" | "timeline"
export type PushSkin = "auto" | "ios" | "android"
export type Tapback = "heart" | "like" | "dislike" | "laugh" | "emphasize" | "question"

const TAPBACKS: { id: Tapback; glyph: string; label: string }[] = [
  { id: "heart", glyph: "♥", label: "Heart" },
  { id: "like", glyph: "👍", label: "Like" },
  { id: "dislike", glyph: "👎", label: "Dislike" },
  { id: "laugh", glyph: "HA<br>HA", label: "Laugh" },
  { id: "emphasize", glyph: "‼", label: "Emphasize" },
  { id: "question", glyph: "?", label: "Question" },
]

export function createApp(root: HTMLElement, options: AppOptions = {}): AppHandle {
  const live = options.live ?? true
  const syncUrl = options.syncUrl ?? (live && !options.fetch && !options.baseUrl)
  const storage = options.storage ?? live
  const fixedNow = options.now
  const nowMs = () => fixedNow ?? Date.now()
  const base =
    options.baseUrl ??
    (options.fetch || typeof location === "undefined" ? "http://harness.local/" : location.href)
  const send = (path: string, init?: RequestInit) => {
    const request = new Request(new URL(path, base), init)
    return options.fetch ? options.fetch(request) : fetch(request)
  }
  const listeners = new AbortController()
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ) => root.addEventListener(type, handler, { signal: listeners.signal, capture })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }
  let destroyed = false

  const params = new URLSearchParams(
    options.search ?? (syncUrl && typeof location !== "undefined" ? location.search : ""),
  )
  const initialView = params.get("view")
  const init = options.initial ?? {}

  const state = {
    namespace: params.get("namespace") ?? options.namespace ?? "default",
    namespaces: [] as string[],
    items: [] as Notification[],
    sources: [] as SourceStatus[],
    discoveryError: null as string | null,
    version: 0,
    view: (initialView === "timeline" ? "timeline" : "devices") as View,
    only: ((CHANNELS as readonly string[]).includes(initialView ?? "")
      ? initialView
      : null) as Channel | null,
    search: "",
    /** Narrow screens: whether the rest of the top bar is open. */
    menu: false,
    follow: params.get("follow") !== "0",
    connected: false,
    sms: {
      to: null as string | null,
      thread: null as string | null,
      menu: null as string | null,
      transition: null as "push" | "back" | null,
    },
    push: {
      to: null as string | null,
      skin: "auto" as PushSkin,
      expanded: null as string | null,
      preview: null as string | null,
      settings: null as string | null,
      wake: false,
    },
    email: { to: null as string | null, open: null as string | null, transition: false },
    chat: { to: null as string | null },
    inspect: null as string | null,
    toast: null as { text: string; undo?: () => void } | null,
    arrived: new Set<string>(options.arrived ?? []),
  }
  Object.assign(state, {
    ...init,
    sms: { ...state.sms, ...init.sms },
    push: { ...state.push, ...init.push },
    email: { ...state.email, ...init.email },
    chat: { ...state.chat, ...init.chat },
    toast: init.toast ? { text: init.toast } : null,
  })
  // A view named in the link wins over `initial`.
  if (initialView === "timeline") state.view = "timeline"
  delete (state as { local?: unknown }).local
  delete (state.push as { openGroups?: unknown }).openGroups

  /** What the viewer did on the devices. Never sent to the harness; a reload starts fresh. */
  const local = {
    dismissed: new Set<string>(init.local?.dismissed ?? []),
    pinned: new Set<string>(init.local?.pinned ?? []),
    muted: new Set<string>(init.local?.muted ?? []),
    starred: new Set<string>(init.local?.starred ?? []),
    silent: new Set<string>(init.local?.silent ?? []),
    checked: new Set<string>(),
    tapbacks: new Map<string, Tapback>(Object.entries(init.local?.tapbacks ?? {})),
    openGroups: new Set<string>(init.push?.openGroups ?? []),
  }

  let mailDetailsOpen = init.mailDetailsOpen ?? false
  const pinnedTo = params.get("to")
  const pinnedFrom = params.get("from")
  const pinnedId = params.get("id")
  /** A deep link to one recipient keeps that recipient, whatever else arrives. */
  const pinned = pinnedTo && state.only ? { channel: state.only, to: pinnedTo } : null
  if (params.get("follow") === null && pinned) state.follow = false

  // ── Layout: side by side, or one device at a time behind the channel tabs ────

  const enabled = CHANNELS.filter(
    (channel) => options.channels === undefined || options.channels.includes(channel),
  )
  const layout: DeviceLayout = options.layout ?? "auto"
  let scale = deviceScale(options.scale)
  let compact = layout === "tabs"
  /** The channel last picked, which a narrow layout falls back to when nothing is selected. */
  let lastTab: Channel | null = state.only
  const tab = (): ChannelTab => activeTab(enabled, compact, state.only, lastTab)

  /** Measure the host: whether the devices collapse to tabs, and how far a phone must shrink to fit. */
  const fit = (): boolean => {
    const width = root.clientWidth
    root.style.setProperty("--mbn-scale", String(scale))
    if (width > 0) root.style.setProperty("--mbn-fit", String(phoneFit(width, scale)))
    const size = width > 0 ? (isPhoneWidth(width) ? "phone" : "wide") : root.dataset.size
    const resized = size !== root.dataset.size
    if (size) root.dataset.size = size
    const next = isCompact(
      options.tabs === false && layout === "auto" ? "grid" : layout,
      width,
      scale,
    )
    if (next === compact) return resized
    compact = next
    return true
  }

  const reducedMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  const motion = (): "full" | "reduce" =>
    (options.motion ?? "auto") === "auto"
      ? reducedMotion()
        ? "reduce"
        : "full"
      : (options.motion as "full" | "reduce")
  const animate = () => motion() === "full"

  const soundKey = "mockingbird-notifications:sound"
  const storedSound = (): boolean | null => {
    if (!storage) return null
    try {
      const v = localStorage.getItem(soundKey)
      return v === null ? null : v === "1"
    } catch {
      return null
    }
  }
  const sound = createSoundPlayer(
    params.get("sound") !== null
      ? params.get("sound") === "1"
      : (storedSound() ?? options.sound ?? false),
  )

  // ── Read state (per namespace, per browser) ──────────────────────────────────

  const seenKey = () => `mockingbird-notifications:seen:${state.namespace}`
  let seen = new Set<string>(options.seen ?? [])
  const loadSeen = () => {
    if (!storage) return
    try {
      seen = new Set(JSON.parse(localStorage.getItem(seenKey()) ?? "[]") as string[])
    } catch {
      seen = new Set()
    }
  }
  const saveSeen = () => {
    if (!storage) return
    try {
      localStorage.setItem(seenKey(), JSON.stringify([...seen].slice(-5000)))
    } catch {}
  }
  const markSeen = (ids: string[]) => {
    let changed = false
    for (const id of ids)
      if (!seen.has(id)) {
        seen.add(id)
        changed = true
      }
    if (changed) saveSeen()
  }
  const markUnseen = (ids: string[]) => {
    for (const id of ids) seen.delete(id)
    saveSeen()
  }

  // ── Formatting ───────────────────────────────────────────────────────────────

  const esc = (value: unknown): string =>
    String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

  const tid = (id: TestId) => `data-testid="${id}"`

  /** The attributes every element showing one notification carries. */
  const nAttrs = (n: Notification) =>
    `data-notification-id="${esc(n.id)}" data-channel="${n.channel}" data-service="${esc(n.service)}" data-source="${esc(n.source)}" data-to="${esc(n.to)}" data-from="${esc(n.from.address)}" data-status="${esc(n.status ?? "")}" data-created-at="${esc(n.createdAt)}" data-unread="${!seen.has(n.id)}"${isWhatsApp(n) ? ' data-via="whatsapp"' : ""}`

  /** Sent to a `whatsapp:` address: drawn as a WhatsApp chat instead of a text thread. */
  const isWhatsApp = (n: Notification | undefined) => n?.sms?.via === "whatsapp"

  const linkify = (escaped: string): string =>
    escaped.replace(
      /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g,
      (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
    )

  const formatPhone = (value: string): string => {
    const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value)
    if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`
    return value
  }

  const isPhone = (value: string) => /^\+?\d[\d\s()-]{5,}$/.test(value)

  /** A sender address without its `whatsapp:` channel prefix. */
  const bareAddress = (address: string) => address.replace(/^whatsapp:/i, "")

  const displaySender = (n: Notification): string => {
    const address = bareAddress(n.from.address)
    return n.from.name ?? (isPhone(address) ? formatPhone(address) : address)
  }

  const initials = (value: string): string => {
    const words = value
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (!words.length) return "?"
    return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase()
  }

  const AVATAR = [
    "#1a73e8",
    "#e8710a",
    "#188038",
    "#d93025",
    "#9334e6",
    "#12b5cb",
    "#e52592",
    "#f9ab00",
    "#5f6368",
    "#a142f4",
  ]
  const APP = [
    "#ff9500",
    "#34c759",
    "#5856d6",
    "#ff2d55",
    "#007aff",
    "#af52de",
    "#ff3b30",
    "#30b0c7",
  ]
  const hash = (value: string) => [...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  const colorFor = (value: string, palette = AVATAR) =>
    palette[hash(value) % palette.length] ?? "#5f6368"

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

  /** Messages list: "9:41 AM", "Yesterday", "Tuesday", "11/2/26". */
  const iosListTime = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date(nowMs())
    if (sameDay(d, now)) return clock(d)
    const y = new Date(now)
    y.setDate(now.getDate() - 1)
    if (sameDay(d, y)) return "Yesterday"
    if (now.getTime() - d.getTime() < 6 * 864e5)
      return d.toLocaleDateString([], { weekday: "long" })
    return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" })
  }

  /** Conversation stamp: "Today 9:41 AM". */
  const iosStamp = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date(nowMs())
    if (sameDay(d, now)) return `<b>Today</b> ${clock(d)}`
    return `<b>${esc(d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))}</b> at ${clock(d)}`
  }

  const ago = (iso: string): string => {
    const s = Math.max(0, (nowMs() - Date.parse(iso)) / 1000)
    if (s < 60) return "now"
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  const androidAgo = (iso: string): string => {
    const s = Math.max(0, (nowMs() - Date.parse(iso)) / 1000)
    if (s < 60) return "now"
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  /** Timeline: "9:41:00 AM" today, "Nov 8, 1:41 PM" before. */
  const timelineTime = (iso: string): string => {
    const d = new Date(iso)
    if (sameDay(d, new Date(nowMs()))) return d.toLocaleTimeString()
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(d.getFullYear() === new Date(nowMs()).getFullYear() ? {} : { year: "numeric" }),
    })
  }

  /** Mail list: "9:41 AM" today, "Nov 9" this year, "11/9/25" before. */
  const mailDate = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date(nowMs())
    if (sameDay(d, now)) return clock(d)
    if (d.getFullYear() === now.getFullYear())
      return d.toLocaleDateString([], { month: "short", day: "numeric" })
    return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" })
  }

  const mailLongDate = (iso: string): string => {
    const d = new Date(iso)
    const full = d.toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    return `${full} (${ago(iso) === "now" ? "0 minutes ago" : ago(iso)})`
  }

  const SERVICE_LABEL: Record<string, string> = {
    twilio: "Twilio",
    resend: "Resend",
    fcm: "FCM",
    ses: "SES",
    sns: "SNS",
    customerio: "Customer.io",
    mailosaur: "Mailosaur",
    slack: "Slack",
  }

  const CHANNEL_LABEL: Record<Channel, string> = {
    sms: "SMS",
    push: "Push",
    email: "Email",
    chat: "Chat",
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  const matchesSearch = (n: Notification) => {
    const q = state.search.trim().toLowerCase()
    if (!q) return true
    return [
      n.to,
      n.from.address,
      n.from.name ?? "",
      n.preview,
      n.email?.subject ?? "",
      n.push?.title ?? "",
      n.source,
      n.service,
    ]
      .join("\n")
      .toLowerCase()
      .includes(q)
  }

  /** What the timeline lists: everything the harness has that matches the filter. */
  const visible = (): Notification[] => state.items.filter(matchesSearch)

  /** What a device shows: the same, less what the viewer cleared, archived or deleted. */
  const byChannel = (channel: Channel) =>
    visible().filter((n) => n.channel === channel && !local.dismissed.has(n.id))

  /** Recipients newest first, with counts. */
  const recipients = (channel: Channel) => {
    const map = new Map<
      string,
      { to: string; count: number; unread: number; latest: string; platform?: string }
    >()
    for (const n of byChannel(channel)) {
      const entry = map.get(n.to) ?? { to: n.to, count: 0, unread: 0, latest: n.createdAt }
      entry.count++
      if (!seen.has(n.id)) entry.unread++
      if (n.createdAt > entry.latest) entry.latest = n.createdAt
      if (n.push) entry.platform = n.push.platform
      map.set(n.to, entry)
    }
    return [...map.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1))
  }

  const ensureSelection = () => {
    for (const channel of CHANNELS) {
      const list = recipients(channel)
      const slot = state[channel]
      if (pinned?.channel === channel) {
        slot.to = pinned.to
        continue
      }
      if (!slot.to || !list.some((r) => r.to === slot.to)) slot.to = list[0]?.to ?? null
    }
  }

  const api = async <T>(path: string): Promise<T> => {
    const response = await send(path)
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return (await response.json()) as T
  }

  const refresh = async () => {
    const q = new URLSearchParams({ namespace: state.namespace, order: "newest" })
    const body = await api<{ notifications: Notification[]; version?: number }>(
      `./api/notifications?${q}`,
    )
    if (destroyed) return
    state.items = body.notifications
    state.version = body.version ?? state.version
    ensureSelection()
    render()
  }

  const refreshSources = async () => {
    try {
      const body = await api<{ sources: SourceStatus[]; discoveryError: string | null }>(
        "./api/sources",
      )
      state.sources = body.sources
      state.discoveryError = body.discoveryError
      const ns = await api<{ namespaces: string[] }>("./api/namespaces")
      state.namespaces = ns.namespaces
      if (!destroyed) renderTopbar()
    } catch {}
  }

  // ── Arrivals ─────────────────────────────────────────────────────────────────

  const threadKey = (to: string, from: string) => `${to}|${from}`
  /** The recipient `show({ channel: "sms", to })` named while they had no conversation yet. */
  let awaitedSms: string | null = null
  const groupKey = (to: string, app: string) => `${to}|${app}`

  const alertFor = (n: Notification): SoundKind | null => {
    if (n.channel === "sms") return local.muted.has(threadKey(n.to, n.from.address)) ? null : "sms"
    if (n.channel === "email") return "email"
    if (n.channel === "chat") return "chat"
    const platform =
      state.push.skin === "auto"
        ? n.push?.platform === "android"
          ? "android"
          : "ios"
        : state.push.skin
    if (platform === "android" && local.silent.has(n.push?.app ?? "App")) return null
    return platform === "android" ? "push-android" : "push-ios"
  }

  const onAdded = (added: Notification[]) => {
    for (const n of added) state.arrived.add(n.id)
    const newest = [...added].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    for (const channel of CHANNELS) {
      const mine = newest.filter((n) => n.channel === channel)
      const latest = pinned?.channel === channel ? mine.find((n) => n.to === pinned.to) : mine[0]
      if (!latest) continue
      if (pinned?.channel === channel) {
        if (channel === "sms" && !state.sms.thread) state.sms.thread = latest.from.address
      } else if (state.follow) {
        state[channel].to = latest.to
        if (channel === "sms" && state.sms.thread !== null) state.sms.thread = latest.from.address
      }
      if (channel === "push" && state.push.to === latest.to) state.push.wake = true
    }
    const awaited = awaitedSms && newest.find((n) => n.channel === "sms" && n.to === awaitedSms)
    if (awaited) {
      state.sms.to = awaited.to
      state.sms.thread = awaited.from.address
      awaitedSms = null
    }
    const kinds = new Set(added.map(alertFor).filter((k): k is SoundKind => k !== null))
    for (const kind of kinds) sound.play(kind)
    options.onArrive?.(added)
    later(1800, () => {
      for (const n of added) state.arrived.delete(n.id)
    })
  }

  // ── Event stream (server-sent events over fetch, so it works in process too) ──

  let stream: AbortController | null = null
  const connect = () => {
    stream?.abort()
    const controller = new AbortController()
    stream = controller
    const namespace = state.namespace
    const dispatch = (event: string, data: string) => {
      if (controller.signal.aborted) return
      if (event === "sources") {
        state.sources = JSON.parse(data) as SourceStatus[]
        renderTopbar()
      } else if (event === "change") {
        const { added, version } = JSON.parse(data) as { added: Notification[]; version: number }
        state.version = version
        onAdded(added)
        void refresh().catch(() => {})
      }
    }
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await send(`./api/events?namespace=${encodeURIComponent(namespace)}`, {
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          })
          if (!response.ok || !response.body) throw new Error(`events: HTTP ${response.status}`)
          state.connected = true
          renderTopbar()
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += value.replace(/\r\n/g, "\n")
            let end = buffer.indexOf("\n\n")
            while (end >= 0) {
              const chunk = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              let event = "message"
              const data: string[] = []
              for (const line of chunk.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim()
                else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
              }
              if (data.length) dispatch(event, data.join("\n"))
              end = buffer.indexOf("\n\n")
            }
          }
        } catch {}
        if (controller.signal.aborted) return
        state.connected = false
        renderTopbar()
        await new Promise((resolve) => later(1000, () => resolve(null)))
      }
    }
    void run()
  }

  // ── Chrome ───────────────────────────────────────────────────────────────────

  /** Ties each tab to its device column; unique per mount so two harnesses can share a page. */
  const uid = `mbn-${Math.random().toString(36).slice(2, 8)}`
  root.classList.add(ROOT_CLASS)
  if (options.embedded) root.classList.add("embedded")
  root.dataset.testid = TEST_IDS.app
  root.dataset.ready = "false"
  root.innerHTML = `
<header class="topbar" data-region="topbar" ${tid(TEST_IDS.topbar)}></header>
<div data-region="notice"></div>
<div class="channel-tabs" data-region="tabs" role="tablist" aria-label="Notification channels" ${tid(TEST_IDS.channelTabs)} hidden></div>
<div class="mbn-scroll" data-region="scroll">
<section class="devices" data-region="devices">
  <div class="device-col" data-region="col-sms" id="${uid}-panel-sms"></div>
  <div class="device-col" data-region="col-push" id="${uid}-panel-push"></div>
  <div class="device-col wide" data-region="col-email" id="${uid}-panel-email"></div>
  <div class="device-col wide chat-col" data-region="col-chat" id="${uid}-panel-chat"></div>
</section>
<section class="timeline" data-region="timeline" hidden></section>
</div>
<aside class="inspector" data-region="inspector" ${tid(TEST_IDS.inspector)} hidden></aside>`

  const $ = (region: string) => root.querySelector(`[data-region="${region}"]`) as HTMLElement
  const byTestId = <T extends HTMLElement = HTMLElement>(id: TestId) =>
    root.querySelector<T>(`[data-testid="${id}"]`)

  const title = () => options.title ?? root.dataset.title ?? "Notifications"

  const updateRootAttrs = () => {
    Object.assign(root.dataset, {
      view: state.view,
      namespace: state.namespace,
      count: String(state.items.length),
      version: String(state.version),
      connected: String(state.connected),
      sound: String(sound.enabled),
      motion: motion(),
      layout: compact ? "tabs" : "grid",
      tab: tab(),
    })
  }

  const renderTopbar = () => {
    updateRootAttrs()
    const bar = $("topbar")
    bar.hidden = options.chrome === false
    if (options.chrome === false) return
    const namespaces = [...new Set([...state.namespaces, state.namespace])].sort()
    const searchFocused = document.activeElement === byTestId(TEST_IDS.search)
    bar.innerHTML = `
    <div class="brand"><span class="brand-mark">${icons.bell()}</span><span class="brand-name">${esc(title())} <small>Mockingbird</small></span></div>
    <div class="field search">${icons.search("#9aa1b1", 14)}<input type="search" data-action="search" ${tid(TEST_IDS.search)} aria-label="Filter notifications" placeholder="${root.dataset.size === "phone" ? "Filter notifications…" : "Filter by recipient, sender, text…"}" value="${esc(state.search)}"></div>
    <span class="live" ${tid(TEST_IDS.connection)} data-state="${state.connected ? "live" : "reconnecting"}" role="status"><span class="dot ${state.connected ? "ok" : "bad"}"></span><span class="live-label">${state.connected ? "Live" : "Reconnecting"}</span></span>
    <button class="menu-btn" data-action="menu" ${tid(TEST_IDS.menu)} aria-expanded="${state.menu}" aria-controls="${uid}-more" aria-label="More options">${state.menu ? icons.close(18) : icons.tune(20)}</button>
    <div class="topbar-more" id="${uid}-more">
    <label class="field namespace">Namespace <select data-action="namespace" ${tid(TEST_IDS.namespace)} aria-label="Namespace">${namespaces
      .map((ns) => `<option ${ns === state.namespace ? "selected" : ""}>${esc(ns)}</option>`)
      .join("")}</select></label>
    <div class="tabs" role="group" aria-label="View">
      <button data-action="view" data-value="devices" ${tid(TEST_IDS.viewDevices)} aria-pressed="${state.view === "devices"}">Devices</button>
      <button data-action="view" data-value="timeline" ${tid(TEST_IDS.viewTimeline)} aria-pressed="${state.view === "timeline"}">Timeline <span style="opacity:.6">${state.items.length}</span></button>
    </div>
    <label class="toggle" title="Jump each device to the newest arrival"><input type="checkbox" data-action="follow" ${tid(TEST_IDS.follow)} ${state.follow ? "checked" : ""}> Follow new</label>
    <button class="icon-toggle" data-action="sound" ${tid(TEST_IDS.sound)} aria-pressed="${sound.enabled}" title="Play alert sounds on arrivals">${sound.enabled ? icons.volumeOn() : icons.volumeOff()}<span>Sound</span></button>
    <div class="sources">${state.sources
      .map(
        (s) =>
          `<span class="pill" title="${esc(s.error ?? s.url)}" ${tid(TEST_IDS.source)} data-name="${esc(s.name)}" data-service="${esc(s.service ?? "")}" data-ok="${s.ok}" data-count="${s.count}"><span class="dot ${s.ok ? "ok" : s.error ? "bad" : ""}"></span>${esc(
            s.service && s.name !== s.service
              ? `${s.name} · ${SERVICE_LABEL[s.service] ?? s.service}`
              : (SERVICE_LABEL[s.name] ?? s.name),
          )} <b>${s.count}</b></span>`,
      )
      .join("")}</div>
    </div>`
    if (searchFocused) {
      const input = byTestId<HTMLInputElement>(TEST_IDS.search)
      input?.focus()
      input?.setSelectionRange(input.value.length, input.value.length)
    }
    const failing = state.sources.filter((s) => s.error)
    $("notice").innerHTML =
      state.discoveryError || failing.length
        ? `<div class="notice" ${tid(TEST_IDS.notice)} data-kind="error" role="alert">${state.discoveryError ? `Fleet discovery failed: ${esc(state.discoveryError)}. ` : ""}${failing
            .map((s) => `<b>${esc(s.name)}</b>: ${esc(s.error)}`)
            .join(" · ")}</div>`
        : !state.sources.length
          ? `<div class="notice" ${tid(TEST_IDS.notice)} data-kind="empty" style="border-color:#3a3f4b;background:#171a21;color:#9aa1b1">No messaging emulators found yet. Start the fleet with twilio, resend, fcm, ses, sns, customerio, mailosaur or slack.</div>`
          : ""
  }

  const recipientSelect = (
    channel: Channel,
    label: string,
    testId: TestId,
    format: (to: string) => string,
  ) => {
    const list = recipients(channel)
    const current = state[channel].to
    return `<label class="field">${label}<select data-action="recipient" data-channel="${channel}" ${tid(testId)} aria-label="${label}" ${list.length ? "" : "disabled"}>${
      list.length
        ? list
            .map(
              (r) =>
                `<option value="${esc(r.to)}" ${r.to === current ? "selected" : ""}>${r.unread ? "● " : ""}${esc(format(r.to))} · ${r.count}</option>`,
            )
            .join("")
        : "<option>No recipients yet</option>"
    }</select></label>`
  }

  const countBadge = (n: number, testId: TestId) =>
    n ? `<span class="count" ${tid(testId)} data-count="${n}">${n}</span>` : ""

  /**
   * The strip above a device. Every device gets the same two fixed rows (title, then recipient),
   * so the frames below start at the same height whatever controls a device adds.
   */
  const deviceHead = (heading: string, badge: string, select: string, controls = "") =>
    `<div class="device-head"><div class="head-row"><h2>${heading} ${badge}</h2>${controls}</div>${select}</div>`

  const statusBar = (light = false) => `
  <div class="statusbar ${light ? "light" : ""}"><span>${clock(new Date(nowMs())).replace(/\s?[AP]M$/i, "")}</span>
  <span class="icons">${icons.signal()}${icons.wifi()}${icons.battery()}</span></div>`

  /** The CSS zoom on an element (`scale`, the narrow fit): its own lengths are that much smaller on screen. */
  const zoomOf = (el: Element): number =>
    (el as Element & { currentCSSZoom?: number }).currentCSSZoom || 1

  /** Animate elements with a stable `data-flip` key from where they were to where they are now. */
  const flip = (container: HTMLElement, mutate: () => void) => {
    if (!animate() || typeof container.animate !== "function") return mutate()
    const before = new Map<string, number>()
    for (const el of container.querySelectorAll<HTMLElement>("[data-flip]"))
      before.set(el.dataset.flip ?? "", el.getBoundingClientRect().top)
    mutate()
    for (const el of container.querySelectorAll<HTMLElement>("[data-flip]")) {
      const top = before.get(el.dataset.flip ?? "")
      if (top === undefined) continue
      const dy = (top - el.getBoundingClientRect().top) / zoomOf(el)
      if (Math.abs(dy) < 1) continue
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 380,
        easing: "cubic-bezier(.2,.9,.25,1)",
      })
    }
  }

  // ── SMS: Messages ────────────────────────────────────────────────────────────

  const smsThreads = (to: string) => {
    const map = new Map<string, Notification[]>()
    for (const n of byChannel("sms").filter((n) => n.to === to)) {
      const key = n.from.address
      map.set(key, [...(map.get(key) ?? []), n])
    }
    return [...map.entries()]
      .map(([from, items]) => ({
        from,
        items: items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
        pinned: local.pinned.has(threadKey(to, from)),
      }))
      .sort((a, b) =>
        a.pinned !== b.pinned
          ? a.pinned
            ? -1
            : 1
          : (a.items.at(-1)?.createdAt ?? "") < (b.items.at(-1)?.createdAt ?? "")
            ? 1
            : -1,
      )
  }

  const avatarFor = (n: Notification | undefined) => {
    const name = n ? displaySender(n) : ""
    return isPhone(bareAddress(n?.from.address ?? "")) && !n?.from.name
      ? icons.person()
      : esc(initials(name))
  }

  /** The one-time code iOS would offer above the keyboard: Verify's, or a 4–8 digit run in a code-like text. */
  const otpOf = (n: Notification): string | null =>
    n.sms?.code ??
    (/\b(code|otp|passcode|pin|verif)/i.test(n.sms?.body ?? "")
      ? (/\b(\d{4,8})\b/.exec(n.sms?.body ?? "")?.[1] ?? null)
      : null)

  const highlightCode = (escaped: string, code: string | null) =>
    code
      ? escaped.replace(new RegExp(`\\b${code}\\b`), `<span class="code">${code}</span>`)
      : escaped

  const tapbackBadge = (id: string) => {
    const t = local.tapbacks.get(id)
    const def = TAPBACKS.find((x) => x.id === t)
    return def
      ? `<span class="tapback" ${tid(TEST_IDS.smsTapback)} data-tapback="${def.id}" aria-label="${def.label}">${def.glyph}</span>`
      : ""
  }

  const bubbleBody = (n: Notification) => {
    const body = highlightCode(linkify(esc(n.sms?.body ?? "")), otpOf(n))
    const media = (n.sms?.media ?? [])
      .map((src) => `<img class="media" src="${esc(src)}" alt="" ${tid(TEST_IDS.smsBubbleMedia)}>`)
      .join("")
    return media + body
  }

  const renderSms = () => {
    const to = state.sms.to
    const threads = to ? smsThreads(to) : []
    const unreadTotal = byChannel("sms").filter((n) => !seen.has(n.id)).length
    let screen: string
    const thread = threads.find((t) => t.from === state.sms.thread)
    const transition = state.sms.transition
    state.sms.transition = null
    if (thread && to) {
      markSeen(thread.items.map((n) => n.id))
      const first = thread.items[0]
      const whatsapp = isWhatsApp(first)
      const otherUnread = threads
        .filter((t) => t !== thread)
        .reduce((s, t) => s + t.items.filter((n) => !seen.has(n.id)).length, 0)
      let last = 0
      let prevTail = true
      const rows = thread.items
        .map((n, i) => {
          const at = Date.parse(n.createdAt)
          const stamp =
            i === 0 || at - last > 15 * 60_000
              ? `<div class="stamp" ${tid(TEST_IDS.smsTimestamp)}>${i === 0 ? (whatsapp ? "WhatsApp<br>" : "Text Message<br>") : ""}${iosStamp(n.createdAt)}</div>`
              : ""
          const next = thread.items[i + 1]
          const tail = !next || Date.parse(next.createdAt) - at > 60_000
          const gap = !stamp && prevTail && i > 0
          last = at
          prevTail = tail
          const code = otpOf(n)
          return `${stamp}<div class="bubble-row ${gap ? "gap" : ""}"><div class="bubble ${tail ? "tail" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" ${nAttrs(n)} ${tid(TEST_IDS.smsBubble)} ${code ? `data-code="${esc(code)}"` : ""} data-longpress="sms-bubble" tabindex="0" aria-haspopup="menu">${bubbleBody(n)}${whatsapp ? `<span class="wa-time">${esc(clock(new Date(at)))}</span>` : ""}${tapbackBadge(n.id)}</div><span class="bubble-time" ${tid(TEST_IDS.smsBubbleTime)} aria-hidden="true">${esc(clock(new Date(at)))}</span></div>`
        })
        .join("")
      const latest = thread.items.at(-1)
      const code = latest ? otpOf(latest) : null
      const menuFor = state.sms.menu ? thread.items.find((n) => n.id === state.sms.menu) : null
      const muted = local.muted.has(threadKey(to, thread.from))
      screen = `<div class="convo ${whatsapp ? "wa" : ""} ${transition === "push" && animate() ? "enter" : ""}" ${tid(TEST_IDS.smsConversation)} data-from="${esc(thread.from)}" data-via="${whatsapp ? "whatsapp" : "sms"}">
      <div class="convo-nav"><div class="bar">
        <button class="back" data-action="sms-back" ${tid(TEST_IDS.smsBack)} aria-label="Back to Messages">${icons.chevronBack()}${otherUnread ? `<span class="badge">${otherUnread}</span>` : ""}</button>
        <div class="avatar">${avatarFor(first)}</div>
        <div class="who"><span ${tid(TEST_IDS.smsConversationTitle)}>${esc(first ? displaySender(first) : thread.from)}</span>${muted ? ` <span class="flag">${icons.bellSlash(12)}</span>` : ""} ${whatsapp ? '<small class="wa-sub">WhatsApp</small>' : icons.chevronRight("#8e8e93")}</div>
      </div></div>
      <div class="convo-body" data-swipe="sms-convo">${rows}</div>
      ${code && latest && nowMs() - Date.parse(latest.createdAt) < 10 * 60_000 ? `<button class="qt" data-action="sms-copy-code" data-code="${esc(code)}" ${tid(TEST_IDS.smsCode)}><small>From ${whatsapp ? "WhatsApp" : "Messages"}</small>${esc(code)}</button>` : ""}
      <div class="convo-input"><span class="plus">${icons.plus()}</span><span class="field-ios">${whatsapp ? "Message" : "Text Message"}<span>${icons.mic()}</span></span></div>
      ${menuFor ? smsMenu(menuFor) : ""}
    </div>`
    } else {
      state.sms.thread = null
      state.sms.menu = null
      screen = `<div class="msgs ${transition === "back" && animate() ? "enter" : ""}">
      <div class="msgs-nav"><div class="row"><span>Edit</span>${icons.compose()}</div><h1>Messages</h1>
      <div class="ios-search">${icons.search("rgba(60,60,67,.6)", 15)}<span>Search</span>${icons.mic("rgba(60,60,67,.6)")}</div></div>
      ${
        threads.length && to
          ? `<div class="threads" role="list">${threads
              .map((t) => {
                const latest = t.items.at(-1)
                const unread = t.items.some((n) => !seen.has(n.id))
                const key = threadKey(to, t.from)
                const muted = local.muted.has(key)
                const name = latest ? displaySender(latest) : t.from
                const whatsapp = isWhatsApp(latest)
                return `<div class="swipe thread-swipe" data-swipe="sms-thread" data-from="${esc(t.from)}" data-flip="thread:${esc(t.from)}" role="listitem">
            <div class="swipe-actions">
              <div class="side"><button class="act-unread" data-action="thread-unread" data-from="${esc(t.from)}" ${tid(TEST_IDS.smsThreadToggleUnread)}>${unread ? icons.markRead(22) : icons.markUnread(22)}${unread ? "Read" : "Unread"}</button><button class="act-pin" data-action="thread-pin" data-from="${esc(t.from)}" ${tid(TEST_IDS.smsThreadPin)}>${icons.pin(22)}${t.pinned ? "Unpin" : "Pin"}</button></div>
              <div class="side"><button class="act-mute" data-action="thread-mute" data-from="${esc(t.from)}" ${tid(TEST_IDS.smsThreadMute)}>${icons.bellSlash(22)}${muted ? "Show Alerts" : "Hide Alerts"}</button><button class="act-delete" data-action="thread-delete" data-from="${esc(t.from)}" ${tid(TEST_IDS.smsThreadDelete)}>${icons.trash()}Delete</button></div>
            </div>
            <div class="thread swipe-card" data-action="sms-open" data-from="${esc(t.from)}" ${tid(TEST_IDS.smsThread)} ${latest ? nAttrs(latest) : ""} data-unread="${unread}" data-pinned="${t.pinned}" data-muted="${muted}" role="button" tabindex="0" aria-label="${esc(name)}${whatsapp ? ", WhatsApp" : ""}${unread ? ", unread" : ""}">
            ${unread ? `<span class="unread" ${tid(TEST_IDS.smsThreadUnread)}></span>` : ""}<div class="avatar ${whatsapp ? "wa" : ""}">${avatarFor(latest)}</div>
            <div class="text"><div class="top"><span class="name-line"><span class="name" ${tid(TEST_IDS.smsThreadName)}>${esc(name)}</span>${whatsapp ? `<span class="via-wa" ${tid(TEST_IDS.smsThreadVia)}>WhatsApp</span>` : ""}${t.pinned ? `<span class="flag">${icons.pin(13)}</span>` : ""}${muted ? `<span class="flag">${icons.bellSlash(13)}</span>` : ""}</span><span class="when" ${tid(TEST_IDS.smsThreadTime)}>${esc(iosListTime(latest?.createdAt ?? ""))} ${icons.chevronRight()}</span></div>
            <div class="preview" ${tid(TEST_IDS.smsThreadPreview)}>${esc(latest?.sms?.body ?? "")}</div></div></div></div>`
              })
              .join("")}</div>`
          : `<div class="empty-ios" ${tid(TEST_IDS.smsEmpty)}>${to ? "No Messages" : "No text messages yet.<br><br>SMS sent through Twilio, SNS, Customer.io or Mailosaur, and WhatsApp sent through Twilio, show up here."}</div>`
      }
    </div>`
    }
    const col = $("col-sms")
    flip(col, () => {
      col.innerHTML = `
    ${deviceHead("Text messages", countBadge(unreadTotal, TEST_IDS.smsUnreadCount), recipientSelect("sms", "Phone", TEST_IDS.smsRecipient, formatPhone))}
    <div class="iphone" ${tid(TEST_IDS.smsDevice)} data-screen="${thread ? "conversation" : "threads"}" data-recipient="${esc(to ?? "")}" data-thread="${esc(thread?.from ?? "")}"${thread && isWhatsApp(thread.items[0]) ? ' data-via="whatsapp"' : ""}><div class="screen"><div class="island"></div>${statusBar()}${screen}<div class="home-indicator"></div></div></div>`
    })
    const body = col.querySelector<HTMLElement>(".convo-body")
    // Scroll to the newest message, again once the element is attached and laid out.
    const toBottom = () => {
      if (body) body.scrollTop = body.scrollHeight
    }
    toBottom()
    requestAnimationFrame(toBottom)
    renderTabs()
  }

  const smsMenu = (n: Notification) => {
    const current = local.tapbacks.get(n.id)
    return `<div class="ios-overlay" data-action="close-overlay" ${tid(TEST_IDS.smsMenu)} data-notification-id="${esc(n.id)}" role="dialog" aria-label="Message actions">
      <div class="tapback-bar" role="toolbar" aria-label="Tapback">${TAPBACKS.map(
        (t) =>
          `<button data-action="tapback" data-id="${esc(n.id)}" data-value="${t.id}" ${tid(TEST_IDS.smsMenuTapback)} data-tapback="${t.id}" aria-label="${t.label}" aria-pressed="${current === t.id}">${t.glyph}</button>`,
      ).join("")}</div>
      <div class="bubble tail">${bubbleBody(n)}</div>
      <div class="ios-menu" role="menu">
        <button role="menuitem" data-action="close-overlay">Reply</button>
        <button role="menuitem" data-action="sms-copy" data-id="${esc(n.id)}" ${tid(TEST_IDS.smsMenuCopy)}>Copy</button>
        <button role="menuitem" data-action="close-overlay">Translate</button>
        <button role="menuitem" data-action="close-overlay">More…</button>
      </div></div>`
  }

  // ── Push: lock screen / notification shade ───────────────────────────────────

  const pushData = (n: Notification) => {
    const data = n.push?.data ?? {}
    const keys = Object.keys(data)
    return keys.length
      ? `<div class="note-data" ${tid(TEST_IDS.pushNotificationData)}>${esc(JSON.stringify(data, null, 2))}</div>`
      : ""
  }

  const pushMeta = (n: Notification) =>
    `<div class="note-meta" ${tid(TEST_IDS.pushNotificationMeta)}>${esc(SERVICE_LABEL[n.service] ?? n.service)} · ${esc(n.status ?? "accepted")}${n.push?.badge !== null && n.push?.badge !== undefined ? ` · badge ${n.push.badge}` : ""}${n.push?.sound ? ` · sound ${esc(n.push.sound)}` : ""}</div>`

  const pushAttrs = (n: Notification, extra: Record<string, string | boolean> = {}) =>
    `${nAttrs(n)} ${tid(TEST_IDS.pushNotification)} data-platform="${esc(n.push?.platform ?? "unknown")}" data-app="${esc(n.push?.app ?? "App")}" ${Object.entries(
      extra,
    )
      .map(([k, v]) => `data-${k}="${esc(v)}"`)
      .join(" ")}`

  const iosCard = (
    n: Notification,
    opts: { expanded: boolean; stacked?: boolean; extra?: string },
  ) => {
    const p = n.push
    const app = p?.app ?? "App"
    const expanded = opts.expanded
    return `<div class="ios-note swipe-card ${expanded ? "expanded" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="push-toggle" data-id="${esc(n.id)}" ${pushAttrs(n, { expanded, stacked: opts.stacked ?? false })} ${opts.extra ?? ""} role="button" tabindex="0" aria-expanded="${expanded}" data-longpress="ios-note">
    <span class="app-icon" style="background:${colorFor(app, APP)}" ${tid(TEST_IDS.pushNotificationApp)} aria-label="${esc(app)}">${esc(initials(app).slice(0, 1))}</span>
    <div class="content">
      <div class="line1"><span class="title" ${tid(TEST_IDS.pushNotificationTitle)}>${esc(p?.title ?? app)}</span><span class="time" ${tid(TEST_IDS.pushNotificationTime)}>${esc(ago(n.createdAt))}</span></div>
      <div class="body" ${tid(TEST_IDS.pushNotificationBody)}>${esc(p?.body ?? "")}</div>
      ${expanded && p?.imageUrl ? `<img class="hero" src="${esc(p.imageUrl)}" alt="" ${tid(TEST_IDS.pushNotificationImage)}>` : ""}
      ${expanded ? pushData(n) + pushMeta(n) : ""}
    </div>
    ${!expanded && p?.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="" ${tid(TEST_IDS.pushNotificationImage)}>` : ""}
  </div>`
  }

  /** A lock-screen card with the swipe-left actions behind it. */
  const iosNote = (
    n: Notification,
    opts: { stacked?: boolean; hidden?: boolean; top?: boolean } = {},
  ) =>
    `<div class="swipe ios-swipe" data-swipe="ios-note" data-id="${esc(n.id)}" data-flip="note:${esc(n.id)}" ${opts.hidden ? "hidden" : ""}>
      <div class="swipe-actions"><button data-action="push-options" data-id="${esc(n.id)}" ${tid(TEST_IDS.pushOptions)}>Options</button><button data-action="push-clear" data-id="${esc(n.id)}" ${tid(TEST_IDS.pushClear)}>Clear</button></div>
      ${iosCard(n, { expanded: state.push.expanded === n.id, stacked: opts.stacked ?? false, extra: opts.top ? 'data-group-top="true"' : "" })}
    </div>`

  const androidNote = (n: Notification) => {
    const p = n.push
    const expanded = state.push.expanded === n.id
    const app = p?.app ?? "App"
    const settings = state.push.settings === n.id
    const silent = local.silent.has(app)
    return `<div class="a-note ${expanded ? "expanded" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="push-toggle" data-id="${esc(n.id)}" ${pushAttrs(n, { expanded })} data-swipe="a-note" data-longpress="a-note" data-flip="note:${esc(n.id)}" role="button" tabindex="0" aria-expanded="${expanded}">
    <span class="a-icon" style="background:${colorFor(app, APP)}" aria-hidden="true">${esc(initials(app).slice(0, 1))}</span>
    <div class="a-main">
      <div class="a-head"><span ${tid(TEST_IDS.pushNotificationApp)}>${esc(app)}</span><span>•</span><span ${tid(TEST_IDS.pushNotificationTime)}>${esc(androidAgo(n.createdAt))}</span>${silent ? `<span>${icons.bellSlash(12)}</span>` : ""}<span class="chev">${expanded ? icons.collapse() : icons.expand()}</span></div>
      ${p?.title ? `<div class="a-title" ${tid(TEST_IDS.pushNotificationTitle)}>${esc(p.title)}</div>` : ""}
      <div class="a-body" ${tid(TEST_IDS.pushNotificationBody)}>${esc(p?.body ?? "")}</div>
      ${expanded && p?.imageUrl ? `<img class="big-picture" src="${esc(p.imageUrl)}" alt="" ${tid(TEST_IDS.pushNotificationImage)}>` : ""}
      ${expanded ? pushData(n) + pushMeta(n) : ""}
      ${
        settings
          ? `<div class="a-settings" ${tid(TEST_IDS.pushSettings)} data-app="${esc(app)}">
        <button class="opt" data-action="push-alerting" data-app="${esc(app)}" data-value="alerting" aria-pressed="${!silent}">${icons.bell()}<span>Default<small>May ring or vibrate based on device settings</small></span></button>
        <button class="opt" data-action="push-alerting" data-app="${esc(app)}" data-value="silent" aria-pressed="${silent}">${icons.bellSlash(18)}<span>Silent<small>No sound or vibration</small></span></button>
        <div class="row"><button data-action="close-overlay">Turn off notifications</button><button data-action="close-overlay">Done</button></div></div>`
          : ""
      }
    </div>
    ${!expanded && p?.imageUrl ? `<img class="large-icon" src="${esc(p.imageUrl)}" alt="" ${tid(TEST_IDS.pushNotificationImage)}>` : ""}
  </div>`
  }

  /** iOS Notification Center groups each app's notifications into a stack. */
  const iosGroups = (to: string, items: Notification[]) => {
    const order: string[] = []
    const groups = new Map<string, Notification[]>()
    for (const n of items) {
      const app = n.push?.app ?? "App"
      if (!groups.has(app)) order.push(app)
      groups.set(app, [...(groups.get(app) ?? []), n])
    }
    return order
      .map((app) => {
        const list = groups.get(app) ?? []
        const first = list[0]
        if (!first) return ""
        if (list.length === 1) return iosNote(first)
        const key = groupKey(to, app)
        const open = local.openGroups.has(key)
        const rest = list.length - 1
        if (open)
          return `<div class="push-group" ${tid(TEST_IDS.pushGroup)} data-app="${esc(app)}" data-count="${list.length}" data-open="true" data-flip="group:${esc(app)}">
          <div class="group-head"><h3>${esc(app)}</h3><button data-action="group-collapse" data-key="${esc(key)}" ${tid(TEST_IDS.pushGroupCollapse)}>Show less</button><button class="x" data-action="group-clear" data-key="${esc(key)}" data-app="${esc(app)}" aria-label="Clear ${esc(app)} notifications">${icons.close(14)}</button></div>
          ${list.map((n) => iosNote(n)).join("")}</div>`
        return `<div class="push-group" ${tid(TEST_IDS.pushGroup)} data-app="${esc(app)}" data-count="${list.length}" data-open="false" data-flip="group:${esc(app)}">
          ${iosNote(first, { top: true })}
          <button class="stack-layers" data-action="group-open" data-key="${esc(key)}" ${tid(TEST_IDS.pushGroupMore)} data-count="${rest}" aria-label="Show ${rest} more notification${rest === 1 ? "" : "s"}"><div class="ios-stack-more"></div>${rest > 1 ? '<div class="ios-stack-more"></div>' : ""}<div class="center-label" style="font-size:13px;margin-top:6px">${rest} more notification${rest === 1 ? "" : "s"}</div></button>
          ${list
            .slice(1)
            .map((n) => iosNote(n, { stacked: true, hidden: true }))
            .join("")}</div>`
      })
      .join("")
  }

  const renderPush = () => {
    const to = state.push.to
    const items = to ? byChannel("push").filter((n) => n.to === to) : []
    markSeen(items.map((n) => n.id))
    const platform = items[0]?.push?.platform ?? "unknown"
    const skin =
      state.push.skin === "auto" ? (platform === "android" ? "android" : "ios") : state.push.skin
    const now = new Date(nowMs())
    const unread = byChannel("push").filter((n) => !seen.has(n.id)).length
    const wake = state.push.wake && animate()
    state.push.wake = false
    let device: string
    const deviceAttrs = `${tid(TEST_IDS.pushDevice)} data-skin="${skin}" data-recipient="${esc(to ?? "")}" data-platform="${esc(platform)}"`
    if (skin === "android") {
      device = `<div class="pixel" ${deviceAttrs}><div class="screen"><div class="punch"></div><div class="shade">
      <div class="sb"><span>${clock(now).replace(/\s?[AP]M$/i, "")}</span><span class="icons">${icons.androidWifi()}${icons.androidSignal()}${icons.androidBattery()}</span></div>
      <div class="qs-head"><span>${esc(now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))}</span>${icons.gear()}</div>
      <div class="qs"><div class="tile on">${icons.androidWifi()}<div>Internet<small>Mockingbird</small></div></div><div class="tile">${icons.bell()}<div>Do Not Disturb<small>Off</small></div></div>
      <div class="tile">${icons.androidBattery()}<div>Battery Saver<small>Off</small></div></div><div class="tile">${icons.lock()}<div>Screen lock<small>On</small></div></div></div>
      <div class="qs-bright"></div>
      <div class="shade-list" role="list">${items.length ? items.map(androidNote).join("") : `<div class="shade-empty" ${tid(TEST_IDS.pushEmpty)}>No notifications</div>`}</div>
      ${items.length ? `<div class="shade-actions"><button data-action="close-overlay">Manage</button><button data-action="push-clear-all" ${tid(TEST_IDS.pushClearAll)}>Clear all</button></div>` : ""}
      <div class="gesture"></div></div></div></div>`
    } else {
      const preview = state.push.preview ? items.find((n) => n.id === state.push.preview) : null
      device = `<div class="iphone" ${deviceAttrs}><div class="screen"><div class="island"></div>${statusBar(true)}<div class="lock ${wake ? "wake" : ""}">
      <div class="padlock">${icons.padlock()}</div>
      <div class="date">${esc(now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }))}</div>
      <div class="clock">${esc(clock(now).replace(/\s?[AP]M$/i, ""))}</div>
      <div class="lock-stack" role="list">${
        items.length && to
          ? `<div class="center-label">Notification Center</div>${iosGroups(to, items)}`
          : `<div class="lock-empty" ${tid(TEST_IDS.pushEmpty)}>${to ? "No Older Notifications" : "No push notifications yet"}</div>`
      }</div>
      <div class="lock-buttons"><span>${icons.flashlight()}</span><span>${icons.camera()}</span></div>
      ${
        preview
          ? `<div class="ios-overlay dark" data-action="close-overlay" ${tid(TEST_IDS.pushPreview)} data-notification-id="${esc(preview.id)}" role="dialog" aria-label="Notification preview">${iosCard(preview, { expanded: true })}
        <div class="ios-menu" role="menu"><button role="menuitem" data-action="push-clear" data-id="${esc(preview.id)}">Clear</button><button role="menuitem" data-action="close-overlay">Options</button></div></div>`
          : ""
      }
    </div><div class="home-indicator light"></div></div></div>`
    }
    const tokenLabel = (t: string) => {
      const r = recipients("push").find((x) => x.to === t)
      const short = t.length > 22 ? `${t.slice(0, 10)}…${t.slice(-8)}` : t
      return `${short}${r?.platform && r.platform !== "unknown" ? ` · ${r.platform}` : ""}`
    }
    const col = $("col-push")
    flip(col, () => {
      col.innerHTML = `
    ${deviceHead(
      "Push",
      countBadge(unread, TEST_IDS.pushUnreadCount),
      recipientSelect("push", "Device", TEST_IDS.pushRecipient, tokenLabel),
      `<div class="seg" role="group" aria-label="Phone">${(["auto", "ios", "android"] as const)
        .map(
          (s) =>
            `<button data-action="skin" data-value="${s}" ${tid(TEST_IDS.pushSkin)} aria-pressed="${state.push.skin === s}">${s === "auto" ? "Auto" : s === "ios" ? "iOS" : "Android"}</button>`,
        )
        .join("")}</div>`,
    )}${device}`
    })
    renderTabs()
  }

  // ── Email: web mail ──────────────────────────────────────────────────────────

  const mailHtml = (n: Notification): string => {
    const html = n.email?.html ?? ""
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`
  }

  const toast = (text: string, undo?: () => void) => {
    state.toast = undo ? { text, undo } : { text }
    renderEmail()
    const current = state.toast
    later(6000, () => {
      if (state.toast === current) {
        state.toast = null
        renderEmail()
      }
    })
  }

  const archiveEmail = (id: string, verb: "archived" | "deleted") => {
    local.dismissed.add(id)
    if (state.email.open === id) {
      state.email.open = null
      state.email.transition = true
    }
    toast(verb === "archived" ? "Conversation archived." : "Conversation moved to Trash.", () => {
      local.dismissed.delete(id)
      state.toast = null
      renderEmail()
    })
  }

  const renderEmail = () => {
    const to = state.email.to
    const items = to ? byChannel("email").filter((n) => n.to === to) : []
    const unread = items.filter((n) => !seen.has(n.id)).length
    const unreadAll = byChannel("email").filter((n) => !seen.has(n.id)).length
    const open = items.find((n) => n.id === state.email.open)
    if (!open) state.email.open = null
    const transition = state.email.transition && animate()
    state.email.transition = false
    const me = to ?? "you@example.test"
    let main: string
    if (open) {
      markSeen([open.id])
      const e = open.email
      const sender = open.from.name ?? open.from.address
      const toLine = open.to.toLowerCase() === me.toLowerCase() ? "me" : open.to
      const detail = (field: string, label: string, value: string) =>
        `<span>${label}:</span><span ${tid(TEST_IDS.emailDetail)} data-field="${field}">${esc(value)}</span>`
      main = `<div class="mail-toolbar">
        <button class="icon-btn" data-action="mail-back" ${tid(TEST_IDS.emailBack)} title="Back to Inbox" aria-label="Back to Inbox">${icons.back()}</button>
        <button class="icon-btn" data-action="mail-archive" data-id="${esc(open.id)}" ${tid(TEST_IDS.emailArchive)} title="Archive" aria-label="Archive">${icons.archive()}</button><span class="icon-btn">${icons.report()}</span><button class="icon-btn" data-action="mail-delete" data-id="${esc(open.id)}" ${tid(TEST_IDS.emailDelete)} title="Delete" aria-label="Delete">${icons.trash()}</button>
        <button class="icon-btn" data-action="mail-unread" data-id="${esc(open.id)}" ${tid(TEST_IDS.emailMarkUnread)} title="Mark as unread" aria-label="Mark as unread">${icons.markUnread()}</button><span class="icon-btn">${icons.clock()}</span><span class="icon-btn">${icons.more()}</span>
        <span class="range">${items.indexOf(open) + 1} of ${items.length}</span></div>
      <div class="reader ${transition ? "enter" : ""}" ${nAttrs(open)} ${tid(TEST_IDS.emailOpen)}>
        <div class="subject-row"><h1 ${tid(TEST_IDS.emailSubject)}>${esc(e?.subject || "(no subject)")}</h1><span class="label-chip">Inbox</span></div>
        <div class="sender-row">
          <span class="mail-avatar" style="background:${colorFor(open.from.address)}">${esc(initials(sender).slice(0, 1))}</span>
          <div class="who"><b ${tid(TEST_IDS.emailFromName)}>${esc(sender)}</b> <span class="addr">&lt;<span ${tid(TEST_IDS.emailFromAddress)}>${esc(open.from.address)}</span>&gt;</span>
            <div class="to" data-action="mail-details" ${tid(TEST_IDS.emailTo)} role="button" tabindex="0" aria-expanded="${mailDetailsOpen}">to ${esc(toLine)}${e?.cc.length ? `, ${esc(e.cc.join(", "))}` : ""} ${icons.dropdown()}</div></div>
          <div class="meta"><span ${tid(TEST_IDS.emailDate)}>${esc(mailLongDate(open.createdAt))}</span> <span class="icon-btn">${icons.star()}</span><span class="icon-btn">${icons.reply()}</span><span class="icon-btn">${icons.more()}</span></div>
        </div>
        ${
          mailDetailsOpen
            ? `<div class="details" ${tid(TEST_IDS.emailDetails)}>
          ${detail("from", "from", open.from.name ? `${open.from.name} <${open.from.address}>` : open.from.address)}
          ${detail("to", "to", open.to)}
          ${e?.cc.length ? detail("cc", "cc", e.cc.join(", ")) : ""}
          ${e?.bcc.length ? detail("bcc", "bcc", e.bcc.join(", ")) : ""}
          ${e?.replyTo.length ? detail("reply-to", "reply-to", e.replyTo.join(", ")) : ""}
          ${detail("date", "date", new Date(open.createdAt).toLocaleString())}
          ${detail("subject", "subject", e?.subject ?? "")}
          ${detail("mailed-by", "mailed-by", `${SERVICE_LABEL[open.service] ?? open.service} (${open.source})`)}
          ${detail("message-id", "message id", open.providerId)}
        </div>`
            : ""
        }
        ${e?.html ? `<iframe class="mail-frame" name="email-body" ${tid(TEST_IDS.emailBody)} data-format="html" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Email body"></iframe>` : `<div class="mail-text" ${tid(TEST_IDS.emailText)} data-format="text">${linkify(esc(e?.text ?? ""))}</div>`}
        ${
          e?.attachments.length
            ? `<div class="attachments" ${tid(TEST_IDS.emailAttachments)} data-count="${e.attachments.length}"><h3>${e.attachments.length} attachment${e.attachments.length === 1 ? "" : "s"}</h3><div class="att-grid">${e.attachments
                .map(
                  (a) =>
                    `<div class="att" ${tid(TEST_IDS.emailAttachment)} data-filename="${esc(a.filename)}" data-content-type="${esc(a.contentType ?? "")}" data-size="${a.size ?? ""}"><div class="att-top">${icons.file()}</div><div class="att-name">${icons.clip()} ${esc(a.filename)}${a.size ? ` <span style="color:#5f6368;font-weight:400">${Math.max(1, Math.round(a.size / 1024))} KB</span>` : ""}</div></div>`,
                )
                .join("")}</div></div>`
            : ""
        }
        <div class="reply-row"><span>${icons.reply()} Reply</span><span>${icons.forward()} Forward</span></div>
      </div>`
    } else {
      main = `<div class="mail-toolbar"><span class="icon-btn">${icons.checkbox()}</span><button class="icon-btn" data-action="refresh" ${tid(TEST_IDS.emailRefresh)} title="Refresh" aria-label="Refresh">${icons.refresh()}</button><span class="icon-btn">${icons.more()}</span>
        <span class="range">${items.length ? `1–${items.length} of ${items.length}` : ""}</span></div>
      <div class="cat-tabs"><div class="on">${icons.inbox()} Primary</div><div>${icons.star()} Promotions</div><div>${icons.send()} Updates</div></div>
      <div class="mail-list ${transition ? "enter" : ""}" role="list">${
        items.length
          ? items
              .map((n) => {
                const isUnread = !seen.has(n.id)
                const sender = n.from.name ?? n.from.address
                const starred = local.starred.has(n.id)
                return `<div class="swipe mrow-swipe" data-swipe="mrow" data-id="${esc(n.id)}" data-flip="row:${esc(n.id)}" role="listitem">
            <div class="swipe-actions">${icons.archive()}${icons.archive()}</div>
            <div class="mrow swipe-card ${isUnread ? "unread" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="mail-open" data-id="${esc(n.id)}" ${nAttrs(n)} ${tid(TEST_IDS.emailRow)} data-starred="${starred}" role="button" tabindex="0">
            <span class="chk" data-action="mail-check" data-id="${esc(n.id)}" role="checkbox" aria-checked="${local.checked.has(n.id)}" aria-label="Select">${icons.checkbox()}</span><span class="star" data-action="mail-star" data-id="${esc(n.id)}" ${tid(TEST_IDS.emailRowStar)} role="button" aria-pressed="${starred}" aria-label="${starred ? "Starred" : "Not starred"}">${starred ? icons.starFilled() : icons.star()}</span>
            <span class="from" ${tid(TEST_IDS.emailRowFrom)}>${esc(sender)}</span>
            <span class="subj"><span ${tid(TEST_IDS.emailRowSubject)}>${esc(n.email?.subject || "(no subject)")}</span> <span class="snippet">- <span ${tid(TEST_IDS.emailRowSnippet)}>${esc(n.preview)}</span></span></span>
            ${n.email?.attachments.length ? `<span class="clip" ${tid(TEST_IDS.emailRowAttachment)}>${icons.clip()}</span>` : ""}<span class="svc" ${tid(TEST_IDS.emailRowService)}>${esc(SERVICE_LABEL[n.service] ?? n.service)}</span>
            <span class="date" ${tid(TEST_IDS.emailRowDate)}>${esc(mailDate(n.createdAt))}</span>
            <span class="hover-actions"><button class="icon-btn" data-action="mail-archive" data-id="${esc(n.id)}" ${tid(TEST_IDS.emailRowArchive)} title="Archive" aria-label="Archive">${icons.archive()}</button><button class="icon-btn" data-action="mail-delete" data-id="${esc(n.id)}" ${tid(TEST_IDS.emailRowDelete)} title="Delete" aria-label="Delete">${icons.trash()}</button><button class="icon-btn" data-action="mail-toggle-read" data-id="${esc(n.id)}" ${tid(TEST_IDS.emailRowToggleRead)} title="${isUnread ? "Mark as read" : "Mark as unread"}" aria-label="${isUnread ? "Mark as read" : "Mark as unread"}">${isUnread ? icons.markRead() : icons.markUnread()}</button><span class="icon-btn">${icons.clock()}</span></span></div></div>`
              })
              .join("")
          : `<div class="mail-empty" ${tid(TEST_IDS.emailEmpty)}>${icons.envelope()}<b>${to ? "Your Primary tab is empty." : "No email yet"}</b>${to ? "" : "Email sent through Resend, SES, SNS, Customer.io or Mailosaur lands here."}</div>`
      }</div>`
    }
    const col = $("col-email")
    flip(col, () => {
      col.innerHTML = `
    ${deviceHead(
      "Email",
      countBadge(unreadAll, TEST_IDS.emailUnreadCount),
      recipientSelect("email", "Mailbox", TEST_IDS.emailRecipient, (t) => t),
    )}
    <div class="window" ${tid(TEST_IDS.emailDevice)} data-screen="${open ? "message" : "inbox"}" data-recipient="${esc(to ?? "")}">
      <div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="omnibox">${icons.lock()} mail.example.test/#inbox${open ? `/${esc(open.providerId)}` : ""}</span></div>
      <div class="mail-top"><span class="icon-btn">${icons.menu()}</span><span class="mail-logo">${icons.envelope()}<span class="lbl">Mail</span></span>
        <div class="mail-search"><span class="icon-btn">${icons.search("#444746", 20)}</span><span class="placeholder">Search mail</span><span class="icon-btn">${icons.tune()}</span></div>
        <div class="right"><span class="icon-btn">${icons.help()}</span><span class="icon-btn">${icons.gear()}</span><span class="icon-btn">${icons.apps()}</span>
        <span class="mail-avatar" title="${esc(me)}" style="background:${colorFor(me)}">${esc(me.slice(0, 1).toUpperCase())}</span></div></div>
      <div class="mail-body">
        <nav class="mail-nav"><button class="compose">${icons.pencil()}<span class="lbl">Compose</span></button>
          <div class="nav-item active">${icons.inbox()}<span class="lbl">Inbox</span><span class="n">${unread || ""}</span></div>
          <div class="nav-item">${icons.star()}<span class="lbl">Starred</span></div>
          <div class="nav-item">${icons.clock()}<span class="lbl">Snoozed</span></div>
          <div class="nav-item">${icons.send()}<span class="lbl">Sent</span></div>
          <div class="nav-item">${icons.draft()}<span class="lbl">Drafts</span></div>
          <div class="nav-item">${icons.expand()}<span class="lbl">More</span></div></nav>
        <main class="mail-main">${main}</main>
      </div>
      ${state.toast ? `<div class="toast" ${tid(TEST_IDS.toast)} role="status"><span>${esc(state.toast.text)}</span>${state.toast.undo ? `<button data-action="toast-undo" ${tid(TEST_IDS.toastUndo)}>Undo</button>` : ""}<button data-action="toast-close" aria-label="Dismiss">${icons.close(16)}</button></div>` : ""}
    </div>`
    })
    const frame = col.querySelector<HTMLIFrameElement>(".mail-frame")
    if (frame && open) {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument
        if (doc) frame.style.height = `${Math.max(120, doc.documentElement.scrollHeight + 8)}px`
      })
      frame.srcdoc = mailHtml(open)
    }
    updateTitle()
    renderTabs()
  }

  const unreadIn = (channel: Channel) => byChannel(channel).filter((n) => !seen.has(n.id)).length

  /** The standalone page's tab title carries the unread total, as a mail tab does. */
  const updateTitle = () => {
    if (!syncUrl || !live) return
    const total = CHANNELS.reduce((sum, c) => sum + unreadIn(c), 0)
    document.title = `${total ? `(${total}) ` : ""}${title()} · Mockingbird`
  }

  // ── Chat: team chat window ───────────────────────────────────────────────────

  /** `#alerts` as it is; an incoming webhook by the end of its path. */
  const chatLabel = (to: string): string =>
    to.startsWith("/services/") ? `Webhook …${to.slice(-6)}` : to

  const chatDay = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date(nowMs())
    if (sameDay(d, now)) return "Today"
    const y = new Date(now)
    y.setDate(now.getDate() - 1)
    if (sameDay(d, y)) return "Yesterday"
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
  }

  const chatMessage = (n: Notification) => {
    const c = n.chat
    const author = n.from.name ?? n.from.address
    const names = { name: (id: string) => c?.names?.[id] }
    // A client shows `text` only when there are no blocks; with blocks it is the fallback.
    const text =
      c?.text && !c.blocks.length
        ? `<div class="chat-text" ${tid(TEST_IDS.chatMessageText)}>${mrkdwn(c.text, names)}</div>`
        : ""
    const blocks = c?.blocks.length
      ? `<div class="chat-blocks" ${tid(TEST_IDS.chatMessageBlocks)}>${renderBlocks(c.blocks, names)}</div>`
      : ""
    const attachments = c?.attachments.length
      ? `<div class="chat-attachments" ${tid(TEST_IDS.chatMessageAttachments)}>${renderAttachments(c.attachments, names)}</div>`
      : ""
    const reactions = c?.reactions.length
      ? `<div class="chat-reactions">${c.reactions
          .map(
            (r) =>
              `<span class="chat-reaction" ${tid(TEST_IDS.chatMessageReaction)} data-name="${esc(r.name)}" data-count="${r.count}">${esc(emoji(r.name))} ${r.count}</span>`,
          )
          .join("")}</div>`
      : ""
    return `<div class="chat-msg ${state.arrived.has(n.id) ? "arrive" : ""}" ${nAttrs(n)} ${tid(TEST_IDS.chatMessage)} data-method="${esc(c?.method ?? "")}" data-ephemeral="${c?.ephemeral ?? false}" data-thread="${esc(c?.threadTs ?? "")}" role="listitem" tabindex="0">
      <span class="chat-avatar" style="background:${colorFor(n.from.address, APP)}" aria-hidden="true">${esc(initials(author))}</span>
      <div class="chat-msg-main">
        <div class="chat-meta"><b ${tid(TEST_IDS.chatMessageAuthor)}>${esc(author)}</b><span class="chat-app">APP</span><span class="chat-time" ${tid(TEST_IDS.chatMessageTime)}>${esc(clock(new Date(n.createdAt)))}</span>${c?.edited ? '<span class="chat-edited">(edited)</span>' : ""}</div>
        ${c?.ephemeral ? '<div class="chat-note">Only visible to you</div>' : ""}${c?.threadTs ? '<div class="chat-note">replied to a thread</div>' : ""}
        ${text}${blocks}${attachments}${reactions}
      </div></div>`
  }

  const renderChat = () => {
    const to = state.chat.to
    const all = byChannel("chat")
    const items = to
      ? all.filter((n) => n.to === to).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      : []
    markSeen(items.map((n) => n.id))
    const channels = recipients("chat")
    const workspace = all[0]?.chat?.workspace ?? "Workspace"
    let day = ""
    const list = items
      .map((n) => {
        const label = chatDay(n.createdAt)
        const divider =
          label === day ? "" : `<div class="chat-day"><span>${esc(label)}</span></div>`
        day = label
        return divider + chatMessage(n)
      })
      .join("")
    const col = $("col-chat")
    col.innerHTML = `
    ${deviceHead("Chat", countBadge(unreadIn("chat"), TEST_IDS.chatUnreadCount), recipientSelect("chat", "Channel", TEST_IDS.chatRecipient, chatLabel))}
    <div class="window chat" ${tid(TEST_IDS.chatDevice)} data-recipient="${esc(to ?? "")}" data-workspace="${esc(workspace)}">
      <div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="omnibox">${icons.lock()} chat.example.test/${esc(to ? chatLabel(to).replace(/^#/, "") : "")}</span></div>
      <div class="chat-body">
        <nav class="chat-side" aria-label="Channels">
          <div class="chat-team" ${tid(TEST_IDS.chatWorkspace)}>${esc(workspace)} ${icons.dropdown()}</div>
          <div class="chat-side-label">Channels</div>
          ${channels
            .map(
              (r) =>
                `<button class="chat-chan ${r.to === to ? "on" : ""} ${r.unread ? "unread" : ""}" data-action="chat-channel" data-value="${esc(r.to)}" ${tid(TEST_IDS.chatChannel)} data-to="${esc(r.to)}" data-unread="${r.unread}" aria-current="${r.to === to}"><span class="hash">${r.to.startsWith("#") ? "#" : "~"}</span><span class="lbl">${esc(chatLabel(r.to).replace(/^#/, ""))}</span>${r.unread ? `<span class="n">${r.unread}</span>` : ""}</button>`,
            )
            .join("")}
        </nav>
        <main class="chat-main">
          <header class="chat-head"><b ${tid(TEST_IDS.chatTitle)}>${esc(to ? chatLabel(to) : "Chat")}</b><span>${items.length ? `${items.length} message${items.length === 1 ? "" : "s"}` : ""}</span></header>
          <div class="chat-list" role="list">${
            list ||
            `<div class="chat-empty" ${tid(TEST_IDS.chatEmpty)}><b>${to ? "No messages in this channel" : "No chat messages yet"}</b>${to ? "" : "Messages posted to the Slack emulator, with chat.postMessage or an incoming webhook, land here."}</div>`
          }</div>
          <div class="chat-compose"><span>Message ${esc(to ? chatLabel(to) : "channel")}</span><span class="send">${icons.send()}</span></div>
        </main>
      </div>
    </div>`
    const log = col.querySelector<HTMLElement>(".chat-list")
    const toBottom = () => {
      if (log) log.scrollTop = log.scrollHeight
    }
    toBottom()
    requestAnimationFrame(toBottom)
    renderTabs()
  }

  // ── Timeline + inspector ─────────────────────────────────────────────────────

  const renderTimeline = () => {
    const items = visible()
    $("timeline").innerHTML = items.length
      ? `<table class="tl" ${tid(TEST_IDS.timeline)}><thead><tr><th>Time</th><th>Channel</th><th>Source</th><th>To</th><th>From</th><th>Content</th><th>Status</th></tr></thead><tbody>${items
          .map(
            (
              n,
            ) => `<tr data-action="inspect" data-id="${esc(n.id)}" ${nAttrs(n)} ${tid(TEST_IDS.timelineRow)} tabindex="0">
            <td class="mono" data-col="time">${esc(timelineTime(n.createdAt))}</td>
            <td data-col="channel"><span class="chan ${n.channel} ${isWhatsApp(n) ? "wa" : ""}">${isWhatsApp(n) ? "WhatsApp" : CHANNEL_LABEL[n.channel]}</span></td>
            <td data-col="source"><span class="svc-tag">${esc(SERVICE_LABEL[n.service] ?? n.service)}${n.source !== n.service ? ` · ${esc(n.source)}` : ""}</span></td>
            <td class="mono" data-col="to">${esc(n.channel === "sms" ? formatPhone(n.to) : n.channel === "chat" ? chatLabel(n.to) : n.to.length > 28 ? `${n.to.slice(0, 26)}…` : n.to)}</td>
            <td data-col="from">${esc(displaySender(n))}</td>
            <td class="content" data-col="content">${n.email ? `<b>${esc(n.email.subject)}</b> — ` : n.push?.title ? `<b>${esc(n.push.title)}</b> — ` : ""}${esc(n.channel === "email" || n.channel === "chat" ? n.preview.slice(0, 120) : (n.sms?.body ?? n.push?.body ?? n.preview))}</td>
            <td class="svc-tag" data-col="status">${esc(n.status ?? "")}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="empty-tl" ${tid(TEST_IDS.timelineEmpty)}>Nothing sent in namespace <b>${esc(state.namespace)}</b> yet.</div>`
  }

  const renderInspector = () => {
    const n = state.items.find((x) => x.id === state.inspect)
    const el = $("inspector")
    if (!n) {
      el.hidden = true
      el.innerHTML = ""
      for (const k of Object.keys(el.dataset))
        if (k !== "region" && k !== "testid") delete el.dataset[k]
      return
    }
    el.hidden = false
    Object.assign(el.dataset, {
      notificationId: n.id,
      channel: n.channel,
      service: n.service,
      source: n.source,
      to: n.to,
      from: n.from.address,
      status: n.status ?? "",
      createdAt: n.createdAt,
    })
    const { raw, ...normalized } = n
    const field = (key: string, label: string, value: string) =>
      `<span>${label}</span><span ${tid(TEST_IDS.inspectorField)} data-field="${key}">${esc(value)}</span>`
    el.innerHTML = `<header><h3 ${tid(TEST_IDS.inspectorTitle)}>${esc(isWhatsApp(n) ? "WHATSAPP" : n.channel.toUpperCase())} · ${esc(n.email?.subject ?? n.push?.title ?? n.preview.slice(0, 60))}</h3>
      <button class="btn" data-action="show-on-device" data-id="${esc(n.id)}" ${tid(TEST_IDS.inspectorShowOnDevice)}>Show on device</button><button class="btn" data-action="close-inspector" ${tid(TEST_IDS.inspectorClose)}>Close</button></header>
    <div class="kv">${field("id", "Id", n.id)}${field("providerId", "Provider id", n.providerId)}${field("service", "Service", `${n.service} (${n.source})`)}
      ${field("namespace", "Namespace", n.namespace)}${field("to", "To", n.to)}${field("from", "From", n.from.name ? `${n.from.name} <${n.from.address}>` : n.from.address)}
      ${field("createdAt", "Created", n.createdAt)}${field("status", "Status", n.status ?? "—")}</div>
    <pre ${tid(TEST_IDS.inspectorJson)}>${esc(JSON.stringify({ ...normalized, raw }, null, 2))}</pre>`
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const shown = (channel: Channel) => {
    const current = tab()
    return enabled.includes(channel) && (current === "all" || current === channel)
  }

  /** Select a channel tab ("all" = every device side by side). */
  const selectTab = (value: ChannelTab) => {
    state.only = value === "all" ? null : value
    if (value !== "all") lastTab = value
    if (syncUrl) {
      const url = new URL(location.href)
      if (value === "all") url.searchParams.delete("view")
      else url.searchParams.set("view", value)
      // A `?to=` deep link belongs to the channel it opened; it must not follow to another tab.
      for (const key of ["to", "from", "id"]) url.searchParams.delete(key)
      if (pinned?.channel === value) url.searchParams.set("to", pinned.to)
      history.replaceState(null, "", url)
    }
    render()
  }

  const tabButton = (value: ChannelTab) =>
    root.querySelector<HTMLElement>(`[data-action="tab"][data-value="${value}"]`)

  /**
   * The channel tabs. A tab whose device is not on screen keeps a count of what arrived there, so
   * nothing is missed while another device is open.
   */
  const renderTabs = () => {
    const el = $("tabs")
    const tabs = options.tabs === false ? [] : tabsFor(enabled, compact)
    el.hidden = !tabs.length || state.view !== "devices"
    for (const channel of CHANNELS) {
      const col = $(`col-${channel}`)
      if (tabs.length) {
        col.setAttribute("role", "tabpanel")
        col.setAttribute("aria-labelledby", `${uid}-tab-${channel}`)
      } else {
        col.removeAttribute("role")
        col.removeAttribute("aria-labelledby")
      }
    }
    if (el.hidden) {
      el.innerHTML = ""
      return
    }
    const current = tab()
    const focused = el.contains(document.activeElement)
      ? ((document.activeElement as HTMLElement).dataset.value as ChannelTab | undefined)
      : undefined
    el.dataset.layout = compact ? "tabs" : "grid"
    el.innerHTML = tabs
      .map((value) => {
        const selected = value === current
        const unread = value === "all" ? 0 : unreadIn(value)
        const controls =
          value === "all"
            ? enabled.map((c) => `${uid}-panel-${c}`).join(" ")
            : `${uid}-panel-${value}`
        return `<button role="tab" id="${uid}-tab-${value}" aria-selected="${selected}" aria-controls="${controls}" tabindex="${selected ? 0 : -1}" data-action="tab" data-value="${value}" ${tid(TEST_IDS.channelTab)} data-unread="${unread}">${TAB_LABELS[value]}${unread && !selected ? `<span class="tab-unread" ${tid(TEST_IDS.channelTabUnread)} aria-label="${unread} unread">${unread}</span>` : ""}</button>`
      })
      .join("")
    if (focused) tabButton(focused)?.focus()
  }

  const render = () => {
    if (destroyed) return
    renderTopbar()
    $("devices").hidden = state.view !== "devices"
    $("timeline").hidden = state.view !== "timeline"
    for (const channel of CHANNELS) $(`col-${channel}`).hidden = !shown(channel)
    $("devices").classList.toggle("solo", CHANNELS.filter(shown).length === 1)
    if (state.view === "devices") {
      if (shown("sms")) renderSms()
      if (shown("push")) renderPush()
      if (shown("email")) renderEmail()
      if (shown("chat")) renderChat()
    } else renderTimeline()
    renderTabs()
    renderInspector()
    updateTitle()
  }

  /** Bring a channel's device on screen when another tab has it hidden. */
  const reveal = (channel: Channel) => {
    if (!enabled.includes(channel)) return
    // Remembered even when every device is on screen: a host that was hidden (zero width) and
    // turns out to be narrow falls back to this tab once it is measured.
    lastTab = channel
    if (shown(channel)) return
    state.only = channel
  }

  const showOnDevice = (n: Notification) => {
    state.view = "devices"
    reveal(n.channel)
    state[n.channel].to = n.to
    if (n.channel === "sms") state.sms.thread = n.from.address
    if (n.channel === "email") state.email.open = n.id
    if (n.channel === "push") {
      state.push.expanded = n.id
      local.openGroups.add(groupKey(n.to, n.push?.app ?? "App"))
    }
    local.dismissed.delete(n.id)
    state.inspect = null
    render()
    root
      .querySelector(`.devices [data-notification-id="${CSS.escape(n.id)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }

  // ── Dismissal with motion ────────────────────────────────────────────────────

  /** Collapse an element's height to nothing, then run `then`. */
  const collapse = (el: HTMLElement, then: () => void) => {
    if (!animate()) return then()
    el.style.height = `${el.offsetHeight}px`
    el.classList.add("collapsing")
    void el.offsetHeight
    Object.assign(el.style, {
      height: "0px",
      marginTop: "0px",
      marginBottom: "0px",
      paddingTop: "0px",
      paddingBottom: "0px",
      opacity: "0",
    })
    later(270, then)
  }

  /** Slide an element out sideways and collapse its row. */
  const flyOut = (row: HTMLElement, card: HTMLElement, direction: number, then: () => void) => {
    if (!animate()) return then()
    row.classList.add("settling")
    card.classList.add("settling")
    card.style.transform = `translateX(${direction * (row.offsetWidth + 40)}px)`
    card.style.opacity = "0"
    later(230, () => collapse(row, then))
  }

  const rowFor = (selector: string) => root.querySelector<HTMLElement>(selector)
  const cardIn = (row: HTMLElement) => row.querySelector<HTMLElement>(".swipe-card") ?? row

  const dismissPush = (id: string, direction = -1) => {
    const row =
      rowFor(`.ios-swipe[data-id="${CSS.escape(id)}"]`) ??
      rowFor(`.a-note[data-id="${CSS.escape(id)}"]`)
    const done = () => {
      local.dismissed.add(id)
      if (state.push.preview === id) state.push.preview = null
      renderPush()
    }
    if (!row) return done()
    flyOut(row, cardIn(row), direction, done)
  }

  const deleteThread = (from: string) => {
    const to = state.sms.to
    if (!to) return
    const ids = byChannel("sms")
      .filter((n) => n.to === to && n.from.address === from)
      .map((n) => n.id)
    const row = rowFor(`.thread-swipe[data-from="${CSS.escape(from)}"]`)
    const done = () => {
      for (const id of ids) local.dismissed.add(id)
      renderSms()
    }
    if (!row) return done()
    flyOut(row, cardIn(row), -1, done)
  }

  const removeEmail = (id: string, verb: "archived" | "deleted", direction = -1) => {
    const row = rowFor(`.mrow-swipe[data-id="${CSS.escape(id)}"]`)
    if (!row) return archiveEmail(id, verb)
    flyOut(row, cardIn(row), direction, () => archiveEmail(id, verb))
  }

  // ── Gestures: swipe and long press (pointer events; mouse, pen and touch) ────

  type Drag = {
    pointerId: number
    x0: number
    y0: number
    t0: number
    dx: number
    axis: "x" | "y" | null
    swipe: HTMLElement | null
    press: HTMLElement | null
    base: number
    timer: ReturnType<typeof setTimeout> | null
  }
  let drag: Drag | null = null
  let suppressClick = false

  const IOS_OPEN = 160
  const THREAD_OPEN = 148

  const setOffset = (row: HTMLElement, x: number) => {
    const card = cardIn(row)
    card.style.transform = x ? `translateX(${x}px)` : ""
    if (row.dataset.swipe === "a-note")
      card.style.opacity = String(1 - Math.min(0.9, Math.abs(x) / row.offsetWidth))
  }

  const settle = (row: HTMLElement, x: number, open: boolean) => {
    row.classList.add("settling")
    row.classList.toggle("open", open)
    if (row.dataset.swipe === "a-note") row.classList.add("settling")
    setOffset(row, x)
    later(340, () => {
      row.classList.remove("settling", "swiping")
      row.dataset.offset = String(x)
    })
  }

  const longPress = (el: HTMLElement) => {
    const kind = el.dataset.longpress
    const id = el.dataset.notificationId ?? el.dataset.id ?? ""
    if (kind === "sms-bubble") {
      state.sms.menu = id
      renderSms()
      try {
        navigator.vibrate?.(10)
      } catch {}
    } else if (kind === "ios-note") {
      state.push.preview = id
      renderPush()
    } else if (kind === "a-note") {
      state.push.settings = state.push.settings === id ? null : id
      renderPush()
    }
  }

  on("pointerdown", (event) => {
    sound.unlock()
    // A gesture's own click comes before the next press. A long press redraws the element under
    // the pointer, so that click may never come; it must not swallow the next tap instead.
    suppressClick = false
    if (event.button !== 0 || !event.isPrimary) return
    const target = event.target as HTMLElement
    if (target.closest("select, input, .swipe-actions button, .ios-overlay")) return
    const swipe = target.closest<HTMLElement>("[data-swipe]")
    const press = target.closest<HTMLElement>("[data-longpress]")
    if (!swipe && !press) return
    drag = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      t0: performance.now(),
      dx: 0,
      axis: null,
      swipe,
      press,
      base: Number(swipe?.dataset.offset ?? 0),
      timer: null,
    }
    if (press) {
      const current = drag
      current.timer = setTimeout(() => {
        if (drag !== current || current.axis) return
        suppressClick = true
        drag = null
        longPress(press)
      }, 480)
    }
  })

  on("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const zoom = zoomOf(drag.swipe ?? root)
    const dx = (event.clientX - drag.x0) / zoom
    const dy = (event.clientY - drag.y0) / zoom
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y"
      if (drag.timer) clearTimeout(drag.timer)
      if (drag.axis === "x" && drag.swipe) {
        drag.swipe.classList.add("swiping")
        drag.swipe.classList.remove("settling")
        cardIn(drag.swipe).classList.remove("settling")
        try {
          drag.swipe.setPointerCapture(event.pointerId)
        } catch {}
      }
    }
    if (drag.axis !== "x" || !drag.swipe) return
    event.preventDefault()
    drag.dx = dx
    const kind = drag.swipe.dataset.swipe
    let x = drag.base + dx
    if (kind === "sms-convo") {
      const reveal = Math.max(0, Math.min(72, -dx))
      drag.swipe.style.setProperty("--reveal", `${reveal}px`)
      return
    }
    // Rubber band past the end of the actions.
    if (kind === "ios-note" && x > 0) x = x * 0.35
    if (kind === "mrow" || kind === "a-note") x = dx
    setOffset(drag.swipe, x)
  })

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const d = drag
    drag = null
    if (d.timer) clearTimeout(d.timer)
    if (d.axis !== "x" || !d.swipe) return
    suppressClick = true
    const row = d.swipe
    const kind = row.dataset.swipe
    const width = row.offsetWidth || 1
    const velocity = d.dx / Math.max(1, performance.now() - d.t0)
    const x = d.base + d.dx
    if (kind === "sms-convo") {
      row.classList.add("settling")
      row.style.setProperty("--reveal", "0px")
      later(320, () => row.classList.remove("settling"))
    } else if (kind === "ios-note") {
      const id = row.dataset.id ?? ""
      if (x < -width * 0.7 || (velocity < -1.1 && x < -60)) dismissPush(id)
      else if (x < -60) settle(row, -IOS_OPEN, true)
      else if (x > 70) {
        settle(row, 0, false)
        state.push.expanded = id
        renderPush()
      } else settle(row, 0, false)
    } else if (kind === "a-note") {
      if (Math.abs(x) > width * 0.4 || Math.abs(velocity) > 0.7)
        dismissPush(row.dataset.id ?? "", Math.sign(x) || 1)
      else settle(row, 0, false)
    } else if (kind === "sms-thread") {
      const from = row.dataset.from ?? ""
      if (x < -width * 0.6) deleteThread(from)
      else if (x < -50) settle(row, -THREAD_OPEN, true)
      else if (x > 50) settle(row, THREAD_OPEN, true)
      else settle(row, 0, false)
    } else if (kind === "mrow") {
      if (Math.abs(x) > width * 0.35 || Math.abs(velocity) > 0.8)
        removeEmail(row.dataset.id ?? "", "archived", Math.sign(x) || 1)
      else settle(row, 0, false)
    }
  }
  on("pointerup", endDrag)
  on("pointercancel", endDrag)

  on("contextmenu", (event) => {
    const press = (event.target as HTMLElement).closest<HTMLElement>("[data-longpress]")
    if (!press) return
    event.preventDefault()
    longPress(press)
  })

  // ── Clicks ───────────────────────────────────────────────────────────────────

  on(
    "click",
    (event) => {
      if (!suppressClick) return
      suppressClick = false
      event.stopPropagation()
      event.preventDefault()
    },
    true,
  )

  const closeOverlays = () => {
    const had = state.sms.menu || state.push.preview || state.push.settings
    state.sms.menu = null
    state.push.preview = null
    state.push.settings = null
    if (had) {
      renderSms()
      renderPush()
    }
    return Boolean(had)
  }

  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text).catch(() => {})
    } catch {}
  }

  on("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!target) return
    // A tap on an open swipe row closes it instead of acting.
    const openRow = target.closest<HTMLElement>(".swipe.open")
    if (openRow && target.classList.contains("swipe-card")) {
      settle(openRow, 0, false)
      return
    }
    const action = target.dataset.action
    const id = target.dataset.id ?? ""
    const from = target.dataset.from ?? ""
    const smsTo = state.sms.to ?? ""
    switch (action) {
      case "view":
        state.view = target.dataset.value === "timeline" ? "timeline" : "devices"
        state.menu = false
        render()
        break
      case "tab":
        selectTab((target.dataset.value as ChannelTab) ?? "all")
        break
      case "chat-channel":
        state.chat.to = target.dataset.value ?? null
        renderChat()
        break
      case "sound":
        handle.setSound(!sound.enabled)
        break
      case "menu":
        state.menu = !state.menu
        renderTopbar()
        break
      case "sms-open":
        state.sms.thread = from || null
        state.sms.transition = "push"
        renderSms()
        break
      case "sms-back":
        state.sms.thread = null
        state.sms.transition = "back"
        renderSms()
        break
      case "thread-delete":
        deleteThread(from)
        break
      case "thread-pin": {
        const key = threadKey(smsTo, from)
        if (!local.pinned.delete(key)) local.pinned.add(key)
        renderSms()
        break
      }
      case "thread-mute": {
        const key = threadKey(smsTo, from)
        if (!local.muted.delete(key)) local.muted.add(key)
        renderSms()
        break
      }
      case "thread-unread": {
        const items = byChannel("sms").filter((n) => n.to === smsTo && n.from.address === from)
        if (items.some((n) => !seen.has(n.id))) markSeen(items.map((n) => n.id))
        else {
          const latest = items.at(-1)
          if (latest) markUnseen([latest.id])
        }
        renderSms()
        break
      }
      case "tapback": {
        const value = target.dataset.value as Tapback
        if (local.tapbacks.get(id) === value) local.tapbacks.delete(id)
        else local.tapbacks.set(id, value)
        state.sms.menu = null
        renderSms()
        break
      }
      case "sms-copy": {
        const n = state.items.find((x) => x.id === id)
        if (n) copy(n.sms?.body ?? "")
        state.sms.menu = null
        renderSms()
        break
      }
      case "sms-copy-code":
        copy(target.dataset.code ?? "")
        break
      case "close-overlay":
        closeOverlays()
        break
      case "push-toggle": {
        if (target.dataset.groupTop === "true") {
          const n = state.items.find((x) => x.id === id)
          if (n) {
            local.openGroups.add(groupKey(n.to, n.push?.app ?? "App"))
            renderPush()
          }
          break
        }
        state.push.expanded = state.push.expanded === id ? null : id
        renderPush()
        break
      }
      case "push-clear":
        state.push.preview = null
        dismissPush(id)
        break
      case "push-options":
        state.push.preview = id
        renderPush()
        break
      case "push-alerting": {
        const app = target.dataset.app ?? "App"
        if (target.dataset.value === "silent") local.silent.add(app)
        else local.silent.delete(app)
        renderPush()
        break
      }
      case "push-clear-all": {
        const rows = [...root.querySelectorAll<HTMLElement>(".shade-list .a-note")]
        const ids = rows.map((r) => r.dataset.id ?? "")
        const done = () => {
          for (const x of ids) local.dismissed.add(x)
          renderPush()
        }
        if (!animate()) return done()
        rows.forEach((row, i) => {
          later(i * 60, () => {
            row.classList.add("settling")
            row.style.transform = `translateX(${row.offsetWidth + 40}px)`
            row.style.opacity = "0"
          })
        })
        later(rows.length * 60 + 300, done)
        break
      }
      case "group-open":
        local.openGroups.add(target.dataset.key ?? "")
        renderPush()
        break
      case "group-collapse":
        local.openGroups.delete(target.dataset.key ?? "")
        renderPush()
        break
      case "group-clear": {
        const app = target.dataset.app ?? "App"
        for (const n of byChannel("push"))
          if (n.to === state.push.to && (n.push?.app ?? "App") === app) local.dismissed.add(n.id)
        local.openGroups.delete(target.dataset.key ?? "")
        renderPush()
        break
      }
      case "skin":
        state.push.skin = (target.dataset.value as PushSkin) ?? "auto"
        renderPush()
        break
      case "mail-open":
        state.email.open = id
        state.email.transition = true
        mailDetailsOpen = false
        renderEmail()
        break
      case "mail-back":
        state.email.open = null
        state.email.transition = true
        renderEmail()
        break
      case "mail-details":
        mailDetailsOpen = !mailDetailsOpen
        renderEmail()
        break
      case "mail-archive":
        removeEmail(id, "archived")
        break
      case "mail-delete":
        removeEmail(id, "deleted")
        break
      case "mail-unread":
        markUnseen([id])
        state.email.open = null
        state.email.transition = true
        renderEmail()
        break
      case "mail-toggle-read":
        if (seen.has(id)) markUnseen([id])
        else markSeen([id])
        renderEmail()
        break
      case "mail-star":
        if (!local.starred.delete(id)) local.starred.add(id)
        renderEmail()
        break
      case "mail-check":
        if (!local.checked.delete(id)) local.checked.add(id)
        renderEmail()
        break
      case "toast-undo":
        state.toast?.undo?.()
        break
      case "toast-close":
        state.toast = null
        renderEmail()
        break
      case "refresh":
        void refresh().catch(() => {})
        break
      case "inspect":
        state.inspect = id
        renderInspector()
        break
      case "close-inspector":
        state.inspect = null
        renderInspector()
        break
      case "show-on-device": {
        const n = state.items.find((x) => x.id === id)
        if (n) showOnDevice(n)
        break
      }
    }
  })

  on("dblclick", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-notification-id]")
    if (!target || target.closest("[data-region=inspector]")) return
    state.inspect = target.dataset.notificationId ?? null
    renderInspector()
  })

  on("change", (event) => {
    const target = event.target as HTMLElement
    const action = target.dataset.action
    if (action === "namespace") handle.setNamespace((target as HTMLSelectElement).value)
    else if (action === "follow") state.follow = (target as HTMLInputElement).checked
    else if (action === "recipient") {
      const channel = target.dataset.channel as Channel
      state[channel].to = (target as HTMLSelectElement).value
      if (channel === "sms") state.sms.thread = null
      if (channel === "email") state.email.open = null
      render()
    }
  })

  on("input", (event) => {
    const target = event.target as HTMLInputElement
    if (target.dataset.action !== "search") return
    state.search = target.value
    ensureSelection()
    render()
  })

  on("keydown", (event) => {
    sound.unlock()
    const target = event.target as HTMLElement
    if (event.key === "Escape") {
      if (closeOverlays()) return
      if (state.inspect) {
        state.inspect = null
        renderInspector()
      }
      return
    }
    if (target.matches("input, select, textarea")) return
    if (target.matches('[role="tab"]')) {
      const next = moveTab(tabsFor(enabled, compact), tab(), event.key)
      if (next) {
        event.preventDefault()
        selectTab(next)
        tabButton(next)?.focus()
      }
      return
    }
    // Keyboard equivalents of the gestures.
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const press = target.closest<HTMLElement>("[data-longpress]")
      if (press) {
        event.preventDefault()
        longPress(press)
      }
      return
    }
    if (
      event.key === "Delete" ||
      event.key === "Backspace" ||
      event.key === "#" ||
      event.key === "e"
    ) {
      const id = target.dataset.id ?? ""
      if (target.matches("[data-testid=push-notification]") && event.key !== "e") {
        event.preventDefault()
        dismissPush(id)
      } else if (target.matches("[data-testid=sms-thread]") && event.key !== "e") {
        event.preventDefault()
        deleteThread(target.dataset.from ?? "")
      } else if (target.matches("[data-testid=email-row]")) {
        event.preventDefault()
        removeEmail(id, event.key === "e" ? "archived" : "deleted")
      }
      return
    }
    if (
      (event.key === "Enter" || event.key === " ") &&
      target.matches("[role=button]:not(button)")
    ) {
      event.preventDefault()
      target.click()
    }
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  const applyPins = () => {
    if (pinned) {
      state[pinned.channel].to = pinned.to
      if (pinned.channel === "sms")
        state.sms.thread = pinnedFrom ?? smsThreads(pinned.to)[0]?.from ?? null
    }
    if (pinnedId) {
      const n = state.items.find((x) => x.id === pinnedId)
      if (n) return showOnDevice(n)
    }
    render()
  }

  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    markReady = () => {
      root.dataset.ready = "true"
      resolve()
    }
  })

  const handle: AppHandle = {
    render,
    state,
    ready,
    show(target) {
      const n = target.id ? state.items.find((x) => x.id === target.id) : undefined
      if (n) return showOnDevice(n)
      if (target.channel) {
        state.view = "devices"
        reveal(target.channel)
        if (target.to) state[target.channel].to = target.to
        if (target.channel === "sms" && target.to) {
          state.sms.thread = smsThreads(target.to)[0]?.from ?? null
          // Asked for before the text was read from the emulator: open it when it lands.
          awaitedSms = state.sms.thread === null ? target.to : null
        }
        // A mailbox was asked for, not a message: land on its list, not on whatever was open.
        if (target.channel === "email") state.email.open = null
        render()
      }
    },
    setNamespace(namespace) {
      if (namespace === state.namespace) return
      state.namespace = namespace
      state.items = []
      state.sms = { ...state.sms, to: null, thread: null, menu: null }
      state.email = { ...state.email, to: null, open: null }
      state.push.to = null
      state.chat.to = null
      loadSeen()
      if (syncUrl) {
        const url = new URL(location.href)
        url.searchParams.set("namespace", namespace)
        history.replaceState(null, "", url)
      }
      if (live) {
        connect()
        void refresh().catch(() => {})
      } else render()
    },
    setSound(enabled) {
      sound.enabled = enabled
      if (enabled) sound.unlock()
      if (storage)
        try {
          localStorage.setItem(soundKey, enabled ? "1" : "0")
        } catch {}
      renderTopbar()
    },
    setScale(next) {
      if (deviceScale(next) === scale) return
      scale = deviceScale(next)
      fit()
      render()
    },
    destroy() {
      destroyed = true
      listeners.abort()
      stream?.abort()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const t of intervals) clearInterval(t)
      resizes?.disconnect()
      sound.close()
      root.innerHTML = ""
      root.classList.remove(ROOT_CLASS, "embedded")
      root.style.removeProperty("--mbn-fit")
      root.style.removeProperty("--mbn-scale")
    },
  }

  const intervals: ReturnType<typeof setInterval>[] = []

  // Follow the host element, not the window: embedded in a side panel the harness is narrow on a
  // wide screen.
  fit()
  const refit = () => {
    if (fit()) render()
  }
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(refit) : null
  if (resizes) resizes.observe(root)
  else if (typeof window !== "undefined")
    window.addEventListener("resize", refit, { signal: listeners.signal })

  if (!live) {
    state.items = [...(options.items ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    state.sources = options.sources ?? []
    state.namespaces = options.namespaces ?? []
    state.discoveryError = options.discoveryError ?? null
    state.connected = options.connected ?? true
    ensureSelection()
    applyPins()
    markReady()
    return handle
  }

  // Keep relative times and the status-bar clock current, unless the viewer is mid-gesture.
  intervals.push(
    setInterval(() => {
      if (drag || state.sms.menu || state.push.preview || state.push.settings) return
      if (state.view === "devices" && !root.querySelector(".mail-frame")) render()
      else renderTopbar()
    }, 30_000),
    setInterval(() => void refreshSources(), 5_000),
  )

  loadSeen()
  render()
  connect()
  void refreshSources()
  const boot = async () => {
    for (let attempt = 0; !destroyed; attempt++) {
      try {
        await refresh()
        applyPins()
        markReady()
        return
      } catch {
        await new Promise((resolve) =>
          later(Math.min(5000, 500 * 2 ** attempt), () => resolve(null)),
        )
      }
    }
  }
  void boot()
  return handle
}
