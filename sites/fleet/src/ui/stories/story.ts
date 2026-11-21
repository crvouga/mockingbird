/**
 * Turns a scenario (an address, the API's answers and, optionally, what a person then does) into
 * a Storybook story that mounts the real dashboard on it.
 */
import type { StoryObj } from "@storybook/html-vite"
import { auditSurface } from "../audit.js"
import { mount } from "../router.js"
import { ROUTES, type RouteKind, SHELL_KIND } from "../routes.js"
import { memoryAddress } from "../runtime.js"
import { createMock, type Mock, type MockRoutes } from "./mock.js"

/** The origin a story's dashboard believes it is served from. */
export const ORIGIN = "https://fleet.example.test"

/** What `index.html` shows inside `#app` until the dashboard draws. */
export const BOOT_MARKUP = '<p class="boot">Loading…</p>'

/** States a person reaches by acting, which the API's answers alone do not show. */
export const INTERACTIONS = [
  /** A problem written under the field it is about. */
  "field-error",
  /** A refusal that belongs to no field, summarised at the top of the form. */
  "form-error",
  /** Submitted, and the answer has not arrived: the button says what it is doing. */
  "pending",
  /** The mutation succeeded and the dashboard landed where its result lives. */
  "landed",
  /** The mutation succeeded and its result screen shows the secret, once. */
  "secret",
  /** The catalog's search box filtered the list. */
  "catalog:results",
  "catalog:no-match",
] as const
export type Interaction = (typeof INTERACTIONS)[number]

export type Scenario = {
  /** The address the dashboard is opened at. */
  path: string
  routes: MockRoutes
  /** What a person does once the screen has appeared. */
  steps?: (page: Page) => void | Promise<void>
  /** The interaction states `steps` ends in. */
  shows?: readonly Interaction[]
}

/** A person's hands on the mounted dashboard. Controls are found the way a person names them. */
export type Page = {
  root: HTMLElement
  /**
   * Fill in the field with this label: type into a text field, pick the option of a select or
   * the radio of a choice whose label starts with `value`.
   */
  fill(label: string, value: string): void
  /** Press the button with this text; a form's button submits the form. */
  press(text: string): Promise<void>
  /** Fill in these fields, then submit the form with its one submit button. */
  submit(values?: Record<string, string>): Promise<void>
}

const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ""

/** Set a control's value the way typing does, so React sees the change. */
function setValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(control) as object
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  if (setter) setter.call(control, value)
  else control.value = value
  control.dispatchEvent(
    new Event(control instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  )
}

function page(root: HTMLElement, mock: Mock): Page {
  const fill = (label: string, value: string) => {
    // A field of a form: its holder carries `data-field`, and its label or legend names it.
    const holder = [...root.querySelectorAll("[data-field]")].find((element) =>
      [...element.querySelectorAll("label, legend, [data-slot=label]")].some(
        (named) => named.closest("[data-field]") === element && text(named) === label,
      ),
    )
    // A choice: one radio per option, chosen by its value or the start of its label.
    const radios = [...(holder?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [])]
    if (holder && radios.length > 0) {
      const radio = radios.find(
        (input) => input.value === value || text(input.closest("label")).startsWith(value),
      )
      if (!radio) throw new Error(`"${label}" has no option "${value}"`)
      radio.click()
      return
    }
    // A select: its options are those of the native select it keeps for the form.
    const select = holder?.querySelector("select")
    if (select) {
      const option = [...select.options].find(
        (entry) => entry.value === value || entry.text.startsWith(value),
      )
      if (!option) throw new Error(`"${label}" has no option "${value}"`)
      setValue(select, option.value)
      return
    }
    const control =
      holder?.querySelector<HTMLInputElement>("input") ??
      root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`) ??
      [...root.querySelectorAll<HTMLInputElement>("input")].find(
        (input) => input.labels && [...input.labels].some((named) => text(named) === label),
      )
    if (!control) throw new Error(`No field named "${label}"`)
    setValue(control, value)
  }
  const press = async (button: HTMLButtonElement) => {
    // Submit the way a browser does, without waiting for the frame to reach its place.
    if (button.form && button.type === "submit")
      button.form.dispatchEvent(
        new SubmitEvent("submit", { submitter: button, bubbles: true, cancelable: true }),
      )
    else button.click()
    await mock.settled()
  }
  return {
    root,
    fill,
    async press(label) {
      const button = [...root.querySelectorAll("button")].find((element) => text(element) === label)
      if (!button) throw new Error(`No button named "${label}"`)
      await press(button)
    },
    async submit(values = {}) {
      for (const [label, value] of Object.entries(values)) fill(label, value)
      const button = root.querySelector<HTMLButtonElement>("form button[type=submit]")
      if (!button) throw new Error("No form to submit")
      await press(button)
    },
  }
}

/**
 * What is wrong with the surface a story drew: the design rules of `audit.ts`, and a surface whose
 * kind is not the one its route declares. Logged as errors, so the screenshot run fails on them.
 */
export function surfaceProblems(root: HTMLElement): string[] {
  const main = root.querySelector("main[data-surface]")
  if (!main) return [] // Still booting: the page shows only what index.html ships.
  const name = main.getAttribute("data-route") ?? ""
  const declared = ROUTES.find((entry) => entry.id === name)?.kind ?? SHELL_KIND
  return auditSurface(root, declared).map((problem) => `${name}: ${problem}`)
}

/** Mount the dashboard on a scenario and resolve with its element once it has come to rest. */
export async function present(scenario: Scenario): Promise<HTMLElement> {
  const real = (globalThis as { realFetch?: typeof fetch }).realFetch ?? globalThis.fetch
  Object.assign(globalThis, { realFetch: real })
  const mock = createMock(scenario.routes, real)
  globalThis.fetch = mock.fetch

  const frame = document.createElement("div")
  frame.className = "story"
  // The states the story claims, for the screenshot run to check against what was drawn.
  frame.dataset.shows = (scenario.shows ?? []).join(" ")
  const root = document.createElement("div")
  root.id = "app"
  root.innerHTML = BOOT_MARKUP
  frame.append(root)
  // React Aria ties a field to its description and error only once they are in the document, so
  // the dashboard is drawn in it from the start; Storybook then moves the frame where it belongs.
  document.body.append(frame)
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
  for (const problem of surfaceProblems(root)) console.error(`Design rule broken: ${problem}`)
  return frame
}

/** A story: `kind` is the kind of surface its address opens on, before any step is taken. */
export type Story = StoryObj & { parameters: { scenario: Scenario; kind: RouteKind } }

const make =
  (kind: RouteKind) =>
  (scenario: Scenario): Story => ({
    tags: [kind],
    loaders: [async () => ({ frame: await present(scenario) })],
    render: (_args, context) => context.loaded.frame as HTMLElement,
    parameters: { scenario, kind },
  })

/** A story that opens on a query surface: data and links, or one of the shell's statements. */
export const query = make("query")
/** A story that opens on a mutation surface: one form, one submit, a Cancel link. */
export const mutation = make("mutation")
