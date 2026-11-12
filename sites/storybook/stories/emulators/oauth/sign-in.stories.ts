import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { redirectPage } from "../../../../../packages/service/oauth/src/ui.js"
import { hands } from "../../../src/interact.js"
import { markup, page } from "../../../src/story.js"
import { CALLBACK, departedTo, press, shows } from "./browser.js"
import { ADA, ORIGIN, oauth, signIn } from "./oauth.js"

/**
 * The OAuth emulator's sign-in pages: the account chooser its authorization endpoint answers,
 * creating a test account, the consent card, and the pages that hand the answer back to the app.
 * One emulator stands in for Google, Apple, Microsoft, GitHub or plain OIDC; the pages are the
 * same, Apple adds its choice to hide the email. Allowing or cancelling leaves for the app's
 * callback, where the story stops.
 */
export default {
  title: "Emulators/OAuth/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/service/oauth/src/ui.ts", "packages/service/oauth/src/index.ts"],
  },
} satisfies Meta

const visit = (...args: Parameters<typeof signIn>) =>
  page(async () => {
    const o = await signIn(...args)
    return { emulator: o.emulator, url: o.url }
  })

/** Choose an account, then review access. */
const chooseAda = async (canvas: HTMLElement) => {
  const page = await hands(canvas)
  await page.click(`oauth-mock-account-${ADA.id}`)
  return page.navigated()
}

export const ChooseAnAccount: StoryObj = visit()

/** No test accounts yet: the chooser offers to create one. */
export const NoAccounts: StoryObj = page(async () => {
  const o = oauth()
  await o.client()
  return { emulator: o.emulator, url: o.authorize() }
})

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** The footer's appearance switch, set to dark. */
export const DarkAppearance: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    page.doc.querySelector<HTMLInputElement>('input[name="oauth-theme"][value="dark"]')?.click()
    expect(page.doc.documentElement.dataset.theme).toBe("dark")
  },
}

export const CreateAnAccount: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.click("oauth-mock-create-account")
    const signup = await page.navigated()
    await signup.get("oauth-mock-signup")
  },
}

/** An address the emulator will not take (no dot in the domain). */
export const CreateAnAccountInvalid: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    let page = await hands(canvasElement)
    await page.click("oauth-mock-create-account")
    page = await page.navigated()
    await page.type("oauth-mock-signup-name", "Ada Lovelace")
    await page.type("oauth-mock-signup-email", "ada@localhost")
    await page.click("oauth-mock-signup-submit")
    page = await page.navigated()
    expect((await page.get("oauth-mock-signup-error")).textContent).toContain("valid email address")
  },
}

/** An address that already has an account. */
export const CreateAnAccountTaken: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    let page = await hands(canvasElement)
    await page.click("oauth-mock-create-account")
    page = await page.navigated()
    await page.type("oauth-mock-signup-name", "Ada Again")
    await page.type("oauth-mock-signup-email", ADA.email)
    await page.click("oauth-mock-signup-submit")
    page = await page.navigated()
    expect((await page.get("oauth-mock-signup-error")).textContent).toContain(
      "already has an account",
    )
  },
}

/** A new account goes straight to the consent card. */
export const CreatedAccount: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    let page = await hands(canvasElement)
    await page.click("oauth-mock-create-account")
    page = await page.navigated()
    await page.type("oauth-mock-signup-name", "Katherine Johnson")
    await page.type("oauth-mock-signup-email", "katherine@example.test")
    await page.click("oauth-mock-signup-submit")
    page = await page.navigated()
    expect((await page.get("oauth-mock-consent")).textContent).toContain("katherine@example.test")
  },
}

/** An account removed while the chooser was open. */
export const AccountUnavailable: StoryObj = (() => {
  let admin: ReturnType<typeof oauth>["admin"]
  return {
    ...page(async () => {
      const o = await signIn()
      admin = o.admin
      return { emulator: o.emulator, url: o.url }
    }),
    play: async ({ canvasElement }) => {
      await admin("POST", "/accounts/delete", { accountId: ADA.id })
      const page = await chooseAda(canvasElement)
      expect((await page.get("oauth-mock-chooser-error")).textContent).toContain(
        "Choose an available account.",
      )
    },
  }
})()

