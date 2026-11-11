/**
 * The landing page's live notifications demo, loaded only when its section nears the viewport
 * (`../notificationsIsland.ts`). It boots the Twilio, Resend, FCM and Slack emulators in this tab,
 * points the notifications harness at them, and mounts the harness's own UI. The buttons call the
 * emulators' vendor APIs; the devices show what the harness read back.
 */
import { loaders } from "virtual:mockingbird/runtimes"
import { createNotificationHarness, type Notification } from "@crvouga/mockingbird-notifications"
import { type AppHandle, mountNotifications } from "@crvouga/mockingbird-notifications/ui"
import {
  CHECKOUT_STEPS,
  createNotificationsDemo,
  DEMO_ACTIONS,
  type DemoAction,
  type DemoCall,
  type DemoRuntimes,
} from "./actions.ts"
import { deviceLayout, sameLayout } from "./layout.ts"

const SERVICE_LABELS: Record<keyof DemoRuntimes, string> = {
  twilio: "Twilio",
  resend: "Resend",
  fcm: "FCM",
  slack: "Slack",
}

/** What plays unprompted, in order, then again from the start until `AUTOPLAY_LIMIT`. */
const AUTOPLAY: readonly DemoAction[] = ["code", "email", "push", "chat", "whatsapp"]
const AUTOPLAY_LIMIT = 10
const AUTOPLAY_FIRST_MS = 500
const AUTOPLAY_EVERY_MS = 2200

const createRuntimes = async (): Promise<DemoRuntimes> => {
  const names = ["twilio", "resend", "fcm", "slack"] as const
  const modules = await Promise.all(
    names.map((name) => {
      const load = loaders[name]
      if (!load) throw new Error(`no ${name} emulator`)
      return load()
    }),
  )
  return Object.fromEntries(
    names.map((name, i) => [name, modules[i].createRuntime()]),
  ) as DemoRuntimes
}

