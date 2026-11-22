/// <reference lib="dom" />
/**
 * How the devices respond to a hand: swipes, long presses, taps on their controls, and the motion
 * that goes with them (a row flying out, a list closing over it). One set of delegated listeners
 * on the UI root, reading the `data-action`, `data-swipe` and `data-longpress` attributes the
 * device skins draw, so every gesture also works with a click or a key.
 *
 * The harness chrome around the devices (toolbar, tabs, timeline, inspector) is HeroUI and handles
 * its own events; only the devices' imitation controls come through here.
 */
import type { Store } from "./store.js"
import type { PushSkin, Tapback } from "./types.js"

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

const IOS_OPEN = 160
const THREAD_OPEN = 148

/** The CSS zoom on an element (`scale`, the narrow fit): its own lengths are that much smaller on screen. */
export const zoomOf = (el: Element): number =>
  (el as Element & { currentCSSZoom?: number }).currentCSSZoom || 1

export function attachGestures(root: HTMLElement, store: Store): () => void {
  const listeners = new AbortController()
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ) => root.addEventListener(type, handler, { signal: listeners.signal, capture })
  const { actions, state, later, animate } = store

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
    const done = () => actions.dismissPush(id)
    if (!row) return done()
    flyOut(row, cardIn(row), direction, done)
  }

  const deleteThread = (from: string) => {
    const row = rowFor(`.thread-swipe[data-from="${CSS.escape(from)}"]`)
    const done = () => actions.deleteThread(from)
    if (!row) return done()
    flyOut(row, cardIn(row), -1, done)
  }

  const removeEmail = (id: string, verb: "archived" | "deleted", direction = -1) => {
    const row = rowFor(`.mrow-swipe[data-id="${CSS.escape(id)}"]`)
    const done = () => actions.archiveEmail(id, verb)
    if (!row) return done()
    flyOut(row, cardIn(row), direction, done)
  }

  // ── Gestures: swipe and long press (pointer events; mouse, pen and touch) ────

  let drag: Drag | null = null
  let suppressClick = false
  store.setGesturing(() => drag !== null)

  const setOffset = (row: HTMLElement, x: number) => {
    const card = cardIn(row)
    card.style.transform = x ? `translateX(${x}px)` : ""
    if (row.dataset.swipe === "a-note")
      card.style.opacity = String(1 - Math.min(0.9, Math.abs(x) / row.offsetWidth))
  }

  const settle = (row: HTMLElement, x: number, open: boolean) => {
    row.classList.add("settling")
    row.classList.toggle("open", open)
    setOffset(row, x)
    later(340, () => {
      row.classList.remove("settling", "swiping")
      row.dataset.offset = String(x)
    })
  }

  const longPress = (el: HTMLElement) => {
    const kind = el.dataset.longpress ?? ""
    const id = el.dataset.notificationId ?? el.dataset.id ?? ""
    actions.longPress(kind, id)
  }

  on("pointerdown", (event) => {
    store.sound.unlock()
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
        actions.pushExpand(id)
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

  // ── Clicks on the devices' own controls ──────────────────────────────────────

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

  on("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!target || !root.contains(target)) return
    // A tap on an open swipe row closes it instead of acting.
    const openRow = target.closest<HTMLElement>(".swipe.open")
    if (openRow && target.classList.contains("swipe-card")) {
      settle(openRow, 0, false)
      return
    }
    const action = target.dataset.action
    const id = target.dataset.id ?? ""
    const from = target.dataset.from ?? ""
    switch (action) {
      case "chat-channel":
        actions.chatChannel(target.dataset.value ?? "")
        break
      case "sms-open":
        actions.smsOpen(from)
        break
      case "sms-back":
        actions.smsBack()
        break
      case "thread-delete":
        deleteThread(from)
        break
      case "thread-pin":
        actions.threadPin(from)
        break
      case "thread-mute":
        actions.threadMute(from)
        break
      case "thread-unread":
        actions.threadUnread(from)
        break
      case "tapback":
        actions.tapback(id, target.dataset.value as Tapback)
        break
      case "sms-copy":
        actions.smsCopy(id)
        break
      case "sms-copy-code":
        actions.copy(target.dataset.code ?? "")
        break
      case "close-overlay":
        actions.closeOverlays()
        break
      case "push-toggle":
        actions.pushToggle(id, target.dataset.groupTop === "true")
        break
      case "push-clear":
        state.push.preview = null
        dismissPush(id)
        break
      case "push-options":
        actions.pushOptions(id)
        break
      case "push-alerting":
        actions.pushAlerting(target.dataset.app ?? "App", target.dataset.value === "silent")
        break
      case "push-clear-all": {
        const rows = [...root.querySelectorAll<HTMLElement>(".shade-list .a-note")]
        const ids = rows.map((r) => r.dataset.id ?? "")
        const done = () => actions.dismissMany(ids)
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
        actions.groupOpen(target.dataset.key ?? "")
        break
      case "group-collapse":
        actions.groupCollapse(target.dataset.key ?? "")
        break
      case "group-clear":
        actions.groupClear(target.dataset.key ?? "", target.dataset.app ?? "App")
        break
      case "skin":
        actions.setSkin((target.dataset.value as PushSkin) ?? "auto")
        break
      case "mail-open":
        actions.mailOpen(id)
        break
      case "mail-back":
        actions.mailBack()
        break
      case "mail-details":
        actions.mailDetails()
        break
      case "mail-archive":
        removeEmail(id, "archived")
        break
      case "mail-delete":
        removeEmail(id, "deleted")
        break
      case "mail-unread":
        actions.mailUnread(id)
        break
      case "mail-toggle-read":
        actions.mailToggleRead(id)
        break
      case "mail-star":
        actions.mailStar(id)
        break
      case "mail-check":
        actions.mailCheck(id)
        break
      case "toast-undo":
        actions.toastUndo()
        break
      case "toast-close":
        actions.toastClose()
        break
      case "refresh":
        actions.refresh()
        break
    }
  })

  on("dblclick", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-notification-id]")
    if (!target?.closest("[data-region=devices]")) return
    actions.inspect(target.dataset.notificationId ?? null)
  })

  on("keydown", (event) => {
    store.sound.unlock()
    const target = event.target as HTMLElement
    if (event.key === "Escape") {
      if (actions.closeOverlays()) event.stopPropagation()
      return
    }
    if (target.matches("input, select, textarea")) return
    if (!target.closest("[data-region=devices]")) return
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

  return () => {
    listeners.abort()
    store.setGesturing(() => false)
  }
}
