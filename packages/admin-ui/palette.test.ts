import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { matchCommands, type PaletteCommand, PaletteSearch } from "./src/palette.js"

const commands: PaletteCommand[] = Array.from({ length: 12 }, (_, index) => ({
  id: `notes:screen-${index}`,
  label: `Notes · Screen ${index}`,
  detail: `Open screen ${index}`,
  keywords: index % 2 ? "odd" : "even",
  icon: null,
  run: () => {},
}))

const colors = { surface: "#fff", border: "#ddd", selected: "#eef" }

const render = (query: string, active: number): string =>
  renderToStaticMarkup(
    createElement(PaletteSearch, {
      commands,
      query,
      active,
      onQuery: () => {},
      onActive: () => {},
      onChoose: () => {},
      colors,
    }),
  )

const attribute = (html: string, tag: RegExp, name: string): string | undefined =>
  html.match(tag)?.[0].match(new RegExp(`${name}="([^"]*)"`))?.[1]

describe("command palette", () => {
  test("the search box names the highlighted option, so focus can stay in the box", () => {
    const html = render("", 9)
    const input = /<input[^>]*>/
    const listbox = attribute(html, /<div[^>]*role="listbox"[^>]*>/, "id")
    const highlighted = attribute(html, /<button[^>]*aria-selected="true"[^>]*>/, "id")
    expect(attribute(html, input, "role")).toBe("combobox")
    expect(listbox).toBeTruthy()
    expect(attribute(html, input, "aria-controls")).toBe(listbox)
    expect(highlighted).toBeTruthy()
    expect(attribute(html, input, "aria-activedescendant")).toBe(highlighted)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toContain("Notes · Screen 9")
  })

  test("a highlight past a shorter filtered list stays on its last option", () => {
    const html = render("odd", 40)
    const options = [...html.matchAll(/<button[^>]*role="option"[^>]*>/g)].map((m) => m[0])
    expect(options).toHaveLength(6)
    expect(options.at(-1)).toContain('aria-selected="true"')
    expect(attribute(html, /<input[^>]*>/, "aria-activedescendant")).toBe(
      attribute(options.at(-1) ?? "", /<button[^>]*>/, "id"),
    )
  })

  test("with no match there is no highlighted option to announce", () => {
    const html = render("nothing matches this", 0)
    expect(html).toContain("No commands found")
    expect(html).not.toContain("aria-activedescendant")
    expect(matchCommands(commands, "  SCREEN   1 ")).toHaveLength(3)
  })
})
