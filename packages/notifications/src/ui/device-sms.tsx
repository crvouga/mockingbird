// biome-ignore-all lint/a11y/noNoninteractiveTabindex: a bubble takes focus for its long-press menu (Shift+F10)
// biome-ignore-all lint/a11y/useSemanticElements: the skins imitate a phone app's own widgets (swipeable rows, bubbles), with ARIA roles on the elements that draw them
// biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: tapback glyphs are named for screen readers
/**
 * The Messages app on a phone: the thread list and a conversation, as the recipient sees a text or
 * a WhatsApp message. A device skin, so it keeps the platform's own look (`skins.ts`) and has no
 * HeroUI inside; its gestures come through `gestures.ts`.
 */
import { Fragment, type ReactNode, useLayoutEffect, useRef } from "react"
import type { Notification } from "../model.js"
import { TEST_IDS } from "../testids.js"
import { Glyph, useAttrs, useStore } from "./context.js"
import {
  bareAddress,
  clock,
  displaySender,
  initials,
  iosListTime,
  iosStamp,
  isPhone,
  isWhatsApp,
  otpOf,
  shortClock,
} from "./format.js"
import { icons } from "./icons.js"
import { threadKey } from "./store.js"
import type { Tapback } from "./types.js"

const TAPBACKS: { id: Tapback; glyph: ReactNode; label: string }[] = [
  { id: "heart", glyph: "♥", label: "Heart" },
  { id: "like", glyph: "👍", label: "Like" },
  { id: "dislike", glyph: "👎", label: "Dislike" },
  {
    id: "laugh",
    glyph: (
      <>
        HA
        <br />
        HA
      </>
    ),
    label: "Laugh",
  },
  { id: "emphasize", glyph: "‼", label: "Emphasize" },
  { id: "question", glyph: "?", label: "Question" },
]

const URL_PATTERN = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g

/** Message text with its links live and the one-time code underlined, as Messages draws them. */
export function richText(text: string, code: string | null = null): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  let codeLeft = code
  const plain = (part: string) => {
    if (!part) return
    const match = codeLeft ? new RegExp(`\\b${codeLeft}\\b`).exec(part) : null
    if (!match || !codeLeft) {
      out.push(part)
      return
    }
    out.push(
      part.slice(0, match.index),
      <span key={`code${key++}`} className="code">
        {codeLeft}
      </span>,
      part.slice(match.index + codeLeft.length),
    )
    codeLeft = null
  }
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    plain(text.slice(last, match.index))
    out.push(
      <a key={`url${key++}`} href={match[0]} target="_blank" rel="noreferrer">
        {match[0]}
      </a>,
    )
    last = (match.index ?? 0) + match[0].length
  }
  plain(text.slice(last))
  return out
}

/** The phone's status bar: time, signal, Wi-Fi, battery. */
export function StatusBar({ light = false }: { light?: boolean }) {
  const store = useStore()
  return (
    <div className={`statusbar ${light ? "light" : ""}`}>
      <span>{shortClock(new Date(store.nowMs()))}</span>
      <span className="icons">
        <Glyph svg={icons.signal()} />
        <Glyph svg={icons.wifi()} />
        <Glyph svg={icons.battery()} />
      </span>
    </div>
  )
}

function Avatar({ n, className = "avatar" }: { n: Notification | undefined; className?: string }) {
  const name = n ? displaySender(n) : ""
  const anonymous = isPhone(bareAddress(n?.from.address ?? "")) && !n?.from.name
  return (
    <div className={className}>{anonymous ? <Glyph svg={icons.person()} /> : initials(name)}</div>
  )
}

function TapbackBadge({ id }: { id: string }) {
  const store = useStore()
  const def = TAPBACKS.find((x) => x.id === store.local.tapbacks.get(id))
  if (!def) return null
  return (
    <span
      className="tapback"
      data-testid={TEST_IDS.smsTapback}
      data-tapback={def.id}
      aria-label={def.label}
    >
      {def.glyph}
    </span>
  )
}

