/**
 * What the sign-in stories share: the app every flow returns to, a person's clicks on pages that
 * name their buttons by text rather than `data-testid`, and where the browser was sent once a
 * flow left the emulator.
 */
import { expect, userEvent } from "storybook/test"
import type { Emulator } from "../../../src/frame.js"
import { hands } from "../../../src/interact.js"

/** The app's callback every sign-in in these stories returns to. */
export const CALLBACK = "https://app.example/callback"

export const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

/**
 * The emulator, minus the scripts that post a page's form on by themselves. A `form_post`
 * response submits on load with `form.submit()`, which fires no submit event, so the story's
 * frame could not keep that navigation on the emulator and the tab would leave for the app. The
 * page stays put instead, as it would with scripts off, and its own Continue button still works.
 */
export function holdFormPosts(emulator: Emulator): Emulator {
  return {
    async fetch(request) {
      const response = await emulator.fetch(request)
      if (!response.headers.get("content-type")?.includes("html")) return response
      const html = (await response.text())
        .replace(/ onload="document\.forms\[0\]\.submit\(\)"/, "")
        .replace(
          /<script nonce="[^"]*">document\.getElementById\('callback'\)\.submit\(\)<\/script>/,
          "",
        )
      return new Response(html, { status: response.status, headers: response.headers })
    },
  }
}

/** Every request carries `headers`, as a browser holding that session would send them. */
export function signedIn(emulator: Emulator, headers: Record<string, string>): Emulator {
  return {
    fetch(request) {
      const next = new Request(request)
      for (const [name, value] of Object.entries(headers)) next.headers.set(name, value)
      return emulator.fetch(next)
    },
  }
}

/** The first `selector` in the frame whose text contains `text`, waiting for it to appear. */
export async function find<T extends HTMLElement = HTMLElement>(
  canvas: HTMLElement,
  text: string,
  selector = "button, a",
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const doc = (await hands(canvas)).doc
    const match = [...doc.querySelectorAll<T>(selector)].find((element) =>
      element.textContent?.includes(text),
    )
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Nothing like ${selector} reads "${text}"`)
}

/** Press the button or link that reads `text`, and wait for the page it leads to. */
export async function press(canvas: HTMLElement, text: string, selector = "button, a") {
  const page = await hands(canvas)
  const target = await find(canvas, text, selector)
  await userEvent.setup({ document: page.doc }).click(target)
  return page.navigated()
}

/** Where the browser was sent once the flow left the emulator (the frame stops there). */
export async function departedTo(canvas: HTMLElement): Promise<URL> {
  const page = await hands(canvas)
  const stop = await page.get("storybook-departure")
  const address = stop.querySelector("code")?.textContent ?? ""
  expect(address).not.toBe("")
  return new URL(address)
}

/** Assert the frame shows text, waiting for it to arrive. */
export async function shows(canvas: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const doc = (await hands(canvas)).doc
    if (doc.body?.textContent?.includes(text)) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  expect((await hands(canvas)).doc.body?.textContent).toContain(text)
}

/**
 * The vendor sign-in cards (GitHub, Slack, Apple…) list one button per seeded user: press the one
 * that reads `login`, and return where the browser was sent.
 */
export async function pickAccount(canvas: HTMLElement, login: string): Promise<URL> {
  await press(canvas, login, "button.user-btn")
  return departedTo(canvas)
}

/** `pickAccount`, for a vendor answering in `form_post`: the page that holds the code. */
export async function pickAccountFormPost(canvas: HTMLElement, login: string) {
  const page = await press(canvas, login, "button.user-btn")
  const form = page.doc.querySelector<HTMLFormElement>("form[method=POST]")
  expect(form?.getAttribute("action")).toBe(CALLBACK)
  expect(form?.querySelector<HTMLInputElement>('input[name="code"]')?.value).toBeTruthy()
  return page
}