export const ReviewAccess: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const page = await chooseAda(canvasElement)
    await page.get("oauth-mock-allow")
  },
}

/** Plain OIDC asking for `offline_access`: the card says the app stays connected. */
export const ReviewAccessOffline: StoryObj = {
  ...visit("oidc"),
  play: async ({ canvasElement }) => {
    await chooseAda(canvasElement)
    await shows(canvasElement, "Stay connected when you’re away")
  },
}

/** Apple asking for the email: share it, or hide it behind a private relay address. */
export const AppleHideMyEmail: StoryObj = {
  ...visit("apple"),
  play: async ({ canvasElement }) => {
    const page = await chooseAda(canvasElement)
    await page.click("oauth-mock-hide-email")
    expect((await page.get<HTMLInputElement>("oauth-mock-hide-email")).checked).toBe(true)
  },
}

/** Apple configured to always hide the email: no choice, just the notice. */
export const AppleAlwaysHidesEmail: StoryObj = (() => {
  let admin: ReturnType<typeof oauth>["admin"]
  return {
    ...page(async () => {
      const o = await signIn("apple")
      admin = o.admin
      await admin("PUT", "/behavior", { apple: { emailMode: "hide" } })
      return { emulator: o.emulator, url: o.url }
    }),
    play: async ({ canvasElement }) => {
      await chooseAda(canvasElement)
      await shows(canvasElement, "A private relay address will be shared with this app.")
    },
  }
})()

/** Allow: back to the app's callback with a code. */
export const Allowed: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    let page = await chooseAda(canvasElement)
    await page.click("oauth-mock-allow")
    page = await page.navigated()
    const callback = await departedTo(canvasElement)
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
  },
}

/**
 * Apple answers in `form_post`: a page holding the code in a form that, in a browser, posts on
 * to the app at once. Here it stays on screen; its Continue button still posts.
 */
export const AppleFormPost: StoryObj = {
  ...visit("apple"),
  play: async ({ canvasElement }) => {
    let page = await chooseAda(canvasElement)
    await page.click("oauth-mock-allow")
    page = await page.navigated()
    await page.get("oauth-mock-form-post-continue")
  },
}

/** Cancel on the chooser: back to the app with `error=access_denied`. */
export const Cancelled: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    await press(canvasElement, "Cancel sign-in")
    expect((await departedTo(canvasElement)).searchParams.get("error")).toBe("access_denied")
  },
}

/** Cancel on the consent card. */
export const Denied: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const page = await chooseAda(canvasElement)
    await page.click("oauth-mock-deny")
    await page.navigated()
    expect((await departedTo(canvasElement)).searchParams.get("error")).toBe("access_denied")
  },
}

/** An interaction whose transaction is gone (expired, or already used). */
export const SignInExpired: StoryObj = page(async () => {
  const o = await signIn()
  return { emulator: o.emulator, url: `${ORIGIN}/interaction?transaction=expired` }
})

/** The emulator's own front page. */
export const Home: StoryObj = page(() => ({ emulator: oauth().emulator, url: `${ORIGIN}/` }))

/**
 * The handoff a top-level browser navigation gets in place of a bare redirect: it moves on to the
 * app by script, which is left out here so the page stays on screen. Browsers forbid the
 * `Sec-Fetch-Mode` header a story would need to reach it through the emulator, so it is drawn
 * from `redirectPage` directly.
 */
export const BackToYourApp: StoryObj = markup(async () => {
  const response = redirectPage(`${CALLBACK}?code=storybook-code&state=story-state`, "storybook")
  return (await response.text()).replace(
    /<script nonce="storybook">location\.replace[^<]*<\/script>/,
    "",
  )
})
