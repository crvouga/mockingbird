import { mount } from "@crvouga/mockingbird-ui/react/client"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { createElement } from "react"
import { expect } from "storybook/test"
import { frame, frameDocument } from "../../../src/frame.js"
import { markup } from "../../../src/story.js"
import { Showcase, SignIn } from "./showcase.js"

/**
 * The Mockingbird design system (packages/ui): the HeroUI v3 theme and the shared React
 * components every surface is built from, drawn the two ways surfaces ship them. A page served as
 * a string is rendered on the server with `renderPage` (works without JavaScript); a client-side
 * surface mounts with `mount`, which hydrates server-rendered markup.
 */
export default {
  title: "Admin/Design system/Components",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/document.ts",
      "packages/ui/src/react/app-shell.tsx",
      "packages/ui/src/react/brand.tsx",
      "packages/ui/src/react/centered-card.tsx",
      "packages/ui/src/react/code-block.tsx",
      "packages/ui/src/react/key-value-list.tsx",
      "packages/ui/src/react/page-header.tsx",
      "packages/ui/src/react/provider.tsx",
      "packages/ui/src/react/states.tsx",
      "packages/ui/src/react/status-chip.tsx",
      "packages/ui/src/react/theme-switch.tsx",
      "packages/ui/src/react/server.tsx",
      "packages/ui/src/react/client.tsx",
    ],
  },
} satisfies Meta

const page = (theme: "system" | "light" | "dark") => () =>
  renderPage(createElement(Showcase), { title: "Design system", css: MOCKINGBIRD_CSS, theme })

/** Server-rendered, following the system's light or dark preference. No JavaScript. */
export const Served: StoryObj = markup(page("system"), {
  play: async ({ canvasElement }) => {
    const doc = await frameDocument(canvasElement)
    await expect(doc.querySelector("[data-mockingbird-shell]")).not.toBeNull()
    await expect(doc.querySelector('[aria-current="page"]')?.textContent).toBe("Customers")
  },
})

/** Pinned light (`renderPage({ theme: "light" })`). */
export const Light: StoryObj = markup(page("light"))

/** Pinned dark (`renderPage({ theme: "dark" })`). */
export const Dark: StoryObj = markup(page("dark"))

/** On a phone: the nav scrolls in its own row under the brand and the columns stack. */
export const Phone: StoryObj = markup(page("system"), {
  globals: { viewport: { value: "phone", isRotated: false } },
})

/** A single-purpose page (sign-in, consent, pairing): the brand over one card. */
export const CenteredForm: StoryObj = markup(
  () => renderPage(createElement(SignIn), { title: "Sign in", css: MOCKINGBIRD_CSS }),
  {
    play: async ({ canvasElement }) => {
      const doc = await frameDocument(canvasElement)
      await expect(doc.querySelector("h1")?.textContent).toBe("Sign in")
      await expect(doc.querySelector('form[method="post"] button[type="submit"]')).not.toBeNull()
    },
  },
)

/**
 * The server-rendered page hydrated with `mount`, as a client bundle does: the parts that need
 * JavaScript (the theme switch, copy buttons) appear.
 */
export const Hydrated: StoryObj = {
  loaders: [async () => ({ html: page("system")() })],
  render: (_args, context) => {
    const iframe = frame((context.loaded as { html: string }).html)
    iframe.addEventListener(
      "load",
      () => {
        const root = iframe.contentDocument?.getElementById("root")
        if (root) mount(root, createElement(Showcase))
      },
      { once: true },
    )
    return iframe
  },
  play: async ({ canvasElement }) => {
    const doc = await frameDocument(canvasElement)
    for (let attempt = 0; attempt < 100 && !doc.querySelector('[aria-label="Copy"]'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(doc.querySelector('[aria-label="Copy"]')).not.toBeNull()
    await expect(doc.querySelector('[aria-label="Theme"]')).not.toBeNull()
  },
}
