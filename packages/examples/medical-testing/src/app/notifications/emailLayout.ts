/** One branded layout for every email the app sends, with a plain-text twin. */
export const BRAND = "Cove"

/**
 * The Mockingbird theme's light tokens (`packages/ui/src/tokens.css`), as literal colors: email
 * clients run no stylesheet and no `light-dark()`, so the layout is tables with inline styles,
 * in the same palette, radius and font stack as the app.
 */
const T = {
  background: "#f6f8fa",
  surface: "#ffffff",
  surfaceSecondary: "#f6f8fa",
  foreground: "#1f2328",
  muted: "#59636e",
  border: "#d8dee4",
  accent: "#2563eb",
  accentForeground: "#ffffff",
  radius: "6px",
  font: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "ui-monospace,'SF Mono',Menlo,Consolas,monospace",
} as const

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
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${T.foreground}">${escapeHtml(line)}</p>`,
    )
    .join("")

const cell = `padding:10px 0;border-bottom:1px solid ${T.border};font-size:14px;color:${T.foreground}`

export const emailHtml = (input: EmailContent): string => {
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>`
    : ""
  const code = input.code
    ? `<p style="margin:6px 0 20px;padding:16px 12px;background:${T.surfaceSecondary};border:1px solid ${T.border};border-radius:${T.radius};text-align:center;font-family:${T.mono};font-size:30px;font-weight:700;letter-spacing:8px;color:${T.foreground}">${escapeHtml(input.code)}</p>`
    : ""
  const table = input.table
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 20px">${input.table.rows
        .map(
          ([label, value]) =>
            `<tr><td style="${cell}">${escapeHtml(label)}</td><td align="right" style="${cell};white-space:nowrap">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}${
        input.table.total
          ? `<tr><td style="padding:12px 0 0;font-size:15px;font-weight:700;color:${T.foreground}">${escapeHtml(input.table.total[0])}</td><td align="right" style="padding:12px 0 0;font-size:15px;font-weight:700;color:${T.foreground}">${escapeHtml(input.table.total[1])}</td></tr>`
          : ""
      }</table>`
    : ""
  const facts = input.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;background:${T.surfaceSecondary};border:1px solid ${T.border};border-radius:${T.radius}">${input.facts
        .map(
          ([label, value]) =>
            `<tr><td style="padding:9px 14px;font-size:13px;color:${T.muted}">${escapeHtml(label)}</td><td align="right" style="padding:9px 14px;font-size:13px;font-weight:600;color:${T.foreground}">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : ""
  const button = `display:inline-block;background:${T.accent};color:${T.accentForeground};border-radius:${T.radius};padding:10px 16px;font-size:14px;font-weight:600;text-decoration:none`
  const cta = input.cta
    ? `<p style="margin:4px 0 22px">${
        input.cta.url
          ? `<a href="${escapeHtml(input.cta.url)}" style="${button}">${escapeHtml(input.cta.label)}</a>`
          : `<span style="${button}">${escapeHtml(input.cta.label)}</span>`
      }</p>`
    : ""
  return `<!doctype html><html><body style="margin:0;padding:0;background:${T.background};font-family:${T.font}">${preheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.background};padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${T.surface};border-radius:${T.radius};overflow:hidden;border:1px solid ${T.border}"><tr><td style="padding:16px 28px;border-bottom:1px solid ${T.border};color:${T.foreground};font-size:16px;font-weight:600">${BRAND} <span style="font-weight:500;color:${T.muted}">Lab testing</span></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:${T.foreground}">${escapeHtml(input.heading)}</h1>${paragraphs(input.intro)}${code}${table}${facts}${cta}${paragraphs(input.outro ?? [])}</td></tr><tr><td style="padding:16px 28px;background:${T.surfaceSecondary};border-top:1px solid ${T.border};font-size:12px;line-height:1.5;color:${T.muted}">${FOOTERS[input.reason]} ${DISCLAIMER}</td></tr></table></td></tr></table></body></html>`
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
