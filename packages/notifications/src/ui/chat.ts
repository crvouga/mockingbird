/**
 * Team-chat message bodies as HTML: Slack mrkdwn, Block Kit blocks and legacy attachments.
 *
 * Pure string functions with no DOM, so they are unit-tested directly. Everything a sender wrote is
 * escaped before any markup is added, and only `http`, `https` and `mailto` links become anchors.
 */

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const row = (value: unknown): Row => (isRow(value) ? value : {})
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : [])
const str = (value: unknown): string => (typeof value === "string" ? value : "")

export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The link target when it is safe to put in an `href` or `src`, else `null`. */
export const safeUrl = (value: string): string | null =>
  /^(https?:\/\/|mailto:)/i.test(value.trim()) ? value.trim() : null

/** The shortcodes notification bots use most; anything else stays as `:name:`. */
const EMOJI: Record<string, string> = {
  "+1": "\u{1F44D}",
  thumbsup: "\u{1F44D}",
  "-1": "\u{1F44E}",
  thumbsdown: "\u{1F44E}",
  tada: "\u{1F389}",
  rocket: "\u{1F680}",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  rotating_light: "\u{1F6A8}",
  fire: "\u{1F525}",
  eyes: "\u{1F440}",
  heart: "❤️",
  wave: "\u{1F44B}",
  bell: "\u{1F514}",
  calendar: "\u{1F4C5}",
  package: "\u{1F4E6}",
  bug: "\u{1F41B}",
  hourglass: "⌛",
  moneybag: "\u{1F4B0}",
  email: "✉️",
  red_circle: "\u{1F534}",
  large_green_circle: "\u{1F7E2}",
  large_yellow_circle: "\u{1F7E1}",
  sparkles: "✨",
  memo: "\u{1F4DD}",
  lock: "\u{1F512}",
  information_source: "ℹ️",
  pray: "\u{1F64F}",
}

export const emoji = (name: string): string => EMOJI[name.toLowerCase()] ?? `:${name}:`

export type ChatNames = {
  /** Display name for a member or channel id, when the workspace knows it. */
  name?: (id: string) => string | undefined
}

/**
 * Slack mrkdwn → HTML: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, code fences, `>` quotes,
 * `<url|label>` links, `<@U…>` and `<#C…>` mentions, `<!here>` and `:emoji:`.
 */
export const mrkdwn = (text: string, names: ChatNames = {}): string => {
  // Finished fragments are parked so later passes cannot format inside a link or code span.
  const parked: string[] = []
  const park = (html: string) => `\u0000${parked.push(html) - 1}\u0000`
  const entities = (value: string) =>
    value
      .replace(/&#38;lt;/g, "&#60;")
      .replace(/&#38;gt;/g, "&#62;")
      .replace(/&#38;amp;/g, "&#38;")
  const raw = (escaped: string) =>
    escaped.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))

  let out = escapeHtml(text)
    .replace(/```\n?([\s\S]*?)```/g, (_, code: string) =>
      park(`<pre class="chat-pre">${entities(code)}</pre>`),
    )
    .replace(/`([^`\n]+)`/g, (_, code: string) =>
      park(`<code class="chat-code">${entities(code)}</code>`),
    )
    .replace(/&#60;(.+?)&#62;/g, (whole: string, inner: string) => {
      const [target = "", label] = inner.split("|") as [string, string | undefined]
      if (target.startsWith("@") || target.startsWith("#")) {
        const id = target.slice(1)
        const shown = label || names.name?.(raw(id)) || id
        return park(`<span class="chat-mention">${target[0]}${escapeHtml(raw(shown))}</span>`)
      }
      if (target.startsWith("!")) {
        const word = target.slice(1).split("^")[0] ?? ""
        return park(`<span class="chat-mention">${label || `@${word}`}</span>`)
      }
      const href = safeUrl(raw(target))
      if (!href) return whole
      return park(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label || target}</a>`,
      )
    })
  out = entities(out)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/gm, "$1<b>$2</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/gm, "$1<i>$2</i>")
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s.,;:!?)])/gm, "$1<s>$2</s>")
    .replace(/:([a-z0-9_+-]+):/gi, (_, name: string) => emoji(name))
    .replace(/(?:^&#62; ?.*(?:\n|$))+/gm, (quote) => {
      const body = quote.replace(/\n$/, "").replace(/^&#62; ?/gm, "")
      return `<blockquote class="chat-quote">${body}</blockquote>`
    })
  // Parked fragments can nest (a link inside bold stays one level), so restore until none remain.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL marks a parked fragment.
  const marker = /\u0000(\d+)\u0000/g
  for (let pass = 0; pass < 3 && out.includes("\u0000"); pass++)
    out = out.replace(marker, (_, index: string) => parked[Number(index)] ?? "")
  return out
}