function BubbleBody({ n }: { n: Notification }) {
  return (
    <>
      {(n.sms?.media ?? []).map((src) => (
        <img key={src} className="media" src={src} alt="" data-testid={TEST_IDS.smsBubbleMedia} />
      ))}
      {richText(n.sms?.body ?? "", otpOf(n))}
    </>
  )
}

function MessageMenu({ n }: { n: Notification }) {
  const store = useStore()
  const current = store.local.tapbacks.get(n.id)
  return (
    <div
      className="ios-overlay"
      data-action="close-overlay"
      data-testid={TEST_IDS.smsMenu}
      data-notification-id={n.id}
      role="dialog"
      aria-label="Message actions"
    >
      <div className="tapback-bar" role="toolbar" aria-label="Tapback">
        {TAPBACKS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-action="tapback"
            data-id={n.id}
            data-value={t.id}
            data-testid={TEST_IDS.smsMenuTapback}
            data-tapback={t.id}
            aria-label={t.label}
            aria-pressed={current === t.id}
          >
            {t.glyph}
          </button>
        ))}
      </div>
      <div className="bubble tail">
        <BubbleBody n={n} />
      </div>
      <div className="ios-menu" role="menu">
        <button type="button" role="menuitem" data-action="close-overlay">
          Reply
        </button>
        <button
          type="button"
          role="menuitem"
          data-action="sms-copy"
          data-id={n.id}
          data-testid={TEST_IDS.smsMenuCopy}
        >
          Copy
        </button>
        <button type="button" role="menuitem" data-action="close-overlay">
          Translate
        </button>
        <button type="button" role="menuitem" data-action="close-overlay">
          More…
        </button>
      </div>
    </div>
  )
}

