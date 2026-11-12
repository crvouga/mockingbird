import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { cove, type Person, person, phone, SHELL } from "./cove.js"

/**
 * "Continue with Google / Apple": the OAuth emulator's real hosted pages (account chooser,
 * consent), fetched by the app's server and pasted into the app's modal (`pasteHtml`), their
 * scripts re-implemented as code (`hostedPages`). Every submit goes back through the app, which
 * finishes the authorization-code flow with PKCE against the emulator.
 */
export default {
  title: "Examples/Medical testing/Sign in with Google or Apple",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL,
      "packages/examples/medical-testing/src/client/pages/Landing.ts",
      "packages/examples/medical-testing/src/client/components/OAuthButtons.ts",
      "packages/examples/medical-testing/src/client/components/OAuthModal.ts",
      "packages/examples/medical-testing/src/client/components/useEscapeKey.ts",
      "packages/examples/medical-testing/src/client/hostedPages.ts",
      "packages/examples/medical-testing/src/client/pasteHtml.ts",
      "packages/examples/medical-testing/src/adapters/identity/oauthMockIdentity.ts",
      "packages/service/oauth/src/ui.ts",
    ],
  },
} satisfies Meta

const open = async (canvas: HTMLElement, provider: "Google" | "Apple"): Promise<Person> => {
  const page = person(canvas)
  await page.click("button.cove-oauth-btn", `Continue with ${provider}`)
  await page.find(".hosted-page [data-testid]")
  return page
}

/** Google's account chooser, with the three demo accounts. */
export const GoogleAccounts: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement, "Google")
    await page.find('[data-testid="oauth-mock-account-ada"]')
  },
}

/** An account picked: Google asks to share it with the app. */
export const GoogleConsent: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement, "Google")
    await page.click('[data-testid="oauth-mock-account-ada"]')
    await page.find('[data-testid="oauth-mock-allow"]')
  },
}

/** Consent given: the modal closes on the signed-in overview. */
export const SignedInWithGoogle: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement, "Google")
    await page.click('[data-testid="oauth-mock-account-ada"]')
    await page.click('[data-testid="oauth-mock-allow"]')
    expect((await page.find(".cove-page h1")).textContent).toBe("Welcome back, Ada.")
  },
}

/** Consent refused: the provider's error, and a way to try again. */
export const GoogleDenied: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement, "Google")
    await page.click('[data-testid="oauth-mock-account-ada"]')
    await page.find('[data-testid="oauth-mock-allow"]')
    await page.click('[data-testid="oauth-mock-deny"]')
    await page.find(".cove-modal-error", "Try again")
  },
}

/** Apple's chooser, with its one demo account. */
export const AppleAccounts: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    await open(canvasElement, "Apple")
  },
}

/** Apple's consent: share or hide the email address. */
export const AppleConsent: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement, "Apple")
    await page.click('[data-testid="oauth-mock-account-grace"]')
    await page.find('[data-testid="oauth-mock-hide-email"]')
  },
}

/** The provider cannot be reached: the modal's error state. */
export const ProviderUnavailable: StoryObj = {
  ...cove({
    transport: (fetcher) => (path, init) =>
      path.endsWith("/start") && path.includes("/api/auth/google")
        ? Promise.resolve(
            Response.json(
              { error: "Sign-in failed (503). The provider is unavailable." },
              { status: 400 },
            ),
          )
        : fetcher(path, init),
  }),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.click("button.cove-oauth-btn", "Continue with Google")
    await page.find(".cove-modal-error", "The provider is unavailable.")
  },
}

/** The chooser on a phone: the modal fills the screen. */
export const OnAPhone: StoryObj = {
  ...GoogleAccounts,
  globals: phone,
}
