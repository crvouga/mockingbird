/**
 * The Worker config a named Preview may be deployed from: static files only. A `main`, a binding, a
 * var or `run_worker_first` would make requests run Worker code (billable per request), so any of
 * them is refused rather than ignored.
 */
export type AssetsOnlyConfig = {
  compatibilityDate?: string
  htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"
  notFoundHandling?: "none" | "404-page" | "single-page-application"
}

/** Keys that describe where and how static files are served, never code or bindings. */
const TOP_LEVEL = new Set([
  "$schema",
  "name",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "assets",
  "workers_dev",
  "preview_urls",
  "routes",
  "route",
  "observability",
  "upload_source_maps",
  "send_metrics",
  "keep_vars",
])
const ASSETS = new Set(["directory", "html_handling", "not_found_handling"])
const HTML = ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"] as const
const NOT_FOUND = ["none", "404-page", "single-page-application"] as const

const empty = (value: unknown) =>
  value === undefined ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && value !== null && Object.keys(value).length === 0)

/**
 * Validates a parsed wrangler config for an assets-only Worker and returns the asset settings a
 * named Preview deploys with. Throws, naming every offending key, otherwise.
 */
export function assertAssetsOnlyConfig(config: unknown): AssetsOnlyConfig {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("The Worker config must be an object")
  const record = config as Record<string, unknown>
  const refused: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (key === "vars" || key === "keep_vars") {
      if (key === "vars" && !empty(value)) refused.push("vars")
      continue
    }
    if (!TOP_LEVEL.has(key) && !empty(value)) refused.push(key)
  }
  const assets = record.assets
  let htmlHandling: AssetsOnlyConfig["htmlHandling"]
  let notFoundHandling: AssetsOnlyConfig["notFoundHandling"]
  if (assets !== undefined) {
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) refused.push("assets")
    else {
      const entries = assets as Record<string, unknown>
      for (const [key, value] of Object.entries(entries)) {
        if (!ASSETS.has(key) && !empty(value)) refused.push(`assets.${key}`)
      }
      const html = entries.html_handling
      if (html !== undefined) {
        if (!(HTML as readonly unknown[]).includes(html)) refused.push("assets.html_handling")
        else htmlHandling = html as AssetsOnlyConfig["htmlHandling"]
      }
      const notFound = entries.not_found_handling
      if (notFound !== undefined) {
        if (!(NOT_FOUND as readonly unknown[]).includes(notFound))
          refused.push("assets.not_found_handling")
        else notFoundHandling = notFound as AssetsOnlyConfig["notFoundHandling"]
      }
    }
  }
  if (refused.length > 0)
    throw new Error(
      `A named Preview serves static files only; the Worker config declares ${refused.join(", ")}. Remove them (no main, bindings, vars or run_worker_first) so a preview can never run billable Worker code.`,
    )
  const date = record.compatibility_date
  return {
    ...(typeof date === "string" ? { compatibilityDate: date } : {}),
    ...(htmlHandling ? { htmlHandling } : {}),
    ...(notFoundHandling ? { notFoundHandling } : {}),
  }
}

/** Parses JSON with comments and trailing commas (a `wrangler.jsonc`). */
export function parseJsonc(text: string): unknown {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const character = text[i] as string
    if (character === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (character === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (character === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 1
    } else if (character === ",") {
      const next = text.slice(i + 1).match(/^\s*(.)/)?.[1]
      if (next !== "}" && next !== "]") out += character
    } else out += character
  }
  return JSON.parse(out)
}