function Conversation({ to, items }: { to: string; items: Notification[] }) {
  const store = useStore()
  const attrs = useAttrs()
  const body = useRef<HTMLDivElement>(null)
  const first = items[0]
  const from = first?.from.address ?? ""
  const whatsapp = isWhatsApp(first)
  const otherUnread = store
    .smsThreads(to)
    .filter((t) => t.from !== from)
    .reduce((sum, t) => sum + t.items.filter((n) => store.isUnread(n.id)).length, 0)
  const enter = store.cues.sms === "push" && store.animate()
  const muted = store.local.muted.has(threadKey(to, from))
  const latest = items.at(-1)
  const code = latest ? otpOf(latest) : null
  const menuFor = store.state.sms.menu ? items.find((n) => n.id === store.state.sms.menu) : null
  const now = store.nowMs()

  // Open on the newest message, again once the element is laid out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the thread or its length changes
  useLayoutEffect(() => {
    const toBottom = () => {
      if (body.current) body.current.scrollTop = body.current.scrollHeight
    }
    toBottom()
    const frame = requestAnimationFrame(toBottom)
    return () => cancelAnimationFrame(frame)
  }, [from, items.length])

  let last = 0
  let prevTail = true
  const rows = items.map((n, i) => {
    const at = Date.parse(n.createdAt)
    const stamp = i === 0 || at - last > 15 * 60_000 ? iosStamp(n.createdAt, now) : null
    const next = items[i + 1]
    const tail = !next || Date.parse(next.createdAt) - at > 60_000
    const gap = !stamp && prevTail && i > 0
    last = at
    prevTail = tail
    const bubbleCode = otpOf(n)
    return (
      <Fragment key={n.id}>
        {stamp ? (
          <div className="stamp" data-testid={TEST_IDS.smsTimestamp}>
            {i === 0 ? (
              <>
                {whatsapp ? "WhatsApp" : "Text Message"}
                <br />
              </>
            ) : null}
            <b>{stamp.day}</b> {stamp.time}
          </div>
        ) : null}
        <div className={`bubble-row ${gap ? "gap" : ""}`}>
          <div
            className={`bubble ${tail ? "tail" : ""} ${store.state.arrived.has(n.id) ? "arrive" : ""}`}
            {...attrs(n)}
            data-testid={TEST_IDS.smsBubble}
            {...(bubbleCode ? { "data-code": bubbleCode } : {})}
            data-longpress="sms-bubble"
            tabIndex={0}
            aria-haspopup="menu"
          >
            <BubbleBody n={n} />
            {whatsapp ? <span className="wa-time">{clock(new Date(at))}</span> : null}
            <TapbackBadge id={n.id} />
          </div>
          <span className="bubble-time" data-testid={TEST_IDS.smsBubbleTime} aria-hidden="true">
            {clock(new Date(at))}
          </span>
        </div>
      </Fragment>
    )
  })

  return (
    <div
      className={`convo ${whatsapp ? "wa" : ""} ${enter ? "enter" : ""}`}
      data-testid={TEST_IDS.smsConversation}
      data-from={from}
      data-via={whatsapp ? "whatsapp" : "sms"}
    >
      <div className="convo-nav">
        <div className="bar">
          <button
            type="button"
            className="back"
            data-action="sms-back"
            data-testid={TEST_IDS.smsBack}
            aria-label="Back to Messages"
          >
            <Glyph svg={icons.chevronBack()} />
            {otherUnread ? <span className="badge">{otherUnread}</span> : null}
          </button>
          <Avatar n={first} />
          <div className="who">
            <span data-testid={TEST_IDS.smsConversationTitle}>
              {first ? displaySender(first) : from}
            </span>
            {muted ? (
              <>
                {" "}
                <span className="flag">
                  <Glyph svg={icons.bellSlash(12)} />
                </span>
              </>
            ) : null}{" "}
            {whatsapp ? (
              <small className="wa-sub">WhatsApp</small>
            ) : (
              <Glyph svg={icons.chevronRight("#8e8e93")} />
            )}
          </div>
        </div>
      </div>
      <div className="convo-body" data-swipe="sms-convo" ref={body}>
        {rows}
      </div>
      {code && latest && now - Date.parse(latest.createdAt) < 10 * 60_000 ? (
        <button
          type="button"
          className="qt"
          data-action="sms-copy-code"
          data-code={code}
          data-testid={TEST_IDS.smsCode}
        >
          <small>From {whatsapp ? "WhatsApp" : "Messages"}</small>
          {code}
        </button>
      ) : null}
      <div className="convo-input">
        <span className="plus">
          <Glyph svg={icons.plus()} />
        </span>
        <span className="field-ios">
          {whatsapp ? "Message" : "Text Message"}
          <span>
            <Glyph svg={icons.mic()} />
          </span>
        </span>
      </div>
      {menuFor ? <MessageMenu n={menuFor} /> : null}
    </div>
  )
}