/** A Block Kit text object (`mrkdwn` or `plain_text`) or a bare string. */
const textObject = (value: unknown, names: ChatNames): string => {
  if (typeof value === "string") return mrkdwn(value, names)
  const t = row(value)
  const text = str(t.text)
  if (!text) return ""
  return t.type === "plain_text"
    ? escapeHtml(text).replace(/:([a-z0-9_+-]+):/gi, (_, name: string) => emoji(name))
    : mrkdwn(text, names)
}

const image = (src: string, alt: string, className: string): string => {
  const url = safeUrl(src)
  return url
    ? `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`
    : ""
}

const button = (element: Row, names: ChatNames): string => {
  const style = element.style === "primary" || element.style === "danger" ? element.style : ""
  return `<span class="chat-btn ${style}" data-block-element="${escapeHtml(str(element.type))}">${textObject(element.text ?? element.placeholder, names) || escapeHtml(str(element.type))}</span>`
}

const element = (value: Row, names: ChatNames): string => {
  if (value.type === "image") return image(str(value.image_url), str(value.alt_text), "chat-thumb")
  if (value.type === "mrkdwn" || value.type === "plain_text")
    return `<span>${textObject(value, names)}</span>`
  return button(value, names)
}

/** One run of a `rich_text` section: styled text, a link, an emoji or a mention. */
const richRun = (run: Row, names: ChatNames): string => {
  const style = row(run.style)
  let html: string
  if (run.type === "link") {
    const url = safeUrl(str(run.url))
    const label = escapeHtml(str(run.text) || str(run.url))
    html = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
      : label
  } else if (run.type === "emoji") html = escapeHtml(emoji(str(run.name)))
  else if (run.type === "user" || run.type === "usergroup")
    html = `<span class="chat-mention">@${escapeHtml(names.name?.(str(run.user_id)) ?? str(run.user_id ?? run.usergroup_id))}</span>`
  else if (run.type === "channel")
    html = `<span class="chat-mention">#${escapeHtml(names.name?.(str(run.channel_id)) ?? str(run.channel_id))}</span>`
  else if (run.type === "broadcast")
    html = `<span class="chat-mention">@${escapeHtml(str(run.range))}</span>`
  else html = escapeHtml(str(run.text))
  if (style.code) html = `<code class="chat-code">${html}</code>`
  if (style.bold) html = `<b>${html}</b>`
  if (style.italic) html = `<i>${html}</i>`
  if (style.strike) html = `<s>${html}</s>`
  return html
}

const richText = (block: Row, names: ChatNames): string =>
  rows(block.elements)
    .map((part) => {
      const runs = rows(part.elements)
      if (part.type === "rich_text_list")
        return `<${part.style === "ordered" ? "ol" : "ul"} class="chat-list-block">${runs
          .map(
            (item) =>
              `<li>${rows(item.elements)
                .map((run) => richRun(run, names))
                .join("")}</li>`,
          )
          .join("")}</${part.style === "ordered" ? "ol" : "ul"}>`
      const body = runs.map((run) => richRun(run, names)).join("")
      if (part.type === "rich_text_preformatted") return `<pre class="chat-pre">${body}</pre>`
      if (part.type === "rich_text_quote")
        return `<blockquote class="chat-quote">${body}</blockquote>`
      return `<div class="chat-text">${body}</div>`
    })
    .join("")

