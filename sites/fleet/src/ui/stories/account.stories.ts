import type { Meta } from "@storybook/html-vite"
import { invalid, newToken, notFound, rateLimited, signedIn, tokens } from "./fixtures.js"
import { created, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Account" } satisfies Meta

const path = "/account"
const account = (list = tokens): MockRoutes => ({
  ...signedIn(),
  "GET /tokens": ok({ data: list }),
})
const { key: _key, ...listedToken } = newToken

export const WithTokens = query({ path, routes: account() })
export const NoTokens = query({ path, routes: account([]) })

// ---- creating a token

const create = "/account/tokens/new"

export const NewToken = mutation({ path: create, routes: account() })

export const NewTokenWithoutAName = mutation({
  path: create,
  routes: account(),
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

export const NewTokenNameTooLong = mutation({
  path: create,
  routes: { ...account(), "POST /tokens": invalid("body.name: must be at most 80 characters") },
  steps: (page) => page.submit({ Name: "the coding agent on the build machine ".repeat(3) }),
  shows: ["field-error"],
})

export const NewTokenCreating = mutation({
  path: create,
  routes: { ...account(), "POST /tokens": PENDING },
  steps: (page) => page.submit({ Name: "ci" }),
  shows: ["pending"],
})

/** The token is shown once, on its own screen, right after it is created. */
export const TokenCreated = mutation({
  path: create,
  routes: {
    ...account(),
    "POST /tokens": created(newToken, { "GET /tokens": ok({ data: [...tokens, listedToken] }) }),
  },
  steps: (page) => page.submit({ Name: "ci" }),
  shows: ["secret"],
})

/** Opened again, the token is gone for good. */
export const TokenShownOnce = query({ path: "/account/tokens/tok_ci/created", routes: account() })

// ---- revoking a token

const revoke = "/account/tokens/tok_laptop/revoke"

export const RevokeToken = mutation({ path: revoke, routes: account() })

export const RevokeTokenAlreadyRevoked = mutation({
  path: revoke,
  routes: { ...account(), "DELETE /tokens/tok_laptop": notFound("Token") },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const TokenRevoked = mutation({
  path: revoke,
  routes: {
    ...account(),
    "DELETE /tokens/tok_laptop": ok({ ok: true }, { "GET /tokens": ok({ data: tokens.slice(1) }) }),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

/** A token that does not exist, or was already revoked. */
export const RevokeUnknownToken = query({
  path: "/account/tokens/tok_gone/revoke",
  routes: account(),
})

// ---- states every mutation is shown in

/** The API throttles the caller: the refusal belongs to no field. */
export const NewTokenRateLimited = mutation({
  path: create,
  routes: { ...account(), "POST /tokens": rateLimited },
  steps: (page) => page.submit({ Name: "ci" }),
  shows: ["form-error"],
})

export const RevokingToken = mutation({
  path: revoke,
  routes: { ...account(), "DELETE /tokens/tok_laptop": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})
