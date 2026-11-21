/**
 * The harness UI's state, framework-free: what the viewer has open, what they read, what arrived,
 * and every action on it. The React views (`app.tsx`) draw from it and re-render when it emits.
 *
 * Live, it reads a harness through `fetch` (a Fetch handler for an in-process harness, or HTTP)
 * and follows its event stream; otherwise it holds the notifications it is given, which is how the
 * Storybook catalog shows every state.
 */
import { CHANNELS, type Channel, type Notification, type SourceStatus } from "../model.js"
import { createSoundPlayer, type SoundKind } from "./sounds.js"
import {
  activeTab,
  type ChannelTab,
  type DeviceLayout,
  deviceScale,
  isCompact,
  isPhoneWidth,
  phoneFit,
} from "./tabs.js"
import type { AppOptions, PushSkin, Tapback, View } from "./types.js"

export type Recipient = {
  to: string
  count: number
  unread: number
  latest: string
  platform?: string
}

export type Thread = { from: string; items: Notification[]; pinned: boolean }

export const threadKey = (to: string, from: string): string => `${to}|${from}`
export const groupKey = (to: string, app: string): string => `${to}|${app}`

export type Store = ReturnType<typeof createStore>

export function createStore(options: AppOptions = {}) {
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
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }
  const intervals: ReturnType<typeof setInterval>[] = []
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
    // A view named in the link wins over `initial`; `initial` wins for the rest.
    view: (initialView === "timeline" ? "timeline" : (init.view ?? "devices")) as View,
    only: (init.only !== undefined
      ? init.only
      : (CHANNELS as readonly string[]).includes(initialView ?? "")
        ? initialView
        : null) as Channel | null,
    search: init.search ?? "",
    /** Narrow screens: whether the rest of the toolbar is open. */
    menu: init.menu ?? false,
    follow: init.follow ?? params.get("follow") !== "0",
    connected: false,
    sms: {
      to: init.sms?.to ?? null,
      thread: init.sms?.thread ?? null,
      menu: init.sms?.menu ?? null,
    },
    push: {
      to: init.push?.to ?? null,
      skin: init.push?.skin ?? ("auto" as PushSkin),
      expanded: init.push?.expanded ?? null,
      preview: init.push?.preview ?? null,
      settings: init.push?.settings ?? null,
    },
    email: { to: init.email?.to ?? null, open: init.email?.open ?? null },
    chat: { to: init.chat?.to ?? null },
    inspect: init.inspect ?? null,
    toast: (init.toast ? { text: init.toast } : null) as { text: string; undo?: () => void } | null,
    arrived: new Set<string>(options.arrived ?? []),
    mailDetailsOpen: init.mailDetailsOpen ?? false,
    ready: false,
  }

  /**
   * One-shot motion cues for the next drawing: a screen pushed or popped, a phone woken. The view
   * clears them once drawn, so a later redraw does not replay them.
   */
  const cues = {
    sms: null as "push" | "back" | null,
    email: false,
    wake: false,
  }

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
  const frame = {
    scale: deviceScale(options.scale),
    compact: layout === "tabs",
    width: 0,
    fit: 1,
    size: "wide" as "wide" | "phone",
  }
  /** The channel last picked, which a narrow layout falls back to when nothing is selected. */
  let lastTab: Channel | null = state.only
  const tab = (): ChannelTab => activeTab(enabled, frame.compact, state.only, lastTab)

  /** The host's width changed: whether the devices collapse to tabs, and how far a phone must shrink. */
  const measure = (width: number): boolean => {
    if (width <= 0) return false
    const before = `${frame.compact}|${frame.size}|${frame.fit}`
    frame.width = width
    frame.fit = phoneFit(width, frame.scale)
    frame.size = isPhoneWidth(width) ? "phone" : "wide"
    frame.compact = isCompact(
      options.tabs === false && layout === "auto" ? "grid" : layout,
      width,
      frame.scale,
    )
    return before !== `${frame.compact}|${frame.size}|${frame.fit}`
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
  const isUnread = (id: string) => !seen.has(id)

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
  const recipients = (channel: Channel): Recipient[] => {
    const map = new Map<string, Recipient>()
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

  const unreadIn = (channel: Channel) => byChannel(channel).filter((n) => !seen.has(n.id)).length

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

  const smsThreads = (to: string): Thread[] => {
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

  /** The conversation open on the phone, if its sender is still in the list. */
  const openThread = (): Thread | undefined => {
    const to = state.sms.to
    return to ? smsThreads(to).find((t) => t.from === state.sms.thread) : undefined
  }

  const pushItems = () => {
    const to = state.push.to
    return to ? byChannel("push").filter((n) => n.to === to) : []
  }

  const emailItems = () => {
    const to = state.email.to
    return to ? byChannel("email").filter((n) => n.to === to) : []
  }

  const chatItems = () => {
    const to = state.chat.to
    return to
      ? byChannel("chat")
          .filter((n) => n.to === to)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      : []
  }

  /** The skin the push device wears: the one picked, or the platform of the token's first message. */
  const pushSkin = (): "ios" | "android" => {
    if (state.push.skin !== "auto") return state.push.skin
    return pushItems()[0]?.push?.platform === "android" ? "android" : "ios"
  }

  const shown = (channel: Channel) => {
    const current = tab()
    return enabled.includes(channel) && (current === "all" || current === channel)
  }

  // ── Emitting: what is on screen is read, then the views redraw ───────────────

  const listeners = new Set<() => void>()
  let version = 0

  const title = () => options.title ?? "Notifications"

  /** The standalone page's tab title carries the unread total, as a mail tab does. */
  const updateTitle = () => {
    if (!syncUrl || !live || typeof document === "undefined") return
    const total = CHANNELS.reduce((sum, c) => sum + unreadIn(c), 0)
    document.title = `${total ? `(${total}) ` : ""}${title()} · Mockingbird`
  }

  /** Drop selections whose message is gone, and mark what the devices show as read. */
  const settle = () => {
    if (!openThread()) {
      state.sms.thread = null
      state.sms.menu = null
    }
    if (state.email.open && !emailItems().some((n) => n.id === state.email.open))
      state.email.open = null
    if (state.view !== "devices") return
    if (shown("sms")) {
      const thread = openThread()
      if (thread) markSeen(thread.items.map((n) => n.id))
    }
    if (shown("push")) markSeen(pushItems().map((n) => n.id))
    if (shown("email") && state.email.open) markSeen([state.email.open])
    if (shown("chat")) markSeen(chatItems().map((n) => n.id))
  }

  const emit = () => {
    if (destroyed) return
    settle()
    updateTitle()
    version++
    for (const listener of [...listeners]) listener()
  }

  // ── Reading the harness ──────────────────────────────────────────────────────

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
    emit()
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
      emit()
    } catch {}
  }

  // ── Arrivals ─────────────────────────────────────────────────────────────────

  /** The recipient `show({ channel: "sms", to })` named while they had no conversation yet. */
  let awaitedSms: string | null = null

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
      if (channel === "push" && state.push.to === latest.to) cues.wake = true
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
        emit()
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
          emit()
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
        emit()
        await new Promise((resolve) => later(1000, () => resolve(null)))
      }
    }
    void run()
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  /** Select a channel tab ("all" = every device side by side). */
  const selectTab = (value: ChannelTab) => {
    state.only = value === "all" ? null : value
    if (value !== "all") lastTab = value
    if (syncUrl && typeof location !== "undefined") {
      const url = new URL(location.href)
      if (value === "all") url.searchParams.delete("view")
      else url.searchParams.set("view", value)
      // A `?to=` deep link belongs to the channel it opened; it must not follow to another tab.
      for (const key of ["to", "from", "id"]) url.searchParams.delete(key)
      if (pinned?.channel === value) url.searchParams.set("to", pinned.to)
      history.replaceState(null, "", url)
    }
    emit()
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

  /** Listeners the view registers to scroll a shown notification into view after it draws. */
  let scrollTo: string | null = null

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
    scrollTo = n.id
    emit()
  }

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
    emit()
  }

  const toast = (text: string, undo?: () => void) => {
    state.toast = undo ? { text, undo } : { text }
    emit()
    const current = state.toast
    later(6000, () => {
      if (state.toast === current) {
        state.toast = null
        emit()
      }
    })
  }

  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text).catch(() => {})
    } catch {}
  }

  const find = (id: string) => state.items.find((x) => x.id === id)

  /** Every action a viewer can take. Each one updates the state and redraws. */
  const actions = {
    setView(view: View) {
      state.view = view
      state.menu = false
      emit()
    },
    selectTab,
    toggleMenu() {
      state.menu = !state.menu
      emit()
    },
    setSearch(value: string) {
      state.search = value
      ensureSelection()
      emit()
    },
    setFollow(on: boolean) {
      state.follow = on
      emit()
    },
    setRecipient(channel: Channel, to: string) {
      state[channel].to = to
      if (channel === "sms") state.sms.thread = null
      if (channel === "email") state.email.open = null
      emit()
    },
    chatChannel(to: string) {
      state.chat.to = to
      emit()
    },
    smsOpen(from: string) {
      state.sms.thread = from || null
      cues.sms = "push"
      emit()
    },
    smsBack() {
      state.sms.thread = null
      cues.sms = "back"
      emit()
    },
    deleteThread(from: string) {
      const to = state.sms.to
      if (!to) return
      for (const n of byChannel("sms"))
        if (n.to === to && n.from.address === from) local.dismissed.add(n.id)
      emit()
    },
    threadPin(from: string) {
      const key = threadKey(state.sms.to ?? "", from)
      if (!local.pinned.delete(key)) local.pinned.add(key)
      emit()
    },
    threadMute(from: string) {
      const key = threadKey(state.sms.to ?? "", from)
      if (!local.muted.delete(key)) local.muted.add(key)
      emit()
    },
    threadUnread(from: string) {
      const smsTo = state.sms.to ?? ""
      const items = byChannel("sms").filter((n) => n.to === smsTo && n.from.address === from)
      if (items.some((n) => !seen.has(n.id))) markSeen(items.map((n) => n.id))
      else {
        const latest = items.at(-1)
        if (latest) markUnseen([latest.id])
      }
      emit()
    },
    tapback(id: string, value: Tapback) {
      if (local.tapbacks.get(id) === value) local.tapbacks.delete(id)
      else local.tapbacks.set(id, value)
      state.sms.menu = null
      emit()
    },
    smsCopy(id: string) {
      const n = find(id)
      if (n) copy(n.sms?.body ?? "")
      state.sms.menu = null
      emit()
    },
    copy,
    /** Close the message menu, the push preview and the Android settings. Whether one was open. */
    closeOverlays(): boolean {
      const had = state.sms.menu || state.push.preview || state.push.settings
      state.sms.menu = null
      state.push.preview = null
      state.push.settings = null
      if (had) emit()
      return Boolean(had)
    },
    longPress(kind: string, id: string) {
      if (kind === "sms-bubble") {
        state.sms.menu = id
        try {
          navigator.vibrate?.(10)
        } catch {}
      } else if (kind === "ios-note") state.push.preview = id
      else if (kind === "a-note") state.push.settings = state.push.settings === id ? null : id
      emit()
    },
    pushToggle(id: string, groupTop = false) {
      if (groupTop) {
        const n = find(id)
        if (n) {
          local.openGroups.add(groupKey(n.to, n.push?.app ?? "App"))
          emit()
        }
        return
      }
      state.push.expanded = state.push.expanded === id ? null : id
      emit()
    },
    pushExpand(id: string) {
      state.push.expanded = id
      emit()
    },
    dismissPush(id: string) {
      local.dismissed.add(id)
      if (state.push.preview === id) state.push.preview = null
      emit()
    },
    dismissMany(ids: string[]) {
      for (const id of ids) local.dismissed.add(id)
      emit()
    },
    pushOptions(id: string) {
      state.push.preview = id
      emit()
    },
    pushAlerting(app: string, silent: boolean) {
      if (silent) local.silent.add(app)
      else local.silent.delete(app)
      emit()
    },
    groupOpen(key: string) {
      local.openGroups.add(key)
      emit()
    },
    groupCollapse(key: string) {
      local.openGroups.delete(key)
      emit()
    },
    groupClear(key: string, app: string) {
      for (const n of byChannel("push"))
        if (n.to === state.push.to && (n.push?.app ?? "App") === app) local.dismissed.add(n.id)
      local.openGroups.delete(key)
      emit()
    },
    setSkin(skin: PushSkin) {
      state.push.skin = skin
      emit()
    },
    mailOpen(id: string) {
      state.email.open = id
      cues.email = true
      state.mailDetailsOpen = false
      emit()
    },
    mailBack() {
      state.email.open = null
      cues.email = true
      emit()
    },
    mailDetails() {
      state.mailDetailsOpen = !state.mailDetailsOpen
      emit()
    },
    /** Archive or delete a message: hidden in this browser, with Undo. */
    archiveEmail(id: string, verb: "archived" | "deleted") {
      local.dismissed.add(id)
      if (state.email.open === id) {
        state.email.open = null
        cues.email = true
      }
      toast(verb === "archived" ? "Conversation archived." : "Conversation moved to Trash.", () => {
        local.dismissed.delete(id)
        state.toast = null
        emit()
      })
    },
    mailUnread(id: string) {
      markUnseen([id])
      state.email.open = null
      cues.email = true
      emit()
    },
    mailToggleRead(id: string) {
      if (seen.has(id)) markUnseen([id])
      else markSeen([id])
      emit()
    },
    mailStar(id: string) {
      if (!local.starred.delete(id)) local.starred.add(id)
      emit()
    },
    mailCheck(id: string) {
      if (!local.checked.delete(id)) local.checked.add(id)
      emit()
    },
    toastUndo() {
      state.toast?.undo?.()
    },
    toastClose() {
      state.toast = null
      emit()
    },
    refresh() {
      void refresh().catch(() => {})
    },
    inspect(id: string | null) {
      state.inspect = id
      emit()
    },
    showOnDevice(id: string) {
      const n = find(id)
      if (n) showOnDevice(n)
    },
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const markReady = () => {
    state.ready = true
    emit()
  }

  const handle = {
    show(target: { id?: string; channel?: Channel; to?: string }) {
      const n = target.id ? find(target.id) : undefined
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
        emit()
      }
    },
    setNamespace(namespace: string) {
      if (namespace === state.namespace) return
      state.namespace = namespace
      state.items = []
      state.sms = { ...state.sms, to: null, thread: null, menu: null }
      state.email = { ...state.email, to: null, open: null }
      state.push.to = null
      state.chat.to = null
      loadSeen()
      if (syncUrl && typeof location !== "undefined") {
        const url = new URL(location.href)
        url.searchParams.set("namespace", namespace)
        history.replaceState(null, "", url)
      }
      if (live) {
        connect()
        void refresh().catch(() => {})
      } else emit()
    },
    setSound(on: boolean) {
      sound.enabled = on
      if (on) sound.unlock()
      if (storage)
        try {
          localStorage.setItem(soundKey, on ? "1" : "0")
        } catch {}
      emit()
    },
    setScale(next: number) {
      if (deviceScale(next) === frame.scale) return
      frame.scale = deviceScale(next)
      const width = frame.width
      frame.width = 0
      measure(width)
      emit()
    },
  }

  /** Start reading: the event stream, the sources, and the first list. Not live: draw the fixtures. */
  const start = () => {
    if (!live) {
      state.items = [...(options.items ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      state.sources = options.sources ?? []
      state.namespaces = options.namespaces ?? []
      state.discoveryError = options.discoveryError ?? null
      state.connected = options.connected ?? true
      ensureSelection()
      applyPins()
      markReady()
      return
    }
    // Keep relative times and the status-bar clock current, unless the viewer is mid-gesture.
    intervals.push(
      setInterval(() => {
        if (gesturing() || state.sms.menu || state.push.preview || state.push.settings) return
        emit()
      }, 30_000),
      setInterval(() => void refreshSources(), 5_000),
    )
    loadSeen()
    emit()
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
  }

  /** Whether a swipe or press is under way; the view's gesture layer answers it. */
  let gesturing = () => false

  return {
    options,
    state,
    local,
    cues,
    frame,
    enabled,
    sound,
    ready,
    live,
    syncUrl,
    title,
    nowMs,
    later,
    animate,
    motion,
    tab,
    shown,
    measure,
    visible,
    byChannel,
    recipients,
    unreadIn,
    isUnread,
    smsThreads,
    openThread,
    pushItems,
    pushSkin,
    emailItems,
    chatItems,
    actions,
    handle,
    start,
    emit,
    /** For `useSyncExternalStore`. */
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion: () => version,
    /** The view drew the ready state: resolve `ready`. */
    drawnReady() {
      if (state.ready) resolveReady()
    },
    /** The notification `show` asked to scroll into view, once (the view calls this after drawing). */
    takeScrollTarget(): string | null {
      const id = scrollTo
      scrollTo = null
      return id
    },
    setGesturing(fn: () => boolean) {
      gesturing = fn
    },
    destroy() {
      destroyed = true
      stream?.abort()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const t of intervals) clearInterval(t)
      sound.close()
      listeners.clear()
    },
  }
}