const block = (value: Row, names: ChatNames): string => {
  const type = str(value.type)
  // The type goes in a prefixed class: embedded, a bare `section` or `header` would pick up the
  // host page's own rules for those names.
  const wrap = (body: string, extra = "") =>
    `<div class="chat-block chat-block-${escapeHtml(type)} ${extra}" data-block="${escapeHtml(type)}">${body}</div>`
  switch (type) {
    case "section": {
      const fields = rows(value.fields)
      const accessory = isRow(value.accessory) ? element(value.accessory, names) : ""
      return wrap(
        `<div class="chat-section-body">${value.text ? `<div class="chat-text">${textObject(value.text, names)}</div>` : ""}${
          fields.length
            ? `<div class="chat-fields">${fields.map((f) => `<div class="chat-text">${textObject(f, names)}</div>`).join("")}</div>`
            : ""
        }</div>${accessory ? `<div class="chat-accessory">${accessory}</div>` : ""}`,
        accessory ? "with-accessory" : "",
      )
    }
    case "header":
      return wrap(textObject(value.text, names))
    case "divider":
      return wrap("<hr>")
    case "context":
      return wrap(
        rows(value.elements)
          .map((e) => element(e, names))
          .join(""),
      )
    case "actions":
      return wrap(
        rows(value.elements)
          .map((e) => button(e, names))
          .join(""),
      )
    case "image":
      return wrap(
        `${value.title ? `<div class="chat-caption">${textObject(value.title, names)}</div>` : ""}${image(str(value.image_url), str(value.alt_text), "chat-image")}`,
      )
    case "rich_text":
      return wrap(richText(value, names))
    default:
      return wrap(`<span class="chat-unknown">${escapeHtml(type || "block")}</span>`, "unknown")
  }
}

/** Block Kit blocks as the client would lay them out. Unknown block types show their type name. */
export const renderBlocks = (blocks: unknown, names: ChatNames = {}): string =>
  rows(blocks)
    .map((b) => block(b, names))
    .join("")

const ATTACHMENT_COLORS: Record<string, string> = {
  good: "#2eb67d",
  warning: "#ecb22e",
  danger: "#e01e5a",
}

/** Legacy attachments: the colored bar with a title, text, fields and footer. */
export const renderAttachments = (attachments: unknown, names: ChatNames = {}): string =>
  rows(attachments)
    .map((a) => {
      const named = str(a.color)
      const color =
        ATTACHMENT_COLORS[named] ??
        (/^#?[0-9a-f]{3,8}$/i.test(named) ? `#${named.replace(/^#/, "")}` : "#dddddd")
      const titleLink = safeUrl(str(a.title_link))
      const title = escapeHtml(str(a.title))
      const fields = rows(a.fields)
      return `<div class="chat-attachment" data-color="${escapeHtml(color)}" style="border-left-color:${escapeHtml(color)}">${
        a.pretext ? `<div class="chat-text">${mrkdwn(str(a.pretext), names)}</div>` : ""
      }${a.author_name ? `<div class="chat-att-author">${escapeHtml(str(a.author_name))}</div>` : ""}${
        title
          ? `<div class="chat-att-title">${titleLink ? `<a href="${escapeHtml(titleLink)}" target="_blank" rel="noreferrer">${title}</a>` : title}</div>`
          : ""
      }${a.text ? `<div class="chat-text">${mrkdwn(str(a.text), names)}</div>` : ""}${
        fields.length
          ? `<div class="chat-fields">${fields
              .map(
                (f) =>
                  `<div class="chat-field ${f.short ? "short" : ""}"><b>${escapeHtml(str(f.title))}</b><div class="chat-text">${mrkdwn(str(f.value), names)}</div></div>`,
              )
              .join("")}</div>`
          : ""
      }${renderBlocks(a.blocks, names)}${image(str(a.image_url), str(a.fallback), "chat-image")}${
        a.footer ? `<div class="chat-att-footer">${escapeHtml(str(a.footer))}</div>` : ""
      }</div>`
    })
    .join("")
