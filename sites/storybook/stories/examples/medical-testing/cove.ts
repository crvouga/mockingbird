/**
 * The medical-testing example ("Cove") in a story: a fresh in-process instance of the whole app
 * (Hono app, Postgres, and the OAuth, Stripe, Junction, Resend, Twilio, FCM and Slack emulators
 * behind it), put in the state a screen shows through the app's own API, then the real Preact
 * client mounted on it.
 *
 * The client is mounted into the story's canvas, not a frame: it is written for the document it
 * runs in (`document` for its modals' focus trap and Escape, `window` for its router), the way
 * the docs site embeds it, and its stylesheet is scoped under `.cove-app`. So its `play`
 * functions use `person()` here rather than `hands()`, which reaches into a frame.
 */
import type { StoryObj } from "@storybook/html-vite"
import { userEvent } from "storybook/test"
import {
  api,
  type Fetcher,
  setFetcher,
} from "../../../../../packages/examples/medical-testing/src/client/api.js"
import { setInboxOpener } from "../../../../../packages/examples/medical-testing/src/client/inbox.js"
import { mountApp } from "../../../../../packages/examples/medical-testing/src/client/main.js"
import {
  navigate,
  type Route,
} from "../../../../../packages/examples/medical-testing/src/client/router.js"
import { STYLES } from "../../../../../packages/examples/medical-testing/src/client/theme.js"
import {
  buildDemo,
  type Demo,
} from "../../../../../packages/examples/medical-testing/src/composition/build.js"
import { createInProcessFetcher } from "../../../../../packages/examples/medical-testing/src/composition/inProcessFetcher.js"
import { payWithHostedCheckout } from "../../../../../packages/examples/medical-testing/testing/inProcessFlow.js"

export type { Demo }

/** The seeded demo accounts (`composition/seedWorkspace.ts`). */
export const PATIENT = "ada@example.test"
export const CLINICIAN = "clinician@example.test"
export const ADMIN = "admin@example.test"
/** An address with no account yet: signing in creates one, with no orders and no phone. */
export const NEWCOMER = "grace.hopper@example.com"

/** Every UI file of the client; a story names the ones its screen draws on top of these. */
export const SHELL = [
  "packages/examples/medical-testing/src/client/main.ts",
  "packages/examples/medical-testing/src/client/theme.ts",
  "packages/examples/medical-testing/src/client/router.ts",
  "packages/examples/medical-testing/src/client/components/Icons.ts",
  "packages/examples/medical-testing/src/client/components/Logo.ts",
  "packages/examples/medical-testing/src/client/components/States.ts",
  "packages/examples/medical-testing/src/composition/inProcessFetcher.ts",
  "packages/examples/medical-testing/src/composition/buildClientAssets.ts",
  "packages/examples/medical-testing/src/app/http/app.ts",
]

export type Setup = {
  /** Sign in as this address (by the emailed code, as a person would) before the app opens. */
  as?: string
  /** The screen to open once signed in. */
  route?: Route
  /** Anything else the screen needs, through the app's API (`api` is signed in as `as`). */
  prepare?: (demo: Demo) => Promise<void>
  /** Wraps the app's transport, for the states only a failing server shows. */
  transport?: (fetcher: Fetcher) => Fetcher
}

/** The six-digit code from the newest sign-in email to `email`. */
export async function signInCode(demo: Demo, email: string, nth = 1): Promise<string> {
  const mails = await demo.notifications.waitFor(
    { channel: "email", to: email, contains: "sign-in code" },
    { count: nth },
  )
  const code = /^(\d{6}) is your Cove sign-in code$/.exec(mails.at(-1)?.email?.subject ?? "")?.[1]
  if (!code) throw new Error(`no sign-in code reached ${email}`)
  return code
}

/** Sign in by the emailed code, through the same calls the sign-in screen makes. */
export async function signIn(demo: Demo, email: string): Promise<void> {
  await api.emailStart(email)
  await api.emailVerify(email, await signInCode(demo, email))
}

