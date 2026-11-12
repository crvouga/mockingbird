/**
 * Story factories. Two kinds of UI live in this catalog:
 *
 * - `page`: a page an emulator serves (a hosted Checkout, a sign-in screen, an admin UI). The
 *   story starts the real emulator in the browser, puts it in the state the page shows through
 *   its own API, and opens the page in a frame wired back to it, so it stays usable.
 * - `markup`: a document or fragment drawn by a pure function (an email layout, a report), shown
 *   in a frame so its styles stay its own.
 */
import type { StoryObj } from "@storybook/html-vite"
import { type Emulator, type FrameOptions, frame } from "./frame.js"

export type { Emulator } from "./frame.js"

/** Where a `page` story opens: a runtime in the state the page shows, and the page's address. */
export type Visit = { emulator: Emulator; url: string }

type Extra = Omit<StoryObj, "render" | "loaders">

/** Follow redirects that stay on the emulator, as a browser would, and return the final page. */
export async function open(
  emulator: Emulator,
  url: string,
): Promise<{ url: string; html: string }> {
  let address = url
  for (let hop = 0; hop < 10; hop += 1) {
    const response = await emulator.fetch(new Request(address, { redirect: "manual" }))
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, address)
      if (next.origin !== new URL(address).origin) break
      address = next.href
      continue
    }
    return { url: address, html: await response.text() }
  }
  throw new Error(`${url} kept redirecting`)
}

/** A page an emulator serves, opened after `setup` has put the emulator in the state it shows. */
export function page(
  setup: () => Visit | Promise<Visit>,
  extra: Extra & { frame?: Omit<FrameOptions, "url" | "emulator"> } = {},
): StoryObj {
  const { frame: frameOptions, ...story } = extra
  return {
    ...story,
    loaders: [
      async () => {
        const visit = await setup()
        const opened = await open(visit.emulator, visit.url)
        return { visit, opened }
      },
    ],
    render: (_args, context) => {
      const { visit, opened } = context.loaded as {
        visit: Visit
        opened: { url: string; html: string }
      }
      return frame(opened.html, { ...frameOptions, url: opened.url, emulator: visit.emulator })
    },
  }
}

/** A document (or fragment) drawn by a pure function, in a frame of its own. */
export function markup(
  render: () => string | Promise<string>,
  extra: Extra & { frame?: FrameOptions } = {},
): StoryObj {
  const { frame: frameOptions, ...story } = extra
  return {
    ...story,
    loaders: [async () => ({ html: await render() })],
    render: (_args, context) => frame((context.loaded as { html: string }).html, frameOptions),
  }
}
