/// <reference lib="dom" />
/**
 * The harness UI. Plain DOM: each device re-renders from `state` when the harness reports a change.
 * Every rendered item carries `data-notification-id` so browser tests can find what a user sees.
 *
 * `createApp` mounts it on any element. Live, it reads the harness API; otherwise it renders the
 * notifications it is given, which is how the Storybook catalog draws every state.
 */
import type { Channel, Notification, SourceStatus } from "../model.js"
import { icons } from "./icons.js"

export type AppOptions = {
  /** Read the harness API and follow its event stream. Default true. */
  live?: boolean
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
    sms?: { to?: string | null; thread?: string | null }
    push?: { to?: string | null; skin?: PushSkin; expanded?: string | null }
    email?: { to?: string | null; open?: string | null }
  }
}

export type AppHandle = { render(): void; state: { items: Notification[] } }

export type View = "devices" | "timeline"
export type PushSkin = "auto" | "ios" | "android"

export function createApp(root: HTMLElement, options: AppOptions = {}): AppHandle {
  const live = options.live ?? true
  const fixedNow = options.now
  const nowMs = () => fixedNow ?? Date.now()

  const params = new URLSearchParams(options.search ?? (live ? location.search : ""))
  const initialView = params.get("view")

  const state = {
    namespace: params.get("namespace") ?? options.namespace ?? "default",
    namespaces: [] as string[],
    items: [] as Notification[],
    sources: [] as SourceStatus[],
    discoveryError: null as string | null,
    view: (initialView === "timeline" ? "timeline" : "devices") as View,
    only: (initialView === "sms" || initialView === "email" || initialView === "push"
      ? initialView
      : null) as Channel | null,
    search: "",
    follow: params.get("follow") !== "0",
    connected: false,
    sms: { to: null as string | null, thread: null as string | null },
    push: { to: null as string | null, skin: "auto" as PushSkin, expanded: null as string | null },
    email: { to: null as string | null, open: null as string | null },
    inspect: null as string | null,
    arrived: new Set<string>(options.arrived ?? []),
  }
  const init = options.initial ?? {}
  Object.assign(state, {
    ...init,
    sms: { ...state.sms, ...init.sms },
    push: { ...state.push, ...init.push },
    email: { ...state.email, ...init.email },
  })

  let mailDetailsOpen = options.initial?.mailDetailsOpen ?? false
  const pinnedTo = params.get("to")
  const pinnedId = params.get("id")

  // ── Read state (per namespace, per browser) ──────────────────────────────────

  const seenKey = () => `mockingbird-notifications:seen:${state.namespace}`
  let seen = new Set<string>(options.seen ?? [])
  const loadSeen = () => {
    if (!live) return
    try {
      seen = new Set(JSON.parse(localStorage.getItem(seenKey()) ?? "[]") as string[])
    } catch {
      seen = new Set()
    }
  }
  const markSeen = (ids: string[]) => {
    let changed = false
    for (const id of ids)
      if (!seen.has(id)) {
        seen.add(id)
        changed = true
      }
    if (!changed || !live) return
    try {
      localStorage.setItem(seenKey(), JSON.stringify([...seen].slice(-5000)))
    } catch {}
  }

  // ── Formatting ───────────────────────────────────────────────────────────────

  const esc = (value: unknown): string =>
    String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

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

  const displaySender = (n: Notification): string =>
    n.from.name ?? (isPhone(n.from.address) ? formatPhone(n.from.address) : n.from.address)

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
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  const visible = (): Notification[] => {
    const q = state.search.trim().toLowerCase()
    if (!q) return state.items
    return state.items.filter((n) =>
      [
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
        .includes(q),
    )
  }

  const byChannel = (channel: Channel) => visible().filter((n) => n.channel === channel)

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
    for (const channel of ["sms", "push", "email"] as const) {
      const list = recipients(channel)
      const slot = state[channel]
      if (!slot.to || !list.some((r) => r.to === slot.to)) slot.to = list[0]?.to ?? null
    }
  }

  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch(path)
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return (await response.json()) as T
  }

  const refresh = async () => {
    const q = new URLSearchParams({ namespace: state.namespace, order: "newest" })
    const body = await api<{ notifications: Notification[] }>(`./api/notifications?${q}`)
    state.items = body.notifications
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
      renderTopbar()
    } catch {}
  }

  let source: EventSource | null = null
  const connect = () => {
    source?.close()
    source = new EventSource(`./api/events?namespace=${encodeURIComponent(state.namespace)}`)
    source.addEventListener("open", () => {
      state.connected = true
      renderTopbar()
    })
    source.addEventListener("error", () => {
      state.connected = false
      renderTopbar()
    })
    source.addEventListener("sources", (event) => {
      state.sources = JSON.parse((event as MessageEvent).data) as SourceStatus[]
      renderTopbar()
    })
    source.addEventListener("change", (event) => {
      const { added } = JSON.parse((event as MessageEvent).data) as { added: Notification[] }
      for (const n of added) state.arrived.add(n.id)
      if (state.follow && added.length) {
        const newest = [...added].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        for (const channel of ["sms", "push", "email"] as const) {
          const latest = newest.find((n) => n.channel === channel)
          if (!latest) continue
          state[channel].to = latest.to
          if (channel === "sms" && state.sms.thread !== null) state.sms.thread = latest.from.address
        }
      }
      void refresh()
      setTimeout(() => {
        for (const n of added) state.arrived.delete(n.id)
      }, 1800)
    })
  }

  // ── Chrome ───────────────────────────────────────────────────────────────────

  const app = root
  app.innerHTML = `
<header class="topbar" id="topbar"></header>
<div id="notice"></div>
<section class="devices" id="devices">
  <div class="device-col" id="col-sms"></div>
  <div class="device-col" id="col-push"></div>
  <div class="device-col wide" id="col-email"></div>
</section>
<section class="timeline" id="timeline" hidden></section>
<aside class="inspector" id="inspector" hidden></aside>`

  const $ = (id: string) => root.querySelector(`#${id}`) as HTMLElement

  const renderTopbar = () => {
    const namespaces = [...new Set([...state.namespaces, state.namespace])].sort()
    const searchFocused = document.activeElement?.id === "search"
    $("topbar").innerHTML = `
    <div class="brand"><span class="brand-mark">${icons.bell()}</span><span>${esc(options.title ?? app.dataset.title ?? "Notifications")} <small>Mockingbird</small></span></div>
    <div class="field"><label for="ns">Namespace</label><select id="ns" data-testid="namespace">${namespaces
      .map((ns) => `<option ${ns === state.namespace ? "selected" : ""}>${esc(ns)}</option>`)
      .join("")}</select></div>
    <div class="field search">${icons.search("#9aa1b1", 14)}<input id="search" placeholder="Filter by recipient, sender, text…" value="${esc(state.search)}"></div>
    <div class="tabs" role="group">
      <button data-action="view" data-value="devices" aria-pressed="${state.view === "devices"}">Devices</button>
      <button data-action="view" data-value="timeline" aria-pressed="${state.view === "timeline"}">Timeline <span style="opacity:.6">${state.items.length}</span></button>
    </div>
    <label class="toggle" title="Jump each device to the newest arrival"><input type="checkbox" id="follow" ${state.follow ? "checked" : ""}> Follow new</label>
    <span class="live"><span class="dot ${state.connected ? "ok" : "bad"}"></span>${state.connected ? "Live" : "Reconnecting"}</span>
    <div class="sources">${state.sources
      .map(
        (s) =>
          `<span class="pill" title="${esc(s.error ?? s.url)}" data-testid="source-${esc(s.name)}"><span class="dot ${s.ok ? "ok" : s.error ? "bad" : ""}"></span>${esc(
            s.service && s.name !== s.service
              ? `${s.name} · ${SERVICE_LABEL[s.service] ?? s.service}`
              : (SERVICE_LABEL[s.name] ?? s.name),
          )} <b>${s.count}</b></span>`,
      )
      .join("")}</div>`
    if (searchFocused) {
      const input = $("search") as HTMLInputElement
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    const failing = state.sources.filter((s) => s.error)
    $("notice").innerHTML =
      state.discoveryError || failing.length
        ? `<div class="notice">${state.discoveryError ? `Fleet discovery failed: ${esc(state.discoveryError)}. ` : ""}${failing
            .map((s) => `<b>${esc(s.name)}</b>: ${esc(s.error)}`)
            .join(" · ")}</div>`
        : !state.sources.length
          ? `<div class="notice" style="border-color:#3a3f4b;background:#171a21;color:#9aa1b1">No messaging emulators found yet. Start the fleet with twilio, resend, fcm, ses, sns, customerio or mailosaur.</div>`
          : ""
  }

  const recipientSelect = (channel: Channel, label: string, format: (to: string) => string) => {
    const list = recipients(channel)
    const current = state[channel].to
    return `<div class="field"><label>${label}</label><select data-action="recipient" data-channel="${channel}" data-testid="${channel}-recipient" ${list.length ? "" : "disabled"}>${
      list.length
        ? list
            .map(
              (r) =>
                `<option value="${esc(r.to)}" ${r.to === current ? "selected" : ""}>${r.unread ? "● " : ""}${esc(format(r.to))} · ${r.count}</option>`,
            )
            .join("")
        : "<option>No recipients yet</option>"
    }</select></div>`
  }

  const statusBar = (light = false) => `
  <div class="statusbar ${light ? "light" : ""}"><span>${clock(new Date(nowMs())).replace(/\s?[AP]M$/i, "")}</span>
  <span class="icons">${icons.signal()}${icons.wifi()}${icons.battery()}</span></div>`

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
      }))
      .sort((a, b) =>
        (a.items.at(-1)?.createdAt ?? "") < (b.items.at(-1)?.createdAt ?? "") ? 1 : -1,
      )
  }

  const avatarFor = (n: Notification | undefined) => {
    const name = n ? displaySender(n) : ""
    return isPhone(n?.from.address ?? "") && !n?.from.name ? icons.person() : esc(initials(name))
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

  const renderSms = () => {
    const to = state.sms.to
    const threads = to ? smsThreads(to) : []
    const unreadTotal = byChannel("sms").filter((n) => !seen.has(n.id)).length
    let screen: string
    const thread = threads.find((t) => t.from === state.sms.thread)
    if (thread) {
      markSeen(thread.items.map((n) => n.id))
      const first = thread.items[0]
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
              ? `<div class="stamp">${i === 0 ? "Text Message<br>" : ""}${iosStamp(n.createdAt)}</div>`
              : ""
          const next = thread.items[i + 1]
          const tail = !next || Date.parse(next.createdAt) - at > 60_000
          const gap = !stamp && prevTail && i > 0
          last = at
          prevTail = tail
          const body = highlightCode(linkify(esc(n.sms?.body ?? "")), otpOf(n))
          const media = (n.sms?.media ?? [])
            .map((src) => `<img class="media" src="${esc(src)}" alt="">`)
            .join("")
          return `${stamp}<div class="bubble-row ${gap ? "gap" : ""}"><div class="bubble ${tail ? "tail" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-notification-id="${esc(n.id)}" data-testid="sms-bubble">${media}${body}</div></div>`
        })
        .join("")
      const latest = thread.items.at(-1)
      const code = latest ? otpOf(latest) : null
      screen = `<div class="convo">
      <div class="convo-nav"><div class="bar">
        <button class="back" data-action="sms-back" data-testid="sms-back">${icons.chevronBack()}${otherUnread ? `<span class="badge">${otherUnread}</span>` : ""}</button>
        <div class="avatar">${avatarFor(first)}</div>
        <div class="who">${esc(first ? displaySender(first) : thread.from)} ${icons.chevronRight("#8e8e93")}</div>
      </div></div>
      <div class="convo-body" id="convo-body">${rows}</div>
      ${code && latest && nowMs() - Date.parse(latest.createdAt) < 10 * 60_000 ? `<div class="qt" data-testid="sms-code"><small>From Messages</small>${esc(code)}</div>` : ""}
      <div class="convo-input"><span class="plus">${icons.plus()}</span><span class="field-ios">Text Message<span>${icons.mic()}</span></span></div>
    </div>`
    } else {
      state.sms.thread = null
      screen = `<div class="msgs">
      <div class="msgs-nav"><div class="row"><span>Edit</span>${icons.compose()}</div><h1>Messages</h1>
      <div class="ios-search">${icons.search("rgba(60,60,67,.6)", 15)}<span>Search</span>${icons.mic("rgba(60,60,67,.6)")}</div></div>
      ${
        threads.length
          ? `<div class="threads">${threads
              .map((t) => {
                const latest = t.items.at(-1)
                const unread = t.items.some((n) => !seen.has(n.id))
                return `<div class="thread" data-action="sms-open" data-from="${esc(t.from)}" data-testid="sms-thread" data-notification-id="${esc(latest?.id)}">
            ${unread ? '<span class="unread"></span>' : ""}<div class="avatar">${avatarFor(latest)}</div>
            <div class="text"><div class="top"><span class="name">${esc(latest ? displaySender(latest) : t.from)}</span><span class="when">${esc(iosListTime(latest?.createdAt ?? ""))} ${icons.chevronRight()}</span></div>
            <div class="preview">${esc(latest?.sms?.body ?? "")}</div></div></div>`
              })
              .join("")}</div>`
          : `<div class="empty-ios">${to ? "No Messages" : "No text messages yet.<br><br>SMS sent through Twilio, SNS, Customer.io or Mailosaur shows up here."}</div>`
      }
    </div>`
    }
    $("col-sms").innerHTML = `
    <div class="device-head"><h2>Text messages ${unreadTotal ? `<span class="count">${unreadTotal}</span>` : ""}</h2>${recipientSelect("sms", "Phone", formatPhone)}</div>
    <div class="iphone" data-testid="sms-device"><div class="screen"><div class="island"></div>${statusBar()}${screen}<div class="home-indicator"></div></div></div>`
    const body = root.querySelector<HTMLElement>("#convo-body")
    // Scroll to the newest message, again once the element is attached and laid out.
    const toBottom = () => {
      if (body) body.scrollTop = body.scrollHeight
    }
    toBottom()
    requestAnimationFrame(toBottom)
  }

  // ── Push: lock screen / notification shade ───────────────────────────────────

  const pushData = (n: Notification) => {
    const data = n.push?.data ?? {}
    const keys = Object.keys(data)
    return keys.length ? `<div class="note-data">${esc(JSON.stringify(data, null, 2))}</div>` : ""
  }

  const pushMeta = (n: Notification) =>
    `<div class="note-meta">${esc(SERVICE_LABEL[n.service] ?? n.service)} · ${esc(n.status ?? "accepted")}${n.push?.badge !== null && n.push?.badge !== undefined ? ` · badge ${n.push.badge}` : ""}${n.push?.sound ? ` · sound ${esc(n.push.sound)}` : ""}</div>`

  const iosNote = (n: Notification) => {
    const p = n.push
    const expanded = state.push.expanded === n.id
    const app = p?.app ?? "App"
    return `<div class="ios-note ${expanded ? "expanded" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="push-toggle" data-id="${esc(n.id)}" data-notification-id="${esc(n.id)}" data-testid="push-notification">
    <span class="app-icon" style="background:${colorFor(app, APP)}">${esc(initials(app).slice(0, 1))}</span>
    <div class="content">
      <div class="line1"><span class="title">${esc(p?.title ?? app)}</span><span class="time">${esc(ago(n.createdAt))}</span></div>
      <div class="body">${esc(p?.body ?? "")}</div>
      ${expanded && p?.imageUrl ? `<img class="hero" src="${esc(p.imageUrl)}" alt="">` : ""}
      ${expanded ? pushData(n) + pushMeta(n) : ""}
    </div>
    ${!expanded && p?.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="">` : ""}
  </div>`
  }

  const androidNote = (n: Notification) => {
    const p = n.push
    const expanded = state.push.expanded === n.id
    const app = p?.app ?? "App"
    return `<div class="a-note ${expanded ? "expanded" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="push-toggle" data-id="${esc(n.id)}" data-notification-id="${esc(n.id)}" data-testid="push-notification">
    <span class="a-icon" style="background:${colorFor(app, APP)}">${esc(initials(app).slice(0, 1))}</span>
    <div class="a-main">
      <div class="a-head"><span>${esc(app)}</span><span>•</span><span>${esc(androidAgo(n.createdAt))}</span><span class="chev">${expanded ? icons.collapse() : icons.expand()}</span></div>
      ${p?.title ? `<div class="a-title">${esc(p.title)}</div>` : ""}
      <div class="a-body">${esc(p?.body ?? "")}</div>
      ${expanded && p?.imageUrl ? `<img class="big-picture" src="${esc(p.imageUrl)}" alt="">` : ""}
      ${expanded ? pushData(n) + pushMeta(n) : ""}
    </div>
    ${!expanded && p?.imageUrl ? `<img class="large-icon" src="${esc(p.imageUrl)}" alt="">` : ""}
  </div>`
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
    let device: string
    if (skin === "android") {
      device = `<div class="pixel" data-testid="push-device" data-skin="android"><div class="screen"><div class="punch"></div><div class="shade">
      <div class="sb"><span>${clock(now).replace(/\s?[AP]M$/i, "")}</span><span class="icons">${icons.androidWifi()}${icons.androidSignal()}${icons.androidBattery()}</span></div>
      <div class="qs-head"><span>${esc(now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))}</span>${icons.gear()}</div>
      <div class="qs"><div class="tile on">${icons.androidWifi()}<div>Internet<small>Mockingbird</small></div></div><div class="tile">${icons.bell()}<div>Do Not Disturb<small>Off</small></div></div>
      <div class="tile">${icons.androidBattery()}<div>Battery Saver<small>Off</small></div></div><div class="tile">${icons.lock()}<div>Screen lock<small>On</small></div></div></div>
      <div class="qs-bright"></div>
      <div class="shade-list">${items.length ? items.map(androidNote).join("") : `<div class="shade-empty">No notifications</div>`}</div>
      ${items.length ? `<div class="shade-actions"><span>Manage</span><span>Clear all</span></div>` : ""}
      <div class="gesture"></div></div></div></div>`
    } else {
      const shown = items.length > 5 ? items.slice(0, 4) : items
      const rest = items.length - shown.length
      device = `<div class="iphone" data-testid="push-device" data-skin="ios"><div class="screen"><div class="island"></div>${statusBar(true)}<div class="lock">
      <div class="padlock">${icons.padlock()}</div>
      <div class="date">${esc(now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }))}</div>
      <div class="clock">${esc(clock(now).replace(/\s?[AP]M$/i, ""))}</div>
      <div class="lock-stack">${
        shown.length
          ? `<div class="center-label">Notification Center</div>${shown.map(iosNote).join("")}${
              rest > 0
                ? `<div class="ios-stack-more"></div><div class="ios-stack-more"></div><div class="center-label" style="font-size:13px">${rest} more notification${rest === 1 ? "" : "s"}</div>`
                : ""
            }`
          : `<div class="lock-empty">${to ? "No Older Notifications" : "No push notifications yet"}</div>`
      }</div>
      <div class="lock-buttons"><span>${icons.flashlight()}</span><span>${icons.camera()}</span></div>
    </div><div class="home-indicator light"></div></div></div>`
    }
    const tokenLabel = (t: string) => {
      const r = recipients("push").find((x) => x.to === t)
      const short = t.length > 22 ? `${t.slice(0, 10)}…${t.slice(-8)}` : t
      return `${short}${r?.platform && r.platform !== "unknown" ? ` · ${r.platform}` : ""}`
    }
    $("col-push").innerHTML = `
    <div class="device-head"><h2>Push ${unread ? `<span class="count">${unread}</span>` : ""}</h2>
      <div class="controls">${recipientSelect("push", "Device", tokenLabel)}
      <div class="seg" role="group">${(["auto", "ios", "android"] as const)
        .map(
          (s) =>
            `<button data-action="skin" data-value="${s}" aria-pressed="${state.push.skin === s}">${s === "auto" ? "Auto" : s === "ios" ? "iOS" : "Android"}</button>`,
        )
        .join("")}</div></div></div>${device}`
  }

  // ── Email: web mail ──────────────────────────────────────────────────────────

  const mailHtml = (n: Notification): string => {
    const html = n.email?.html ?? ""
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`
  }

  const renderEmail = () => {
    const to = state.email.to
    const items = to ? byChannel("email").filter((n) => n.to === to) : []
    const unread = items.filter((n) => !seen.has(n.id)).length
    const unreadAll = byChannel("email").filter((n) => !seen.has(n.id)).length
    const open = items.find((n) => n.id === state.email.open)
    if (!open) state.email.open = null
    const me = to ?? "you@example.test"
    let main: string
    if (open) {
      markSeen([open.id])
      const e = open.email
      const sender = open.from.name ?? open.from.address
      const toLine = open.to.toLowerCase() === me.toLowerCase() ? "me" : open.to
      main = `<div class="mail-toolbar">
        <button class="icon-btn" data-action="mail-back" data-testid="email-back" title="Back to Inbox">${icons.back()}</button>
        <span class="icon-btn">${icons.archive()}</span><span class="icon-btn">${icons.report()}</span><span class="icon-btn">${icons.trash()}</span>
        <span class="icon-btn">${icons.inbox()}</span><span class="icon-btn">${icons.clock()}</span><span class="icon-btn">${icons.more()}</span>
        <span class="range">${items.indexOf(open) + 1} of ${items.length}</span></div>
      <div class="reader" data-notification-id="${esc(open.id)}" data-testid="email-open">
        <div class="subject-row"><h1 data-testid="email-subject">${esc(e?.subject || "(no subject)")}</h1><span class="label-chip">Inbox</span></div>
        <div class="sender-row">
          <span class="mail-avatar" style="background:${colorFor(open.from.address)}">${esc(initials(sender).slice(0, 1))}</span>
          <div class="who"><b>${esc(sender)}</b> <span class="addr">&lt;${esc(open.from.address)}&gt;</span>
            <div class="to" data-action="mail-details">to ${esc(toLine)}${e?.cc.length ? `, ${esc(e.cc.join(", "))}` : ""} ${icons.dropdown()}</div></div>
          <div class="meta">${esc(mailLongDate(open.createdAt))} <span class="icon-btn">${icons.star()}</span><span class="icon-btn">${icons.reply()}</span><span class="icon-btn">${icons.more()}</span></div>
        </div>
        ${
          mailDetailsOpen
            ? `<div class="details">
          <span>from:</span><span>${esc(open.from.name ? `${open.from.name} <${open.from.address}>` : open.from.address)}</span>
          <span>to:</span><span>${esc(open.to)}</span>
          ${e?.cc.length ? `<span>cc:</span><span>${esc(e.cc.join(", "))}</span>` : ""}
          ${e?.bcc.length ? `<span>bcc:</span><span>${esc(e.bcc.join(", "))}</span>` : ""}
          ${e?.replyTo.length ? `<span>reply-to:</span><span>${esc(e.replyTo.join(", "))}</span>` : ""}
          <span>date:</span><span>${esc(new Date(open.createdAt).toLocaleString())}</span>
          <span>subject:</span><span>${esc(e?.subject ?? "")}</span>
          <span>mailed-by:</span><span>${esc(SERVICE_LABEL[open.service] ?? open.service)} (${esc(open.source)})</span>
          <span>message id:</span><span>${esc(open.providerId)}</span>
        </div>`
            : ""
        }
        ${e?.html ? `<iframe class="mail-frame" id="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Email body"></iframe>` : `<div class="mail-text" data-testid="email-text">${linkify(esc(e?.text ?? ""))}</div>`}
        ${
          e?.attachments.length
            ? `<div class="attachments"><h3>${e.attachments.length} attachment${e.attachments.length === 1 ? "" : "s"}</h3><div class="att-grid">${e.attachments
                .map(
                  (a) =>
                    `<div class="att"><div class="att-top">${icons.file()}</div><div class="att-name">${icons.clip()} ${esc(a.filename)}${a.size ? ` <span style="color:#5f6368;font-weight:400">${Math.max(1, Math.round(a.size / 1024))} KB</span>` : ""}</div></div>`,
                )
                .join("")}</div></div>`
            : ""
        }
        <div class="reply-row"><span>${icons.reply()} Reply</span><span>${icons.forward()} Forward</span></div>
      </div>`
    } else {
      main = `<div class="mail-toolbar"><span class="icon-btn">${icons.checkbox()}</span><button class="icon-btn" data-action="refresh" title="Refresh">${icons.refresh()}</button><span class="icon-btn">${icons.more()}</span>
        <span class="range">${items.length ? `1–${items.length} of ${items.length}` : ""}</span></div>
      <div class="cat-tabs"><div class="on">${icons.inbox()} Primary</div><div>${icons.star()} Promotions</div><div>${icons.send()} Updates</div></div>
      <div class="mail-list">${
        items.length
          ? items
              .map((n) => {
                const isUnread = !seen.has(n.id)
                const sender = n.from.name ?? n.from.address
                return `<div class="mrow ${isUnread ? "unread" : ""} ${state.arrived.has(n.id) ? "arrive" : ""}" data-action="mail-open" data-id="${esc(n.id)}" data-notification-id="${esc(n.id)}" data-testid="email-row">
            <span class="chk">${icons.checkbox()}</span><span class="star">${icons.star()}</span>
            <span class="from">${esc(sender)}</span>
            <span class="subj">${esc(n.email?.subject || "(no subject)")} <span class="snippet">- ${esc(n.preview)}</span></span>
            ${n.email?.attachments.length ? `<span class="clip">${icons.clip()}</span>` : ""}<span class="svc">${esc(SERVICE_LABEL[n.service] ?? n.service)}</span>
            <span class="date">${esc(mailDate(n.createdAt))}</span></div>`
              })
              .join("")
          : `<div class="mail-empty">${icons.envelope()}<b>${to ? "Your Primary tab is empty." : "No email yet"}</b>${to ? "" : "Email sent through Resend, SES, SNS, Customer.io or Mailosaur lands here."}</div>`
      }</div>`
    }
    $("col-email").innerHTML = `
    <div class="device-head"><h2>Email ${unreadAll ? `<span class="count">${unreadAll}</span>` : ""}</h2>${recipientSelect("email", "Mailbox", (t) => t)}</div>
    <div class="window" data-testid="email-device">
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
    </div>`
    const frame = root.querySelector<HTMLIFrameElement>("#mail-frame")
    if (frame && open) {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument
        if (doc) frame.style.height = `${Math.max(120, doc.documentElement.scrollHeight + 8)}px`
      })
      frame.srcdoc = mailHtml(open)
    }
  }
  // ── Timeline + inspector ─────────────────────────────────────────────────────

  const renderTimeline = () => {
    const items = visible()
    $("timeline").innerHTML = items.length
      ? `<table class="tl" data-testid="timeline"><thead><tr><th>Time</th><th>Channel</th><th>Source</th><th>To</th><th>From</th><th>Content</th><th>Status</th></tr></thead><tbody>${items
          .map(
            (
              n,
            ) => `<tr data-action="inspect" data-id="${esc(n.id)}" data-notification-id="${esc(n.id)}">
            <td class="mono">${esc(timelineTime(n.createdAt))}</td>
            <td><span class="chan ${n.channel}">${n.channel === "sms" ? "SMS" : n.channel === "email" ? "Email" : "Push"}</span></td>
            <td><span class="svc-tag">${esc(SERVICE_LABEL[n.service] ?? n.service)}${n.source !== n.service ? ` · ${esc(n.source)}` : ""}</span></td>
            <td class="mono">${esc(n.channel === "sms" ? formatPhone(n.to) : n.to.length > 28 ? `${n.to.slice(0, 26)}…` : n.to)}</td>
            <td>${esc(displaySender(n))}</td>
            <td class="content">${n.email ? `<b>${esc(n.email.subject)}</b> — ` : n.push?.title ? `<b>${esc(n.push.title)}</b> — ` : ""}${esc(n.channel === "email" ? n.preview.slice(0, 120) : (n.sms?.body ?? n.push?.body ?? n.preview))}</td>
            <td class="svc-tag">${esc(n.status ?? "")}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="empty-tl">Nothing sent in namespace <b>${esc(state.namespace)}</b> yet.</div>`
  }

  const renderInspector = () => {
    const n = state.items.find((x) => x.id === state.inspect)
    const el = $("inspector")
    if (!n) {
      el.hidden = true
      return
    }
    el.hidden = false
    const { raw, ...normalized } = n
    el.innerHTML = `<header><h3>${esc(n.channel.toUpperCase())} · ${esc(n.email?.subject ?? n.push?.title ?? n.preview.slice(0, 60))}</h3>
      <button class="btn" data-action="show-on-device" data-id="${esc(n.id)}">Show on device</button><button class="btn" data-action="close-inspector">Close</button></header>
    <div class="kv"><span>Id</span><span>${esc(n.id)}</span><span>Provider id</span><span>${esc(n.providerId)}</span><span>Service</span><span>${esc(n.service)} (${esc(n.source)})</span>
      <span>Namespace</span><span>${esc(n.namespace)}</span><span>To</span><span>${esc(n.to)}</span><span>From</span><span>${esc(n.from.name ? `${n.from.name} <${n.from.address}>` : n.from.address)}</span>
      <span>Created</span><span>${esc(n.createdAt)}</span><span>Status</span><span>${esc(n.status ?? "—")}</span></div>
    <pre>${esc(JSON.stringify({ ...normalized, raw }, null, 2))}</pre>`
  }

  // ── Render + events ──────────────────────────────────────────────────────────

  const render = () => {
    renderTopbar()
    $("devices").hidden = state.view !== "devices"
    $("timeline").hidden = state.view !== "timeline"
    $("col-sms").hidden = state.only !== null && state.only !== "sms"
    $("col-push").hidden = state.only !== null && state.only !== "push"
    $("col-email").hidden = state.only !== null && state.only !== "email"
    if (state.view === "devices") {
      renderSms()
      renderPush()
      renderEmail()
    } else renderTimeline()
    renderInspector()
  }

  const showOnDevice = (n: Notification) => {
    state.view = "devices"
    state[n.channel].to = n.to
    if (n.channel === "sms") state.sms.thread = n.from.address
    if (n.channel === "email") state.email.open = n.id
    if (n.channel === "push") state.push.expanded = n.id
    state.inspect = null
    render()
    root
      .querySelector(`[data-notification-id="${CSS.escape(n.id)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!target) return
    const action = target.dataset.action
    const id = target.dataset.id ?? ""
    if (action === "view") {
      state.view = target.dataset.value === "timeline" ? "timeline" : "devices"
      render()
    } else if (action === "sms-open") {
      state.sms.thread = target.dataset.from ?? null
      renderSms()
    } else if (action === "sms-back") {
      state.sms.thread = null
      renderSms()
    } else if (action === "push-toggle") {
      state.push.expanded = state.push.expanded === id ? null : id
      renderPush()
    } else if (action === "skin") {
      state.push.skin = (target.dataset.value as PushSkin) ?? "auto"
      renderPush()
    } else if (action === "mail-open") {
      state.email.open = id
      mailDetailsOpen = false
      renderEmail()
    } else if (action === "mail-back") {
      state.email.open = null
      renderEmail()
    } else if (action === "mail-details") {
      mailDetailsOpen = !mailDetailsOpen
      renderEmail()
    } else if (action === "refresh") void refresh()
    else if (action === "inspect") {
      state.inspect = id
      renderInspector()
    } else if (action === "close-inspector") {
      state.inspect = null
      renderInspector()
    } else if (action === "show-on-device") {
      const n = state.items.find((x) => x.id === id)
      if (n) showOnDevice(n)
    }
  })

  root.addEventListener("dblclick", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-notification-id]")
    if (!target) return
    state.inspect = target.dataset.notificationId ?? null
    renderInspector()
  })

  root.addEventListener("change", (event) => {
    const target = event.target as HTMLElement
    if (target.id === "ns") {
      state.namespace = (target as HTMLSelectElement).value
      state.items = []
      state.sms = { to: null, thread: null }
      state.email = { to: null, open: null }
      state.push.to = null
      loadSeen()
      const url = new URL(location.href)
      url.searchParams.set("namespace", state.namespace)
      history.replaceState(null, "", url)
      connect()
      void refresh()
    } else if (target.id === "follow") {
      state.follow = (target as HTMLInputElement).checked
    } else if (target.dataset.action === "recipient") {
      const channel = target.dataset.channel as Channel
      state[channel].to = (target as HTMLSelectElement).value
      if (channel === "sms") state.sms.thread = null
      if (channel === "email") state.email.open = null
      render()
    }
  })

  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement
    if (target.id !== "search") return
    state.search = target.value
    ensureSelection()
    render()
  })

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.inspect) {
      state.inspect = null
      renderInspector()
    }
  })

  const applyPins = () => {
    if (pinnedTo && state.only) {
      state[state.only].to = pinnedTo
      if (state.only === "sms") state.sms.thread = smsThreads(pinnedTo)[0]?.from ?? null
    }
    if (pinnedId) {
      const n = state.items.find((x) => x.id === pinnedId)
      if (n) return showOnDevice(n)
    }
    render()
  }

  if (!live) {
    state.items = [...(options.items ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    state.sources = options.sources ?? []
    state.namespaces = options.namespaces ?? []
    state.discoveryError = options.discoveryError ?? null
    state.connected = options.connected ?? true
    ensureSelection()
    applyPins()
    return { render, state }
  }

  // Keep relative times and the status-bar clock current.
  setInterval(() => {
    if (state.view === "devices" && !root.querySelector(".mail-frame")) render()
    else renderTopbar()
  }, 30_000)
  setInterval(refreshSources, 5_000)

  loadSeen()
  connect()
  void refreshSources()
  void refresh().then(applyPins)
  return { render, state }
}