/** An order for the named catalog tests, left at the payment step. */
export async function placeOrder(
  ...names: string[]
): Promise<{ orderId: string; checkoutSessionId: string }> {
  const { tests } = await api.tests()
  const ids = names.map((name) => {
    const test = tests.find((candidate) => candidate.name === name)
    if (!test) throw new Error(`no "${name}" in the catalog`)
    return test.id
  })
  return api.checkout(ids)
}

/** An order paid with the Visa test card, once the lab has taken it (`fulfilled`). */
export async function paidOrder(...names: string[]): Promise<string> {
  const { orderId, checkoutSessionId } = await placeOrder(...names)
  await payWithHostedCheckout(checkoutSessionId)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { orders } = await api.orders()
    if (orders.find((order) => order.id === orderId)?.labOrderId) return orderId
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("the lab never took the paid order")
}

let unmount: (() => void) | undefined

/** A fresh app, signed in (or not) and prepared, with the transport the client will use. */
export async function start(setup: Setup = {}): Promise<Demo> {
  unmount?.()
  unmount = undefined
  const demo = await buildDemo({ html: "", js: "" })
  const fetcher = createInProcessFetcher(demo.app)
  setFetcher(fetcher)
  if (setup.as) await signIn(demo, setup.as)
  await setup.prepare?.(demo)
  if (setup.transport) setFetcher(setup.transport(fetcher))
  return demo
}

/** The app's stylesheet, once per preview document, as `composition/browser.ts` adds it. */
function styles(): void {
  if (document.getElementById("cove-app-styles")) return
  const style = document.createElement("style")
  style.id = "cove-app-styles"
  style.textContent = STYLES
  document.head.append(style)
}

/** Mount the client on the app `start` built, and open `route` once the shell is up. */
export function draw(demo: Demo, route?: Route): HTMLElement {
  styles()
  const root = document.createElement("div")
  root.style.cssText = "height:100vh"
  // The Workspace story shows where "Open Notifications" lands; here it goes nowhere.
  setInboxOpener(() => {})
  const stop = mountApp(root, true)
  unmount = () => {
    stop()
    demo.notifications.close()
  }
  if (route && route !== "dashboard") {
    const observer = new MutationObserver(() => {
      if (!root.querySelector(".cove-shell")) return
      observer.disconnect()
      navigate(route)
    })
    observer.observe(root, { childList: true, subtree: true })
  }
  return root
}

/** A story of the app in the state `setup` puts it in. */
export function cove(
  setup: Setup = {},
  extra: Omit<StoryObj, "render" | "loaders"> = {},
): StoryObj {
  return {
    ...extra,
    loaders: [async () => ({ demo: await start(setup) })],
    render: (_args, context) => draw((context.loaded as { demo: Demo }).demo, setup.route),
  }
}

/** The phone viewport, for a story people use on phones. */
export const phone = { viewport: { value: "phone", isRotated: false } }

export type Person = {
  /** The first element matching `selector` (and containing `text`), waiting for it to appear. */
  find<T extends HTMLElement = HTMLElement>(selector: string, text?: string): Promise<T>
  /** Click into the field and type, one key at a time. */
  type(selector: string, text: string): Promise<void>
  click(selector: string, text?: string): Promise<void>
  /** Wait until nothing matches `selector` (and contains `text`). */
  gone(selector: string, text?: string): Promise<void>
}

/** A person's hands on the app in the canvas: find by selector (and visible text), type, press. */
export function person(canvas: HTMLElement): Person {
  const user = userEvent.setup({ delay: 8 })
  const match = <T extends HTMLElement>(selector: string, text?: string) =>
    [...canvas.querySelectorAll<T>(selector)].find(
      (element) => !text || element.textContent?.includes(text),
    )
  const find = async <T extends HTMLElement>(selector: string, text?: string): Promise<T> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const element = match<T>(selector, text)
      if (element) return element
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`Nothing matches ${selector}${text ? ` with "${text}"` : ""}`)
  }
  return {
    find,
    async type(selector, text) {
      await user.click(await find(selector))
      await user.keyboard(text)
    },
    async click(selector, text) {
      await user.click(await find(selector, text))
    },
    async gone(selector, text) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (!match(selector, text)) return
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      throw new Error(`${selector}${text ? ` with "${text}"` : ""} never went away`)
    },
  }
}