/** Boot the demo inside `root` (`NotificationsDemo.astro`). Resolves to its teardown. */
export const mountNotificationsDemo = async (root: HTMLElement): Promise<() => void> => {
  const stage = root.querySelector<HTMLElement>("[data-demo-stage]")
  const host = root.querySelector<HTMLElement>("[data-demo-host]")
  if (!stage || !host) throw new Error("notifications demo: markup missing")
  const caption = root.querySelector<HTMLElement>("[data-demo-call]")
  const autoplayButton = root.querySelector<HTMLButtonElement>("[data-demo-autoplay]")
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-demo-action]")]

  const runtimes = await createRuntimes()
  const demo = createNotificationsDemo(runtimes)
  // The demo syncs after each call, so the background poll only has to catch stragglers.
  const harness = createNotificationHarness({ services: runtimes, pollIntervalMs: 1000 })
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
  const abort = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed) run()
    }, ms)
    timers.add(timer)
    return timer
  }

  // ── The harness UI ───────────────────────────────────────────────────────────

  let layout = deviceLayout(stage.clientWidth)
  let ui: AppHandle
  /** Ids the next arrival should open on its device, not only list. */
  let openNext = false

  /** Bring an arrival's device forward: its tab on a narrow screen, its conversation on the phone. */
  const reveal = (n: Notification, open: boolean, attempt = 0) => {
    if (disposed) return
    // `onArrive` runs before the UI has re-read the list, and `show` needs the item.
    if (!ui.state.items.some((item) => item.id === n.id)) {
      if (attempt < 60) requestAnimationFrame(() => reveal(n, open, attempt + 1))
      return
    }
    if (n.channel === "sms") ui.show({ id: n.id })
    else {
      ui.show({ channel: n.channel })
      // Let the row slide into the inbox before the message opens over it.
      if (n.channel === "email" && open) later(900, () => ui.show({ id: n.id }))
    }
  }

  const mountUi = () => {
    ui = mountNotifications(host, {
      harness,
      layout: layout.layout,
      scale: layout.scale,
      chrome: false,
      sound: false,
      // Read state would outlive the emulators, which start empty on every visit.
      storage: false,
      title: "Notifications",
      onArrive: (added) => {
        const newest = [...added].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
        if (!newest) return
        reveal(newest, openNext)
        openNext = false
      },
    })
    return ui.ready
  }

  const resizes = new ResizeObserver(() => {
    const next = deviceLayout(stage.clientWidth)
    if (sameLayout(next, layout)) return
    const remount = next.layout !== layout.layout
    layout = next
    if (remount) {
      ui.destroy()
      void mountUi()
    } else ui.setScale(next.scale)
  })

  // ── Sending ──────────────────────────────────────────────────────────────────

  const showCall = (call: DemoCall) => {
    if (!caption) return
    const ok = call.status >= 200 && call.status < 300
    caption.replaceChildren()
    const method = document.createElement("span")
    method.className = "method"
    method.dataset.m = call.method
    method.textContent = call.method
    const path = document.createElement("code")
    path.textContent = call.path
    const status = document.createElement("span")
    status.className = `badge ${ok ? "badge-ok" : "badge-warn"}`
    status.textContent = String(call.status)
    const service = document.createElement("span")
    service.className = "notif-call-service"
    service.textContent = `${SERVICE_LABELS[call.service]} emulator, in this tab`
    caption.append(method, path, status, service)
    caption.dataset.service = call.service
    caption.dataset.status = String(call.status)
    // Restart the flash that draws the eye to a new line.
    caption.classList.remove("is-fresh")
    void caption.offsetWidth
    caption.classList.add("is-fresh")
  }

  const send = async (action: DemoAction, order?: number) => {
    const call = await demo.send(action, order)
    if (disposed) return
    showCall(call)
    await harness.sync()
  }

  let busy = false
  const setBusy = (next: boolean) => {
    busy = next
    for (const button of buttons) button.disabled = next
  }

  const checkout = () => {
    setBusy(true)
    const order = demo.nextOrder()
    const last = CHECKOUT_STEPS[CHECKOUT_STEPS.length - 1]
    for (const step of CHECKOUT_STEPS)
      later(step.afterMs, () => {
        void send(step.action, order).finally(() => {
          if (step === last && !disposed) setBusy(false)
        })
      })
  }

  const reset = async () => {
    setBusy(true)
    try {
      await demo.reset()
      await harness.sync()
      if (disposed) return
      // A fresh mount forgets the open conversation and message, which no longer exist.
      ui.destroy()
      await mountUi()
      if (caption) {
        caption.replaceChildren()
        const method = document.createElement("span")
        method.className = "method"
        method.dataset.m = "POST"
        method.textContent = "POST"
        const path = document.createElement("code")
        path.textContent = "/__admin/reset"
        const status = document.createElement("span")
        status.className = "badge badge-ok"
        status.textContent = "200"
        const service = document.createElement("span")
        service.className = "notif-call-service"
        service.textContent = "every emulator, in this tab"
        caption.append(method, path, status, service)
        caption.dataset.service = "all"
      }
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  // ── Autoplay ─────────────────────────────────────────────────────────────────

  /** `playing` runs while the stage is on screen; any interaction turns it `off` for good. */
  let autoplay: "playing" | "off" = reducedMotion ? "off" : "playing"
  let onScreen = false
  let played = 0
  let tick: ReturnType<typeof setTimeout> | null = null

  const renderAutoplay = () => {
    const running = autoplay === "playing" && onScreen && !document.hidden
    root.dataset.autoplay = autoplay === "off" ? "off" : running ? "playing" : "paused"
    if (!autoplayButton) return
    autoplayButton.disabled = false
    autoplayButton.setAttribute("aria-pressed", String(autoplay === "playing"))
    const label = autoplayButton.querySelector("[data-demo-autoplay-label]")
    if (label) label.textContent = autoplay === "playing" ? "Pause autoplay" : "Autoplay"
  }

  const schedule = (ms: number) => {
    if (tick) {
      clearTimeout(tick)
      timers.delete(tick)
      tick = null
    }
    renderAutoplay()
    if (autoplay !== "playing" || !onScreen || document.hidden || busy) return
    tick = later(ms, () => {
      tick = null
      const action = AUTOPLAY[played % AUTOPLAY.length] as DemoAction
      played++
      void send(action).finally(() => {
        if (played >= AUTOPLAY_LIMIT) autoplay = "off"
        schedule(AUTOPLAY_EVERY_MS)
      })
    })
  }

  const stopAutoplay = () => {
    if (autoplay === "off") return
    autoplay = "off"
    schedule(0)
  }

  const visibility = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting)
      schedule(played ? AUTOPLAY_EVERY_MS : AUTOPLAY_FIRST_MS)
    },
    { threshold: 0.3 },
  )

  // ── Wiring ───────────────────────────────────────────────────────────────────

  const { signal } = abort
  document.addEventListener(
    "visibilitychange",
    () => schedule(played ? AUTOPLAY_EVERY_MS : AUTOPLAY_FIRST_MS),
    { signal },
  )
  // Touching the devices or the buttons means the visitor is driving now.
  for (const type of ["pointerdown", "keydown"] as const)
    root.addEventListener(
      type,
      (event) => {
        if ((event.target as Element).closest("[data-demo-autoplay]")) return
        if (type === "keydown" && (event as KeyboardEvent).key === "Tab") return
        stopAutoplay()
      },
      { signal, capture: true },
    )

  root.addEventListener(
    "click",
    (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button")
      if (!button || button.disabled || !root.contains(button)) return
      if (button.matches("[data-demo-autoplay]")) {
        autoplay = autoplay === "playing" ? "off" : "playing"
        if (autoplay === "playing") played = 0
        schedule(AUTOPLAY_FIRST_MS)
        return
      }
      const action = button.dataset.demoAction
      if (!action) return
      stopAutoplay()
      if (action === "checkout") checkout()
      else if (action === "reset") void reset()
      else if ((DEMO_ACTIONS as readonly string[]).includes(action)) {
        openNext = true
        void send(action as DemoAction)
      }
    },
    { signal },
  )

  await mountUi()
  if (reducedMotion) {
    // No motion to watch: start with one message on every device instead of a sequence.
    for (const action of ["email", "push", "chat", "code"] as const) await demo.send(action)
    await harness.sync()
  }
  resizes.observe(stage)
  visibility.observe(stage)
  setBusy(false)
  renderAutoplay()
  root.dataset.state = "ready"

  return () => {
    disposed = true
    abort.abort()
    resizes.disconnect()
    visibility.disconnect()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    ui.destroy()
    harness.close()
    setBusy(true)
    if (autoplayButton) autoplayButton.disabled = true
    root.dataset.state = "idle"
  }
}
