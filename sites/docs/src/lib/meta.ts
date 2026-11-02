/** Search engines cut a meta description at about this many characters. */
export const META_DESCRIPTION_MAX = 160

/**
 * A page's copy as a meta description: plain text (the shared copy is inline markdown), at most
 * {@link META_DESCRIPTION_MAX} characters. It keeps whole sentences when the first one fits, and
 * otherwise cuts at a word and ends with an ellipsis.
 */
export function metaDescription(copy: string, max = META_DESCRIPTION_MAX): string {
  const text = copy
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim()
  const chars = [...text]
  if (chars.length <= max) return text

  let kept = ""
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
    const next = kept ? `${kept} ${sentence}` : sentence
    if ([...next].length > max) break
    kept = next
  }
  if (kept) return kept

  const head = chars.slice(0, max).join("")
  const cut = head.lastIndexOf(" ")
  return `${(cut > 0 ? head.slice(0, cut) : head.slice(0, max - 1)).replace(/[\s,;:(–—-]+$/, "")}…`
}
