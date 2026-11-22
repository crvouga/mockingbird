export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`

const SQL_KEYWORDS = new Set(
  `select from where insert into values update set delete create table primary key not null unique references integer int text bigint serial bigserial timestamptz timestamp date default join left right inner outer cross on group by order as and or count min max sum avg rank over partition with limit offset distinct case when then else end begin commit rollback drop alter add column index view if exists constraint foreign check cascade returning union all having asc desc true false is in like between cast type window jsonb json replace`.split(
    " ",
  ),
)

/** Token colors, from the theme: keywords and keys in the accent, strings green, numbers amber. */
const SQL = {
  keyword: "text-accent",
  string: "text-success",
  number: "text-warning-soft-foreground",
  comment: "italic text-muted",
} as const

const JSON_TOKENS = {
  key: "text-accent",
  string: "text-success",
  number: "text-warning-soft-foreground",
  literal: "text-danger",
} as const

/** SQL token classes for the postgres and sqlite consoles. */
export function highlightSql(source: string): string {
  let out = ""
  let i = 0
  const n = source.length
  const paint = (cls: string, text: string) => {
    out += `<span class="${cls}">${escapeHtml(text)}</span>`
  }
  while (i < n) {
    const c = source[i] ?? ""
    const next = source[i + 1]
    if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i)
      const stop = end === -1 ? n : end
      paint(SQL.comment, source.slice(i, stop))
      i = stop
      continue
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      paint(SQL.comment, source.slice(i, stop))
      i = stop
      continue
    }
    if (c === "'") {
      let j = i + 1
      while (j < n) {
        if (source[j] === "'" && source[j + 1] === "'") {
          j += 2
          continue
        }
        if (source[j] === "'") {
          j++
          break
        }
        j++
      }
      paint(SQL.string, source.slice(i, j))
      i = j
      continue
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(i))?.[0]
      if (tag) {
        const end = source.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        paint(SQL.string, source.slice(i, stop))
        i = stop
        continue
      }
    }
    if (c >= "0" && c <= "9" && (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1] ?? ""))) {
      let j = i + 1
      while (j < n && /[0-9.]/.test(source[j] ?? "")) j++
      paint(SQL.number, source.slice(i, j))
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(source[j] ?? "")) j++
      const word = source.slice(i, j)
      if (SQL_KEYWORDS.has(word.toLowerCase())) paint(SQL.keyword, word)
      else out += escapeHtml(word)
      i = j
      continue
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)

/** Pretty JSON with token classes; small enough that shipping a highlighter isn't worth it. */
export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, replacer, 2) ?? "undefined"
  return escapeHtml(json).replace(
    /(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str: string | undefined, colon: string | undefined, lit: string | undefined) => {
      if (str)
        return colon
          ? `<span class="${JSON_TOKENS.key}">${str}</span>${colon}`
          : `<span class="${JSON_TOKENS.string}">${str}</span>`
      if (lit) return `<span class="${JSON_TOKENS.literal}">${lit}</span>`
      return `<span class="${JSON_TOKENS.number}">${match}</span>`
    },
  )
}
