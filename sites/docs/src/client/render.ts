export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)

/** Pretty JSON with token classes; small enough that shipping a highlighter isn't worth it. */
export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, replacer, 2) ?? "undefined"
  return escapeHtml(json).replace(
    /(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str: string | undefined, colon: string | undefined, lit: string | undefined) => {
      if (str)
        return colon ? `<span class="jk">${str}</span>${colon}` : `<span class="js">${str}</span>`
      if (lit) return `<span class="jl">${lit}</span>`
      return `<span class="jn">${match}</span>`
    },
  )
}
