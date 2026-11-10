import type { Meta } from "@storybook/html-vite"
import { newToken, signedIn, tokens } from "./fixtures.js"
import { created, ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "Account" } satisfies Meta

const { key: _key, ...listedToken } = newToken

export const Populated = story({
  path: "/account",
  routes: { ...signedIn(), "GET /tokens": ok({ data: tokens }) },
})

export const Empty = story({
  path: "/account",
  routes: { ...signedIn(), "GET /tokens": ok({ data: [] }) },
})

/** The secret is shown once, right after the token is created. */
export const TokenCreated = story({
  path: "/account",
  routes: {
    ...signedIn(),
    "GET /tokens": ok({ data: tokens }),
    "POST /tokens": created(newToken, { "GET /tokens": ok({ data: [...tokens, listedToken] }) }),
  },
  steps: async (page) => {
    page.type("Token name", "ci")
    await page.press("Create token")
  },
  shows: ["secret:token"],
})
