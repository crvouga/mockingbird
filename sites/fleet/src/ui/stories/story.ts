/**
 * Turns a scenario (an address, the API's answers and, optionally, what a person then does) into
 * a Storybook story that mounts the real dashboard on it.
 */
import type { StoryObj } from "@storybook/html-vite"
import { mount } from "../router.js"
import { memoryAddress } from "../runtime.js"
import { createMock, type Mock, type MockRoutes } from "./mock.js"

/** The origin a story's dashboard believes it is served from. */
export const ORIGIN = "https://fleet.example.test"

/** What `index.html` shows inside `#app` until the dashboard draws. */
export const BOOT_MARKUP = '<p class="boot">Loading…</p>'

/** States a person reaches by acting, which the API's answers alone do not show. */
export const INTERACTIONS = [
  "flash",
  "secret:invite",
  "secret:api-key",
  "secret:token",
  "catalog:open",
  "catalog:results",
  "catalog:no-match",
] as const

export type Scenario = {
  /** The address the dashboard is opened at. */
  path: string
  routes: MockRoutes
  /** What a person does once the screen has appeared. */
  steps?: (page: Page) => void | Promise<void>
  /** The interaction states `steps` ends in. */
  shows?: readonly (typeof INTERACTIONS)[number][]
}

/** A person's hands on the mounted dashboard. Controls are found the way a person names them. */
export type Page = {
  root: HTMLElement
  /** Type into the field with this accessible name. */
  type(label: string, value: string): void
  /** Put the cursor in the field with this accessible name. */
  focus(label: string): void
  /** Pick an option of the select with this accessible name. */
  choose(label: string, value: string): Promise<void>
  /** Press the button with this text; a form's button submits the form. */
  press(text: string): Promise<void>
}

function page(root: HTMLElement, mock: Mock): Page {
  const control = (label: string) => {
    const found = [...root.querySelectorAll<HTMLInputElement>("input, select")].find(
      (element) =>
        element.getAttribute("aria-label") === label ||
        element.closest("label")?.textContent?.trim().startsWith(label),
    )
    if (!found) throw new Error(`No field named "${label}"`)
    return found
  }
  return {
    root,
    type(label, value) {
      const input = control(label)
      input.value = value
      input.dispatchEvent(new Event("input", { bubbles: true }))
    },
    focus(label) {
      control(label).dispatchEvent(new Event("focus"))
    },
    async choose(label, value) {
      const select = control(label)
      select.value = value
      select.dispatchEvent(new Event("change", { bubbles: true }))
      await mock.settled()
    },
    async press(text) {
      const button = [...root.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === text,
      )
      if (!button) throw new Error(`No button named "${text}"`)
      // The dashboard is not in the document yet, where a browser would not submit a form.
      if (button.form && button.type === "submit")
        button.form.dispatchEvent(
          new SubmitEvent("submit", { submitter: button, bubbles: true, cancelable: true }),
        )
      else button.click()
      await mock.settled()
    },
  }
}

/** Mount the dashboard on a scenario and resolve with its element once it has come to rest. */
export async function present(scenario: Scenario): Promise<HTMLElement> {
  const real = (globalThis as { realFetch?: typeof fetch }).realFetch ?? globalThis.fetch
  Object.assign(globalThis, { realFetch: real })
  const mock = createMock(scenario.routes, real)
  globalThis.fetch = mock.fetch

  const frame = document.createElement("div")
  frame.className = "story"
  const root = document.createElement("div")
  root.id = "app"
  root.innerHTML = BOOT_MARKUP
  frame.append(root)
  // Links the dashboard leaves to the browser (sign-in, a modified click) lead nowhere here.
  frame.addEventListener("click", (event) => {
    if (!event.defaultPrevented && (event.target as Element).closest("a[href]"))
      event.preventDefault()
  })

  // When the API fails before the first screen, the page keeps what it was showing.
  void mount(root, memoryAddress(scenario.path, ORIGIN)).catch(() => {})
  await mock.settled()
  await scenario.steps?.(page(root, mock))
  await mock.settled()
  return frame
}

export type Story = StoryObj & { parameters: { scenario: Scenario } }

export function story(scenario: Scenario): Story {
  return {
    loaders: [async () => ({ frame: await present(scenario) })],
    render: (_args, context) => context.loaded.frame as HTMLElement,
    parameters: { scenario },
  }
}
