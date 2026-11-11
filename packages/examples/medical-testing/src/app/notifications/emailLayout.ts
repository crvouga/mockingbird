/** One branded layout for every email the app sends, with a plain-text twin. */
export const BRAND = "Cove"
const BRAND_COLOR = "#5b4fe0"

export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** A short, human order reference: `#1A2B3C4D`. */
export const orderRef = (orderId: string): string =>
  `#${orderId.replaceAll("-", "").slice(0, 8).toUpperCase()}`

export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/** Why the member is getting this email. It decides the footer line. */
export type EmailReason = "orders" | "security" | "account"
const FOOTERS: Record<EmailReason, string> = {
  orders: `You are receiving this because email updates are on in your ${BRAND} account settings.`,
  security: `Security messages are always sent, whatever your notification settings.`,
  account: `You are receiving this because you have a ${BRAND} account.`,
}
const DISCLAIMER = "Fictional demonstration data, not for clinical use."

export type EmailContent = {
  /** Hidden inbox preview line. */
  preheader?: string
  heading: string
  intro: string[]
  /** A one-time code, set large and spaced. */
  code?: string
  table?: { rows: [string, string][]; total?: [string, string] }
  /** Label and value pairs under the table: an order reference, a tracking number. */
  facts?: [string, string][]
  /** A button. With `url` it is a real link. */
  cta?: { label: string; url?: string }
  outro?: string[]
  reason: EmailReason
}

const paragraphs = (lines: string[]): string =>
  lines
    .map(
      (line) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f1f24">${escapeHtml(line)}</p>`,
    )
    .join("")

const cell = "padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:#1f1f24"

export const emailHtml = (input: EmailContent): string => {
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>`
    : ""
  const code = input.code
    ? `<p style="margin:6px 0 20px;padding:16px 12px;background:#f4f3fe;border:1px solid #dedbfb;border-radius:10px;text-align:center;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#111114">${escapeHtml(input.code)}</p>`
    : ""
  const table = input.table
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 20px">${input.table.rows
        .map(
          ([label, value]) =>
            `<tr><td style="${cell}">${escapeHtml(label)}</td><td align="right" style="${cell};white-space:nowrap">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}${
        input.table.total
          ? `<tr><td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#1f1f24">${escapeHtml(input.table.total[0])}</td><td align="right" style="padding:12px 0 0;font-size:15px;font-weight:700;color:#1f1f24">${escapeHtml(input.table.total[1])}</td></tr>`
          : ""
      }</table>`
    : ""
  const facts = input.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;background:#fafafc;border:1px solid #ececf0;border-radius:10px">${input.facts
        .map(
          ([label, value]) =>
            `<tr><td style="padding:9px 14px;font-size:13px;color:#6b6b76">${escapeHtml(label)}</td><td align="right" style="padding:9px 14px;font-size:13px;font-weight:600;color:#1f1f24">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : ""
  const button =
    "display:inline-block;background:" +
    BRAND_COLOR +
    ";color:#ffffff;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:600;text-decoration:none"
  const cta = input.cta
    ? `<p style="margin:4px 0 22px">${
        input.cta.url
          ? `<a href="${escapeHtml(input.cta.url)}" style="${button}">${escapeHtml(input.cta.label)}</a>`
          : `<span style="${button}">${escapeHtml(input.cta.label)}</span>`
      }</p>`
    : ""
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${preheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e7ec"><tr><td style="background:${BRAND_COLOR};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${BRAND} <span style="font-weight:400;opacity:.85">Lab testing</span></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#111114">${escapeHtml(input.heading)}</h1>${paragraphs(input.intro)}${code}${table}${facts}${cta}${paragraphs(input.outro ?? [])}</td></tr><tr><td style="padding:16px 28px;background:#fafafc;border-top:1px solid #ececf0;font-size:12px;line-height:1.5;color:#6b6b76">${FOOTERS[input.reason]} ${DISCLAIMER}</td></tr></table></td></tr></table></body></html>`
}

/** The same content as plain text, for clients that do not draw HTML. */
export const emailText = (input: EmailContent): string => {
  const lines = [
    input.heading,
    "",
    ...input.intro,
    ...(input.code ? ["", `    ${input.code}`, ""] : []),
    ...(input.table
      ? [
          "",
          ...input.table.rows.map(([label, value]) => `  ${label}  ${value}`),
          ...(input.table.total ? [`  ${input.table.total[0]}  ${input.table.total[1]}`] : []),
          "",
        ]
      : []),
    ...(input.facts ?? []).map(([label, value]) => `${label}: ${value}`),
    ...(input.cta?.url ? ["", `${input.cta.label}: ${input.cta.url}`, ""] : []),
    ...(input.outro ?? []),
  ]
  return `${lines.join("\n")}\n\n— ${BRAND} Lab testing\n${FOOTERS[input.reason]}\n${DISCLAIMER}\n`
}

export const email = (subject: string, content: EmailContent) => ({
  subject,
  html: emailHtml(content),
  text: emailText(content),
})
