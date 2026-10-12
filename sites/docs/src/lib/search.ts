const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")

export const terms = (query: string): string[] =>
  fold(query)
    .split(/[\s,]+/)
    .filter(Boolean)

export interface Searchable {
  name: string
  displayName: string
  /** What the entry is about, in a few chosen words: they rank above a mention in `text`. */
  keywords?: string
  text: string
}

/**
 * Lower is better; `null` means no match. Every term must match somewhere: the name ranks
 * above the vendor name, which ranks above the entry's own keywords, which rank above the
 * description and everything else it mentions.
 */
export function score(queryTerms: readonly string[], item: Searchable): number | null {
  if (queryTerms.length === 0) return 0
  const name = fold(item.name)
  const display = fold(item.displayName)
  const keywords = fold(item.keywords ?? "")
  const text = fold(item.text)
  let total = 0
  for (const t of queryTerms) {
    if (name === t || display === t) total += 0
    else if (name.startsWith(t) || display.startsWith(t)) total += 1
    else if (name.includes(t) || display.includes(t)) total += 2
    else if (keywords.includes(t)) total += 3
    else if (text.includes(t)) total += 5
    else return null
  }
  return total
}
