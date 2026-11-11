import type { Meta } from "@storybook/html-vite"
import { rateLimited, unauthorized, unavailable } from "./fixtures.js"
import { PENDING } from "./mock.js"
import { query } from "./story.js"

export default { title: "Shell" } satisfies Meta

/** What the page shows until the first response arrives. */
export const Loading = query({ path: "/orgs", routes: { "GET /me": PENDING } })

/** The API fails before anything is drawn: the page says so and offers to try again. */
export const ServerUnavailable = query({ path: "/orgs", routes: { "GET /me": unavailable } })

/** The caller is being rate limited, and is told so in the API's own words. */
export const RateLimited = query({ path: "/orgs", routes: { "GET /me": rateLimited } })

/** Nobody is signed in and the ways to sign in cannot be read either. */
export const SignInUnavailable = query({
  path: "/orgs",
  routes: { "GET /me": unauthorized, "GET /config": unavailable },
})
