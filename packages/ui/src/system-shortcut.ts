/** The keyboard shortcut that opens System from anywhere, and the System screen's section ids. */

/** The shortcut that opens System unless `systemShortcut` says otherwise. */
export const DEFAULT_SYSTEM_SHORTCUT = "Alt+Shift+S"

/** A parsed shortcut: the modifiers that must be down (and no others) and the key. */
export type Shortcut = {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** Lowercased `KeyboardEvent.key` ("s", "f2", ".") */
  key: string
}

const MODIFIERS: Record<string, keyof Omit<Shortcut, "key">> = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  shift: "shift",
}

/**
 * Parses "Alt+Shift+S" (modifiers in any order and case: Alt/Option, Ctrl/Control,
 * Meta/Cmd/Command, Shift; then one key). Throws on anything else, so a typo fails at mount.
 */
export function parseShortcut(text: string): Shortcut {
  const parts = text.split("+").map((part) => part.trim())
  const key = parts.pop()
  const shortcut: Shortcut = { alt: false, ctrl: false, meta: false, shift: false, key: "" }
  if (!key) throw new Error(`Invalid shortcut ${JSON.stringify(text)}: no key`)
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier || shortcut[modifier])
      throw new Error(`Invalid shortcut ${JSON.stringify(text)}: unknown modifier ${part}`)
    shortcut[modifier] = true
  }
  if (MODIFIERS[key.toLowerCase()])
    throw new Error(`Invalid shortcut ${JSON.stringify(text)}: no key after the modifiers`)
  shortcut.key = key.toLowerCase()
  return shortcut
}

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat"
>

/**
 * Whether a keydown is the shortcut. Letters and digits match on `code` too, because Alt (Option
 * on a Mac) changes the character `key` reports.
 */
export function matchesShortcut(event: KeyLike, shortcut: Shortcut): boolean {
  if (event.repeat) return false
  if (
    event.altKey !== shortcut.alt ||
    event.ctrlKey !== shortcut.ctrl ||
    event.metaKey !== shortcut.meta ||
    event.shiftKey !== shortcut.shift
  )
    return false
  if (event.key.toLowerCase() === shortcut.key) return true
  const { key } = shortcut
  if (/^[a-z]$/.test(key)) return event.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}`
  return false
}

/** The System screen's own sections, in order; a consumer's `sections` may not reuse these ids. */
export const SYSTEM_SECTION_IDS = ["preview", "apps", "backends", "services", "data"] as const

/** The query parameter that names the System section to show (`?system=flags`). */
export const SYSTEM_SECTION_PARAM = "system"

/** Throws when consumer sections reuse a built-in id, repeat an id, or use one unfit for a URL. */
export function validateSections(sections: readonly { id: string }[]): void {
  const seen = new Set<string>(SYSTEM_SECTION_IDS)
  for (const { id } of sections) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
      throw new Error(`System section id ${JSON.stringify(id)} must be letters, digits, - and _`)
    if (seen.has(id)) throw new Error(`Duplicate or reserved System section: ${id}`)
    seen.add(id)
  }
}
