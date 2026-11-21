// biome-ignore-all lint/a11y/noNoninteractiveTabindex: each message takes focus, so the keyboard can reach it and inspect it
// biome-ignore-all lint/a11y/useSemanticElements: the skin imitates a chat client's message log, with ARIA roles on the elements that draw it
// biome-ignore-all lint/security/noDangerouslySetInnerHtml: chat.ts builds the message markup and escapes every value in it
/**
 * Chat messages as a team chat window shows them: channels on the left, each bot message with its
 * mrkdwn text, Block Kit blocks, attachments and reactions. A device skin: a generic chat
 * client's look (`skins.ts`), no vendor marks and no HeroUI inside. The message markup itself
 * comes from `chat.ts`, which escapes every value it draws.
 */
import { Fragment, useLayoutEffect, useRef } from "react"
import type { Notification } from "../model.js"
import { TEST_IDS } from "../testids.js"
import { emoji, mrkdwn, renderAttachments, renderBlocks } from "./chat.js"
import { Glyph, useAttrs, useStore } from "./context.js"
import { APP, chatDay, chatLabel, clock, colorFor, initials } from "./format.js"
import { icons } from "./icons.js"

/** Markup `chat.ts` built from the message, every value in it escaped. */
function Markup({ className, testId, html }: { className: string; testId: string; html: string }) {
  return (
    <div className={className} data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />
  )
}

function ChatMessage({ n }: { n: Notification }) {
  const store = useStore()
  const attrs = useAttrs()
  const c = n.chat
  const author = n.from.name ?? n.from.address
  const names = { name: (id: string) => c?.names?.[id] }
  return (
    <div
      className={`chat-msg ${store.state.arrived.has(n.id) ? "arrive" : ""}`}
      {...attrs(n)}
      data-testid={TEST_IDS.chatMessage}
      data-method={c?.method ?? ""}
      data-ephemeral={String(c?.ephemeral ?? false)}
      data-thread={c?.threadTs ?? ""}
      role="listitem"
      tabIndex={0}
    >
      <span
        className="chat-avatar"
        style={{ background: colorFor(n.from.address, APP) }}
        aria-hidden="true"
      >
        {initials(author)}
      </span>
      <div className="chat-msg-main">
        <div className="chat-meta">
          <b data-testid={TEST_IDS.chatMessageAuthor}>{author}</b>
          <span className="chat-app">APP</span>
          <span className="chat-time" data-testid={TEST_IDS.chatMessageTime}>
            {clock(new Date(n.createdAt))}
          </span>
          {c?.edited ? <span className="chat-edited">(edited)</span> : null}
        </div>
        {c?.ephemeral ? <div className="chat-note">Only visible to you</div> : null}
        {c?.threadTs ? <div className="chat-note">replied to a thread</div> : null}
        {/* A client shows `text` only when there are no blocks; with blocks it is the fallback. */}
        {c?.text && !c.blocks.length ? (
          <Markup
            className="chat-text"
            testId={TEST_IDS.chatMessageText}
            html={mrkdwn(c.text, names)}
          />
        ) : null}
        {c?.blocks.length ? (
          <Markup
            className="chat-blocks"
            testId={TEST_IDS.chatMessageBlocks}
            html={renderBlocks(c.blocks, names)}
          />
        ) : null}
        {c?.attachments.length ? (
          <Markup
            className="chat-attachments"
            testId={TEST_IDS.chatMessageAttachments}
            html={renderAttachments(c.attachments, names)}
          />
        ) : null}
        {c?.reactions.length ? (
          <div className="chat-reactions">
            {c.reactions.map((r) => (
              <span
                key={r.name}
                className="chat-reaction"
                data-testid={TEST_IDS.chatMessageReaction}
                data-name={r.name}
                data-count={r.count}
              >
                {emoji(r.name)} {r.count}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The chat window, open on the channel `state.chat.to`. */
export function ChatDevice() {
  const store = useStore()
  const log = useRef<HTMLDivElement>(null)
  const to = store.state.chat.to
  const all = store.byChannel("chat")
  const items = store.chatItems()
  const channels = store.recipients("chat")
  const workspace = all[0]?.chat?.workspace ?? "Workspace"
  const now = store.nowMs()

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the channel or its length changes
  useLayoutEffect(() => {
    const toBottom = () => {
      if (log.current) log.current.scrollTop = log.current.scrollHeight
    }
    toBottom()
    const frame = requestAnimationFrame(toBottom)
    return () => cancelAnimationFrame(frame)
  }, [to, items.length])

  let day = ""
  return (
    <div
      className="window chat mbn-skin"
      data-testid={TEST_IDS.chatDevice}
      data-recipient={to ?? ""}
      data-workspace={workspace}
    >
      <div className="chrome">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="omnibox">
          <Glyph svg={icons.lock()} /> chat.example.test/
          {to ? chatLabel(to).replace(/^#/, "") : ""}
        </span>
      </div>
      <div className="chat-body">
        <nav className="chat-side" aria-label="Channels">
          <div className="chat-team" data-testid={TEST_IDS.chatWorkspace}>
            {workspace} <Glyph svg={icons.dropdown()} />
          </div>
          <div className="chat-side-label">Channels</div>
          {channels.map((r) => (
            <button
              key={r.to}
              type="button"
              className={`chat-chan ${r.to === to ? "on" : ""} ${r.unread ? "unread" : ""}`}
              data-action="chat-channel"
              data-value={r.to}
              data-testid={TEST_IDS.chatChannel}
              data-to={r.to}
              data-unread={r.unread}
              aria-current={r.to === to}
            >
              <span className="hash">{r.to.startsWith("#") ? "#" : "~"}</span>
              <span className="lbl">{chatLabel(r.to).replace(/^#/, "")}</span>
              {r.unread ? <span className="n">{r.unread}</span> : null}
            </button>
          ))}
        </nav>
        <div className="chat-main">
          <header className="chat-head">
            <b data-testid={TEST_IDS.chatTitle}>{to ? chatLabel(to) : "Chat"}</b>
            <span>
              {items.length ? `${items.length} message${items.length === 1 ? "" : "s"}` : ""}
            </span>
          </header>
          <div className="chat-list" role="list" ref={log}>
            {items.length ? (
              items.map((n) => {
                const label = chatDay(n.createdAt, now)
                const divider = label !== day
                day = label
                return (
                  <Fragment key={n.id}>
                    {divider ? (
                      <div className="chat-day">
                        <span>{label}</span>
                      </div>
                    ) : null}
                    <ChatMessage n={n} />
                  </Fragment>
                )
              })
            ) : (
              <div className="chat-empty" data-testid={TEST_IDS.chatEmpty}>
                <b>{to ? "No messages in this channel" : "No chat messages yet"}</b>
                {to
                  ? ""
                  : "Messages posted to the Slack emulator, with chat.postMessage or an incoming webhook, land here."}
              </div>
            )}
          </div>
          <div className="chat-compose">
            <span>Message {to ? chatLabel(to) : "channel"}</span>
            <span className="send">
              <Glyph svg={icons.send()} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
