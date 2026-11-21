import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { commandMatches, matchCommands, type PaletteCommand, PaletteSearch } from "./src/palette.js"

const commands: PaletteCommand[] = Array.from({ length: 12 }, (_, index) => ({
  id: `notes:screen-${index}`,
  label: `Notes · Screen ${index}`,
  detail: `Open screen ${index}`,
  keywords: index % 2 ? "odd" : "even",
  icon: null,
  run: () => {},
}))

const render = (query: string): string =>
  renderToStaticMarkup(
    createElement(PaletteSearch, {
      commands,
      query,
      onQuery: () => {},
      onChoose: () => {},
    }),
  )

const attribute = (html: string, tag: RegExp, name: string): string | undefined =>
  html.match(tag)?.[0].match(new RegExp(`${name}="([^"]*)"`))?.[1]

const options = (html: string) => [...html.matchAll(/<[a-z]+[^>]*role="option"[^>]*>/g)]

describe("command palette", () => {
  test("every word must match the label, detail or keywords", () => {
    expect(matchCommands(commands, "  SCREEN   1 ")).toHaveLength(3)
    expect(matchCommands(commands, "odd")).toHaveLength(6)
    expect(matchCommands(commands, "odd screen 3").map((command) => command.id)).toEqual([
      "notes:screen-3",
    ])
    expect(matchCommands(commands, "")).toHaveLength(12)
    expect(commandMatches(commands[0] as PaletteCommand, "even notes")).toBe(true)
  })

  // React Aria wires aria-controls and aria-activedescendant once mounted; the stories check them.
  test("the search box and every command render", () => {
    const html = render("")
    expect(attribute(html, /<div[^>]*role="listbox"[^>]*>/, "aria-label")).toBe("Commands")
    expect(attribute(html, /<input[^>]*>/, "aria-label")).toBe("Admin command palette")
    expect(options(html)).toHaveLength(12)
    expect(html).toContain("Notes · Screen 9")
  })

  test("typing narrows the list to the matching commands", () => {
    const html = render("odd")
    expect(options(html)).toHaveLength(6)
    expect(html).toContain("Notes · Screen 11")
    expect(html).not.toContain("Notes · Screen 10")
  })

  test("with no match the list says so", () => {
    const html = render("nothing matches this")
    expect(html).not.toContain("Notes · Screen")
    expect(html).toContain("No commands found")
  })
})
