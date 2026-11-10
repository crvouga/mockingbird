import type { Meta } from "@storybook/html-vite"
import { signedOut, tooManySignIns, unauthorized } from "./fixtures.js"
import { story } from "./story.js"

export default { title: "Sign in" } satisfies Meta

/** A deployment with an identity provider and nothing else. */
export const SingleSignOn = story({ path: "/", routes: signedOut({ oidc: true }) })

/** `bun run dev`: sign in by typing an email, on loopback only. */
export const LocalSignIn = story({ path: "/", routes: signedOut({ devLogin: true }) })

/** A deployment whose operator issues personal tokens. */
export const TokenSignIn = story({ path: "/", routes: signedOut({ tokenLogin: true }) })

export const SingleSignOnAndToken = story({
  path: "/",
  routes: signedOut({ oidc: true, tokenLogin: true }),
})

export const LocalAndToken = story({
  path: "/",
  routes: signedOut({ devLogin: true, tokenLogin: true }),
})

export const EveryMethod = story({
  path: "/",
  routes: signedOut({ oidc: true, devLogin: true, tokenLogin: true }),
})

/** Opened from an invite link while signed out: signing in returns to the invite. */
export const FromAnInviteLink = story({
  path: "/invite/k3v9x2m4p7q1w8e5r6t0",
  routes: signedOut({ oidc: true }),
})

/** A wrong token: the refusal is shown above the ways to sign in. */
export const TokenRejected = story({
  path: "/",
  routes: { ...signedOut({ tokenLogin: true }), "POST /auth/token-login": unauthorized },
  steps: async (page) => {
    page.type("Personal token", "mbf_u_wrong")
    await page.press("Sign in with a token")
  },
  shows: ["flash"],
})

/** Local sign-in refused, here because too many attempts came from one address. */
export const LocalSignInRefused = story({
  path: "/",
  routes: {
    ...signedOut({ devLogin: true, tokenLogin: true }),
    "POST /auth/dev-login": tooManySignIns,
  },
  steps: async (page) => {
    page.type("Email", "ada@example.com")
    await page.press("Sign in locally")
  },
  shows: ["flash"],
})
