import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SYSTEM_SHORTCUT,
  matchesShortcut,
  parseShortcut,
  SYSTEM_SECTION_IDS,
  validateSections,
} from "./src/system-shortcut.ts"

const key = (
  init: Partial<{
    key: string
    code: string
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    repeat: boolean
  }>,
) => ({
  key: "",
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...init,
})

describe("systemShortcut (#872)", () => {
  test("the default is Alt+Shift+S", () => {
    expect(DEFAULT_SYSTEM_SHORTCUT).toBe("Alt+Shift+S")
    expect(parseShortcut(DEFAULT_SYSTEM_SHORTCUT)).toEqual({
      alt: true,
      ctrl: false,
      meta: false,
      shift: true,
      key: "s",
    })
  })

  test("matches on the key, or on the code when Alt changes the character", () => {
    const shortcut = parseShortcut("alt+shift+s")
    expect(matchesShortcut(key({ key: "S", altKey: true, shiftKey: true }), shortcut)).toBe(true)
    // macOS: Option+Shift+S types "Í".
    expect(
      matchesShortcut(key({ key: "Í", code: "KeyS", altKey: true, shiftKey: true }), shortcut),
    ).toBe(true)
    expect(matchesShortcut(key({ key: "S", shiftKey: true }), shortcut)).toBe(false)
    expect(
      matchesShortcut(key({ key: "S", altKey: true, shiftKey: true, ctrlKey: true }), shortcut),
    ).toBe(false)
    expect(
      matchesShortcut(key({ key: "S", altKey: true, shiftKey: true, repeat: true }), shortcut),
    ).toBe(false)
    expect(matchesShortcut(key({ key: "F2" }), parseShortcut("F2"))).toBe(true)
    expect(
      matchesShortcut(
        key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }),
        parseShortcut("Ctrl+Shift+1"),
      ),
    ).toBe(true)
  })

  test("an unparseable shortcut throws", () => {
    expect(() => parseShortcut("")).toThrow("no key")
    expect(() => parseShortcut("Hyper+S")).toThrow("unknown modifier Hyper")
    expect(() => parseShortcut("Alt+Alt+S")).toThrow("unknown modifier")
    expect(() => parseShortcut("Alt+Shift")).toThrow("no key after the modifiers")
  })
})

describe("System sections (#870)", () => {
  test("ids are unique, URL-safe and not built in", () => {
    expect([...SYSTEM_SECTION_IDS]).toEqual(["preview", "apps", "backends", "services", "data"])
    expect(() => validateSections([{ id: "flags" }, { id: "boot_timings" }])).not.toThrow()
    expect(() => validateSections([{ id: "flags" }, { id: "flags" }])).toThrow("Duplicate")
    expect(() => validateSections([{ id: "services" }])).toThrow("reserved")
    expect(() => validateSections([{ id: "a b" }])).toThrow("letters, digits")
  })
})
