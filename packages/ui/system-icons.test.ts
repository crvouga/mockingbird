import { expect, test } from "bun:test"
import { iconSources, SYSTEM_ICONS } from "./src/system-icons.js"

test("a favicon icon tries the site's favicon, then its touch icon", () => {
  expect(iconSources({ favicon: "https://lab.example/app/page?x=1" })).toEqual([
    "https://lab.example/favicon.ico",
    "https://lab.example/apple-touch-icon.png",
  ])
})

test("an image icon is used as given; SVG, a missing icon and a bad URL need no image", () => {
  expect(iconSources({ src: "/icons/app.png" })).toEqual(["/icons/app.png"])
  expect(iconSources(SYSTEM_ICONS.emulators)).toEqual([])
  expect(iconSources(undefined)).toEqual([])
  expect(iconSources({ favicon: "not a url" })).toEqual([])
})

test("Mockingbird's own icons are theme-following inline SVG", () => {
  for (const icon of Object.values(SYSTEM_ICONS)) {
    expect(icon.svg).toStartWith("<svg")
    expect(icon.svg).toContain('stroke="currentColor"')
    expect(icon.svg).toContain('aria-hidden="true"')
  }
})
