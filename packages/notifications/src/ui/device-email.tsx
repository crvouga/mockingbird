// biome-ignore-all lint/a11y/useSemanticElements: the skin imitates a mail client's own rows and toggles, with ARIA roles on the elements that draw them
/**
 * Email as a webmail client shows it: the inbox for `state.email.to`, and an open message with its
 * rendered HTML, headers and attachments. A device skin: a generic mail client's look
 * (`skins.ts`), no vendor marks and no HeroUI inside.
 */
import type { Notification } from "../model.js"
import { TEST_IDS } from "../testids.js"
import { Glyph, useAttrs, useStore } from "./context.js"
import { richText } from "./device-sms.js"
import { colorFor, initials, mailDate, mailLongDate, serviceLabel } from "./format.js"
import { icons } from "./icons.js"

/** The message's HTML as its own document, so its styles stay inside the frame. */
const mailHtml = (n: Notification): string =>
  `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${n.email?.html ?? ""}</body></html>`

const IconButton = ({ svg }: { svg: string }) => (
  <span className="icon-btn">
    <Glyph svg={svg} />
  </span>
)

function Reader({ open, items, me }: { open: Notification; items: Notification[]; me: string }) {
  const store = useStore()
  const attrs = useAttrs()
  const e = open.email
  const sender = open.from.name ?? open.from.address
  const toLine = open.to.toLowerCase() === me.toLowerCase() ? "me" : open.to
  const enter = store.cues.email && store.animate()
  const detailsOpen = store.state.mailDetailsOpen
  const detail = (field: string, label: string, value: string) => (
    <>
      <span>{label}:</span>
      <span data-testid={TEST_IDS.emailDetail} data-field={field}>
        {value}
      </span>
    </>
  )
  return (
    <>
      <div className="mail-toolbar">
        <button
          type="button"
          className="icon-btn"
          data-action="mail-back"
          data-testid={TEST_IDS.emailBack}
          title="Back to Inbox"
          aria-label="Back to Inbox"
        >
          <Glyph svg={icons.back()} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-action="mail-archive"
          data-id={open.id}
          data-testid={TEST_IDS.emailArchive}
          title="Archive"
          aria-label="Archive"
        >
          <Glyph svg={icons.archive()} />
        </button>
        <IconButton svg={icons.report()} />
        <button
          type="button"
          className="icon-btn"
          data-action="mail-delete"
          data-id={open.id}
          data-testid={TEST_IDS.emailDelete}
          title="Delete"
          aria-label="Delete"
        >
          <Glyph svg={icons.trash()} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-action="mail-unread"
          data-id={open.id}
          data-testid={TEST_IDS.emailMarkUnread}
          title="Mark as unread"
          aria-label="Mark as unread"
        >
          <Glyph svg={icons.markUnread()} />
        </button>
        <IconButton svg={icons.clock()} />
        <IconButton svg={icons.more()} />
        <span className="range">
          {items.indexOf(open) + 1} of {items.length}
        </span>
      </div>
      <div
        className={`reader ${enter ? "enter" : ""}`}
        {...attrs(open)}
        data-testid={TEST_IDS.emailOpen}
      >
        <div className="subject-row">
          <h1 data-testid={TEST_IDS.emailSubject}>{e?.subject || "(no subject)"}</h1>
          <span className="label-chip">Inbox</span>
        </div>
        <div className="sender-row">
          <span className="mail-avatar" style={{ background: colorFor(open.from.address) }}>
            {initials(sender).slice(0, 1)}
          </span>
          <div className="who">
            <b data-testid={TEST_IDS.emailFromName}>{sender}</b>{" "}
            <span className="addr">
              &lt;<span data-testid={TEST_IDS.emailFromAddress}>{open.from.address}</span>&gt;
            </span>
            <div
              className="to"
              data-action="mail-details"
              data-testid={TEST_IDS.emailTo}
              role="button"
              tabIndex={0}
              aria-expanded={detailsOpen}
            >
              to {toLine}
              {e?.cc.length ? `, ${e.cc.join(", ")}` : ""} <Glyph svg={icons.dropdown()} />
            </div>
          </div>
          <div className="meta">
            <span data-testid={TEST_IDS.emailDate}>
              {mailLongDate(open.createdAt, store.nowMs())}
            </span>{" "}
            <IconButton svg={icons.star()} />
            <IconButton svg={icons.reply()} />
            <IconButton svg={icons.more()} />
          </div>
        </div>
        {detailsOpen ? (
          <div className="details" data-testid={TEST_IDS.emailDetails}>
            {detail(
              "from",
              "from",
              open.from.name ? `${open.from.name} <${open.from.address}>` : open.from.address,
            )}
            {detail("to", "to", open.to)}
            {e?.cc.length ? detail("cc", "cc", e.cc.join(", ")) : null}
            {e?.bcc.length ? detail("bcc", "bcc", e.bcc.join(", ")) : null}
            {e?.replyTo.length ? detail("reply-to", "reply-to", e.replyTo.join(", ")) : null}
            {detail("date", "date", new Date(open.createdAt).toLocaleString())}
            {detail("subject", "subject", e?.subject ?? "")}
            {detail("mailed-by", "mailed-by", `${serviceLabel(open.service)} (${open.source})`)}
            {detail("message-id", "message id", open.providerId)}
          </div>
        ) : null}
        {e?.html ? (
          <iframe
            className="mail-frame"
            name="email-body"
            data-testid={TEST_IDS.emailBody}
            data-format="html"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title="Email body"
            srcDoc={mailHtml(open)}
            onLoad={(event) => {
              const frame = event.currentTarget
              const doc = frame.contentDocument
              if (doc)
                frame.style.height = `${Math.max(120, doc.documentElement.scrollHeight + 8)}px`
            }}
          />
        ) : (
          <div className="mail-text" data-testid={TEST_IDS.emailText} data-format="text">
            {richText(e?.text ?? "")}
          </div>
        )}
        {e?.attachments.length ? (
          <div
            className="attachments"
            data-testid={TEST_IDS.emailAttachments}
            data-count={e.attachments.length}
          >
            <h3>
              {e.attachments.length} attachment{e.attachments.length === 1 ? "" : "s"}
            </h3>
            <div className="att-grid">
              {e.attachments.map((a, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: two attachments may share a name
                  key={`${a.filename}:${i}`}
                  className="att"
                  data-testid={TEST_IDS.emailAttachment}
                  data-filename={a.filename}
                  data-content-type={a.contentType ?? ""}
                  data-size={a.size ?? ""}
                >
                  <div className="att-top">
                    <Glyph svg={icons.file()} />
                  </div>
                  <div className="att-name">
                    <Glyph svg={icons.clip()} /> {a.filename}
                    {a.size ? (
                      <>
                        {" "}
                        <span className="att-size">
                          {Math.max(1, Math.round(a.size / 1024))} KB
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="reply-row">
          <span>
            <Glyph svg={icons.reply()} /> Reply
          </span>
          <span>
            <Glyph svg={icons.forward()} /> Forward
          </span>
        </div>
      </div>
    </>
  )
}

function Inbox({ to, items }: { to: string | null; items: Notification[] }) {
  const store = useStore()
  const attrs = useAttrs()
  const enter = store.cues.email && store.animate()
  const now = store.nowMs()
  return (
    <>
      <div className="mail-toolbar">
        <IconButton svg={icons.checkbox()} />
        <button
          type="button"
          className="icon-btn"
          data-action="refresh"
          data-testid={TEST_IDS.emailRefresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <Glyph svg={icons.refresh()} />
        </button>
        <IconButton svg={icons.more()} />
        <span className="range">{items.length ? `1–${items.length} of ${items.length}` : ""}</span>
      </div>
      <div className="cat-tabs">
        <div className="on">
          <Glyph svg={icons.inbox()} /> Primary
        </div>
        <div>
          <Glyph svg={icons.star()} /> Promotions
        </div>
        <div>
          <Glyph svg={icons.send()} /> Updates
        </div>
      </div>
      <div className={`mail-list ${enter ? "enter" : ""}`} role="list">
        {items.length ? (
          items.map((n) => {
            const unread = store.isUnread(n.id)
            const sender = n.from.name ?? n.from.address
            const starred = store.local.starred.has(n.id)
            return (
              <div
                key={n.id}
                className="swipe mrow-swipe"
                data-swipe="mrow"
                data-id={n.id}
                data-flip={`row:${n.id}`}
                role="listitem"
              >
                <div className="swipe-actions">
                  <Glyph svg={icons.archive()} />
                  <Glyph svg={icons.archive()} />
                </div>
                <div
                  className={`mrow swipe-card ${unread ? "unread" : ""} ${store.state.arrived.has(n.id) ? "arrive" : ""}`}
                  data-action="mail-open"
                  data-id={n.id}
                  {...attrs(n)}
                  data-testid={TEST_IDS.emailRow}
                  data-starred={String(starred)}
                  role="button"
                  tabIndex={0}
                >
                  <span
                    className="chk"
                    data-action="mail-check"
                    data-id={n.id}
                    role="checkbox"
                    aria-checked={store.local.checked.has(n.id)}
                    aria-label="Select"
                    tabIndex={-1}
                  >
                    <Glyph svg={icons.checkbox()} />
                  </span>
                  <span
                    className="star"
                    data-action="mail-star"
                    data-id={n.id}
                    data-testid={TEST_IDS.emailRowStar}
                    role="button"
                    tabIndex={-1}
                    aria-pressed={starred}
                    aria-label={starred ? "Starred" : "Not starred"}
                  >
                    <Glyph svg={starred ? icons.starFilled() : icons.star()} />
                  </span>
                  <span className="from" data-testid={TEST_IDS.emailRowFrom}>
                    {sender}
                  </span>
                  <span className="subj">
                    <span data-testid={TEST_IDS.emailRowSubject}>
                      {n.email?.subject || "(no subject)"}
                    </span>{" "}
                    <span className="snippet">
                      - <span data-testid={TEST_IDS.emailRowSnippet}>{n.preview}</span>
                    </span>
                  </span>
                  {n.email?.attachments.length ? (
                    <span className="clip" data-testid={TEST_IDS.emailRowAttachment}>
                      <Glyph svg={icons.clip()} />
                    </span>
                  ) : null}
                  <span className="svc" data-testid={TEST_IDS.emailRowService}>
                    {serviceLabel(n.service)}
                  </span>
                  <span className="date" data-testid={TEST_IDS.emailRowDate}>
                    {mailDate(n.createdAt, now)}
                  </span>
                  <span className="hover-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      data-action="mail-archive"
                      data-id={n.id}
                      data-testid={TEST_IDS.emailRowArchive}
                      title="Archive"
                      aria-label="Archive"
                    >
                      <Glyph svg={icons.archive()} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      data-action="mail-delete"
                      data-id={n.id}
                      data-testid={TEST_IDS.emailRowDelete}
                      title="Delete"
                      aria-label="Delete"
                    >
                      <Glyph svg={icons.trash()} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      data-action="mail-toggle-read"
                      data-id={n.id}
                      data-testid={TEST_IDS.emailRowToggleRead}
                      title={unread ? "Mark as read" : "Mark as unread"}
                      aria-label={unread ? "Mark as read" : "Mark as unread"}
                    >
                      <Glyph svg={unread ? icons.markRead() : icons.markUnread()} />
                    </button>
                    <IconButton svg={icons.clock()} />
                  </span>
                </div>
              </div>
            )
          })
        ) : (
          <div className="mail-empty" data-testid={TEST_IDS.emailEmpty}>
            <Glyph svg={icons.envelope()} />
            <b>{to ? "Your Primary tab is empty." : "No email yet"}</b>
            {to ? "" : "Email sent through Resend, SES, SNS, Customer.io or Mailosaur lands here."}
          </div>
        )}
      </div>
    </>
  )
}

/** The webmail window, open on `state.email.to`'s inbox or one of its messages. */
export function EmailDevice() {
  const store = useStore()
  const to = store.state.email.to
  const items = store.emailItems()
  const unread = items.filter((n) => store.isUnread(n.id)).length
  const open = items.find((n) => n.id === store.state.email.open)
  const me = to ?? "you@example.test"
  const toast = store.state.toast
  return (
    <div
      className="window mbn-skin"
      data-testid={TEST_IDS.emailDevice}
      data-screen={open ? "message" : "inbox"}
      data-recipient={to ?? ""}
    >
      <div className="chrome">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="omnibox">
          <Glyph svg={icons.lock()} /> mail.example.test/#inbox{open ? `/${open.providerId}` : ""}
        </span>
      </div>
      <div className="mail-top">
        <IconButton svg={icons.menu()} />
        <span className="mail-logo">
          <Glyph svg={icons.envelope()} />
          <span className="lbl">Mail</span>
        </span>
        <div className="mail-search">
          <IconButton svg={icons.search("currentColor", 20)} />
          <span className="placeholder">Search mail</span>
          <IconButton svg={icons.tune()} />
        </div>
        <div className="right">
          <IconButton svg={icons.help()} />
          <IconButton svg={icons.gear()} />
          <IconButton svg={icons.apps()} />
          <span className="mail-avatar" title={me} style={{ background: colorFor(me) }}>
            {me.slice(0, 1).toUpperCase()}
          </span>
        </div>
      </div>
      <div className="mail-body">
        <nav className="mail-nav">
          <button type="button" className="compose">
            <Glyph svg={icons.pencil()} />
            <span className="lbl">Compose</span>
          </button>
          <div className="nav-item active">
            <Glyph svg={icons.inbox()} />
            <span className="lbl">Inbox</span>
            <span className="n">{unread || ""}</span>
          </div>
          <div className="nav-item">
            <Glyph svg={icons.star()} />
            <span className="lbl">Starred</span>
          </div>
          <div className="nav-item">
            <Glyph svg={icons.clock()} />
            <span className="lbl">Snoozed</span>
          </div>
          <div className="nav-item">
            <Glyph svg={icons.send()} />
            <span className="lbl">Sent</span>
          </div>
          <div className="nav-item">
            <Glyph svg={icons.draft()} />
            <span className="lbl">Drafts</span>
          </div>
          <div className="nav-item">
            <Glyph svg={icons.expand()} />
            <span className="lbl">More</span>
          </div>
        </nav>
        <div className="mail-main">
          {open ? <Reader open={open} items={items} me={me} /> : <Inbox to={to} items={items} />}
        </div>
      </div>
      {toast ? (
        <div className="toast" data-testid={TEST_IDS.toast} role="status">
          <span>{toast.text}</span>
          {toast.undo ? (
            <button type="button" data-action="toast-undo" data-testid={TEST_IDS.toastUndo}>
              Undo
            </button>
          ) : null}
          <button type="button" data-action="toast-close" aria-label="Dismiss">
            <Glyph svg={icons.close(16)} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