function ThreadList({ to }: { to: string | null }) {
  const store = useStore()
  const attrs = useAttrs()
  const threads = to ? store.smsThreads(to) : []
  const enter = store.cues.sms === "back" && store.animate()
  const now = store.nowMs()
  return (
    <div className={`msgs ${enter ? "enter" : ""}`}>
      <div className="msgs-nav">
        <div className="row">
          <span>Edit</span>
          <Glyph svg={icons.compose()} />
        </div>
        <h1>Messages</h1>
        <div className="ios-search">
          <Glyph svg={icons.search("currentColor", 15)} />
          <span>Search</span>
          <Glyph svg={icons.mic("currentColor")} />
        </div>
      </div>
      {threads.length && to ? (
        <div className="threads" role="list">
          {threads.map((t) => {
            const latest = t.items.at(-1)
            const unread = t.items.some((n) => store.isUnread(n.id))
            const muted = store.local.muted.has(threadKey(to, t.from))
            const name = latest ? displaySender(latest) : t.from
            const whatsapp = isWhatsApp(latest)
            return (
              <div
                key={t.from}
                className="swipe thread-swipe"
                data-swipe="sms-thread"
                data-from={t.from}
                data-flip={`thread:${t.from}`}
                role="listitem"
              >
                <div className="swipe-actions">
                  <div className="side">
                    <button
                      type="button"
                      className="act-unread"
                      data-action="thread-unread"
                      data-from={t.from}
                      data-testid={TEST_IDS.smsThreadToggleUnread}
                    >
                      <Glyph svg={unread ? icons.markRead(22) : icons.markUnread(22)} />
                      {unread ? "Read" : "Unread"}
                    </button>
                    <button
                      type="button"
                      className="act-pin"
                      data-action="thread-pin"
                      data-from={t.from}
                      data-testid={TEST_IDS.smsThreadPin}
                    >
                      <Glyph svg={icons.pin(22)} />
                      {t.pinned ? "Unpin" : "Pin"}
                    </button>
                  </div>
                  <div className="side">
                    <button
                      type="button"
                      className="act-mute"
                      data-action="thread-mute"
                      data-from={t.from}
                      data-testid={TEST_IDS.smsThreadMute}
                    >
                      <Glyph svg={icons.bellSlash(22)} />
                      {muted ? "Show Alerts" : "Hide Alerts"}
                    </button>
                    <button
                      type="button"
                      className="act-delete"
                      data-action="thread-delete"
                      data-from={t.from}
                      data-testid={TEST_IDS.smsThreadDelete}
                    >
                      <Glyph svg={icons.trash()} />
                      Delete
                    </button>
                  </div>
                </div>
                <div
                  className="thread swipe-card"
                  data-action="sms-open"
                  {...(latest ? attrs(latest) : {})}
                  data-from={t.from}
                  data-testid={TEST_IDS.smsThread}
                  data-unread={String(unread)}
                  data-pinned={String(t.pinned)}
                  data-muted={String(muted)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${name}${whatsapp ? ", WhatsApp" : ""}${unread ? ", unread" : ""}`}
                >
                  {unread ? (
                    <span className="unread" data-testid={TEST_IDS.smsThreadUnread} />
                  ) : null}
                  <Avatar n={latest} className={`avatar ${whatsapp ? "wa" : ""}`} />
                  <div className="text">
                    <div className="top">
                      <span className="name-line">
                        <span className="name" data-testid={TEST_IDS.smsThreadName}>
                          {name}
                        </span>
                        {whatsapp ? (
                          <span className="via-wa" data-testid={TEST_IDS.smsThreadVia}>
                            WhatsApp
                          </span>
                        ) : null}
                        {t.pinned ? (
                          <span className="flag">
                            <Glyph svg={icons.pin(13)} />
                          </span>
                        ) : null}
                        {muted ? (
                          <span className="flag">
                            <Glyph svg={icons.bellSlash(13)} />
                          </span>
                        ) : null}
                      </span>
                      <span className="when" data-testid={TEST_IDS.smsThreadTime}>
                        {iosListTime(latest?.createdAt ?? "", now)}{" "}
                        <Glyph svg={icons.chevronRight()} />
                      </span>
                    </div>
                    <div className="preview" data-testid={TEST_IDS.smsThreadPreview}>
                      {latest?.sms?.body ?? ""}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="empty-ios" data-testid={TEST_IDS.smsEmpty}>
          {to ? (
            "No Messages"
          ) : (
            <>
              No text messages yet.
              <br />
              <br />
              SMS sent through Twilio, SNS, Customer.io, Mailosaur or Cognito, and WhatsApp sent
              through Twilio, show up here.
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The phone with the Messages app open on `state.sms.to`. */
export function SmsDevice() {
  const store = useStore()
  const to = store.state.sms.to
  const thread = store.openThread()
  const whatsapp = thread ? isWhatsApp(thread.items[0]) : false
  return (
    <div
      className="iphone mbn-skin"
      data-testid={TEST_IDS.smsDevice}
      data-screen={thread ? "conversation" : "threads"}
      data-recipient={to ?? ""}
      data-thread={thread?.from ?? ""}
      {...(whatsapp ? { "data-via": "whatsapp" } : {})}
    >
      <div className="screen">
        <div className="island" />
        <StatusBar />
        {thread && to ? <Conversation to={to} items={thread.items} /> : <ThreadList to={to} />}
        <div className="home-indicator" />
      </div>
    </div>
  )
}
