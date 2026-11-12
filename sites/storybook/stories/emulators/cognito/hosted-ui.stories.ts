import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { CALLBACK, departedTo, shows } from "../oauth/browser.js"
import { cognito, ORIGIN } from "./cognito.js"

/**
 * The Cognito hosted UI (`/oauth2/authorize`): an account picker that stands in for the pool's
 * sign-in page, or for a federated provider's when the app passes `identity_provider`. Picking an
 * account answers with a redirect to the app's callback, where the story stops; the hosted UI's
 * `/error` page answers requests it cannot send back to the app.
 */
export default {
  title: "Emulators/Cognito/Hosted UI",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/service/cognito/src/hosted-ui.ts", "packages/service/cognito/src/index.ts"],
  },
} satisfies Meta

/** A pool with an app client and two users, opened on `/oauth2/authorize?{params}`. */
const pool = (
  params: Record<string, string> = {},
  more?: (c: ReturnType<typeof cognito>) => Promise<unknown>,
) =>
  page(async () => {
    const c = cognito()
    await c.client()
    await c.user({ username: "ada", email: "ada@example.test" })
    await c.user({ username: "grace", email: "grace@example.test" })
    await more?.(c)
    return { emulator: c.emulator, url: c.authorize(params) }
  })

export const SignIn: StoryObj = pool()

/** `identity_provider=Google`: the picker stands in for Google's sign-in page. */
export const ContinueWithGoogle: StoryObj = pool({ identity_provider: "Google" })

/** A pool with no users of its own: nothing to pick. */
export const NoUsers: StoryObj = page(async () => {
  const c = cognito()
  await c.client()
  return { emulator: c.emulator, url: c.authorize() }
})

export const OnAPhone: StoryObj = {
  ...pool(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking an account: back to the app's callback with a code and the app's state. */
export const SignedIn: StoryObj = {
  ...pool(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.click("cognito-hosted-account")
    await page.navigated()
    const callback = await departedTo(canvasElement)
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

/** Cancel: back to the app with `error=access_denied`. */
export const Cancelled: StoryObj = {
  ...pool(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.click("cognito-hosted-cancel")
    await page.navigated()
    expect((await departedTo(canvasElement)).searchParams.get("error")).toBe("access_denied")
  },
}

/** An account that never confirmed its sign-up is sent back with Cognito's error. */
export const UnconfirmedUser: StoryObj = {
  ...pool({}, (c) =>
    c.user({ username: "unconfirmed", email: "pending@example.test", confirmed: false }),
  ),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    page.doc.querySelector<HTMLElement>('[data-username="unconfirmed"]')?.click()
    await page.navigated()
    const callback = await departedTo(canvasElement)
    expect(callback.searchParams.get("error_description")).toBe("User is not confirmed.")
  },
}

/** An account an administrator disabled. */
export const DisabledUser: StoryObj = {
  ...pool({}, (c) =>
    c.user({ username: "disabled", email: "disabled@example.test", enabled: false }),
  ),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    page.doc.querySelector<HTMLElement>('[data-username="disabled"]')?.click()
    await page.navigated()
    expect((await departedTo(canvasElement)).searchParams.get("error_description")).toBe(
      "User is disabled.",
    )
  },
}

/** The picker was left open past the ten-minute sign-in window. */
export const SessionExpired: StoryObj = (() => {
  let c: ReturnType<typeof cognito>
  return {
    ...page(async () => {
      c = cognito()
      await c.client()
      await c.user({ username: "ada", email: "ada@example.test" })
      return { emulator: c.emulator, url: c.authorize() }
    }),
    play: async ({ canvasElement }) => {
      await c.admin("/clock", { advance: "11m" })
      const page = await hands(canvasElement)
      await page.click("cognito-hosted-account")
      const next = await page.navigated()
      expect((await next.get("cognito-hosted-error")).textContent).toContain(
        "The sign-in session expired",
      )
    },
  }
})()

/** A `redirect_uri` the app client never registered: Cognito's own error page. */
export const RedirectMismatch: StoryObj = {
  ...pool({ redirect_uri: "https://elsewhere.example/callback" }),
  play: async ({ canvasElement }) => {
    await shows(canvasElement, "redirect_mismatch")
  },
}

/** An unknown `client_id`. */
export const UnknownClient: StoryObj = page(() => {
  const c = cognito()
  return { emulator: c.emulator, url: c.authorize({ client_id: "no-such-client" }) }
})

export const ErrorPage: StoryObj = page(() => ({
  emulator: cognito().emulator,
  url: `${ORIGIN}/error?error=invalid_request&error_description=Something+went+wrong`,
}))
