import type { Meta } from "@storybook/html-vite"
import {
  me,
  org,
  projects,
  rateLimited,
  signedIn,
  signedOut,
  tooManySignIns,
  unavailable,
} from "./fixtures.js"
import { failure, type MockRoutes, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Sign in" } satisfies Meta

// ---- the chooser

/** A deployment with an identity provider and nothing else. */
export const SingleSignOn = query({ path: "/sign-in", routes: signedOut({ oidc: true }) })

/** `bun run dev`: sign in by typing an email, on loopback only. */
export const LocalOnly = query({ path: "/sign-in", routes: signedOut({ devLogin: true }) })

/** A deployment whose operator issues personal tokens. */
export const TokenOnly = query({ path: "/sign-in", routes: signedOut({ tokenLogin: true }) })

export const EveryMethod = query({
  path: "/sign-in",
  routes: signedOut({ oidc: true, devLogin: true, tokenLogin: true }),
})

/** The operator configured nothing: the page says what to set. */
export const NoWayToSignIn = query({ path: "/sign-in", routes: signedOut({}) })

/** Opened from an invite link while signed out: signing in returns to the invite. */
export const FromAnInviteLink = query({
  path: "/invite/k3v9x2m4p7q1w8e5r6t0",
  routes: signedOut({ oidc: true, tokenLogin: true }),
})

/** Once signed in, the chooser opens the dashboard instead. */
const afterSignIn: MockRoutes = {
  ...signedIn([org("owner")]),
  "GET /orgs/org_acme": ok(org("owner")),
  "GET /orgs/org_acme/projects": ok({ data: projects }),
}

// ---- signing in locally

const local = "/sign-in/local"
const offersLocal = signedOut({ devLogin: true, tokenLogin: true })

export const Local = mutation({ path: local, routes: offersLocal })

/** The browser sees that this is not an email address without asking. */
export const LocalNotAnEmail = mutation({
  path: local,
  routes: offersLocal,
  steps: (page) => page.submit({ Email: "ada" }),
  shows: ["field-error"],
})

/** The API refuses the address; the refusal is written under the field. */
export const LocalRejectedEmail = mutation({
  path: local,
  routes: {
    ...offersLocal,
    "POST /auth/dev-login": failure(400, "invalid_request", "email is required"),
  },
  steps: (page) => page.submit({ Email: "ada@" }),
  shows: ["field-error"],
})

/** Too many attempts from one address: a refusal about no field, at the top of the form. */
export const LocalTooManyAttempts = mutation({
  path: local,
  routes: { ...offersLocal, "POST /auth/dev-login": tooManySignIns },
  steps: (page) => page.submit({ Email: "ada@example.com" }),
  shows: ["form-error"],
})

export const LocalSigningIn = mutation({
  path: local,
  routes: { ...offersLocal, "POST /auth/dev-login": PENDING },
  steps: (page) => page.submit({ Email: "ada@example.com" }),
  shows: ["pending"],
})

/** Signed in, the dashboard opens the first organization. */
export const LocalSignedIn = mutation({
  path: local,
  routes: { ...offersLocal, "POST /auth/dev-login": ok({ ok: true }, afterSignIn) },
  steps: (page) => page.submit({ Email: "ada@example.com" }),
  shows: ["landed"],
})

/** The server does not offer local sign-in: its address says so instead of drawing the form. */
export const LocalNotOffered = query({ path: local, routes: signedOut({ oidc: true }) })

// ---- signing in with a token

const token = "/sign-in/token"
const offersToken = signedOut({ oidc: true, tokenLogin: true })

export const Token = mutation({ path: token, routes: offersToken })

export const TokenMissing = mutation({
  path: token,
  routes: offersToken,
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

/** An organization key is not a personal token: the refusal is about the field. */
export const TokenRejected = mutation({
  path: token,
  routes: {
    ...offersToken,
    "POST /auth/token-login": failure(
      401,
      "unauthorized",
      "Sign in with a personal token (mbf_u_…), not an organization key",
    ),
  },
  steps: (page) => page.submit({ "Personal token": "mbf_o_7hq2Zr4Tn0Vb7Lq2" }),
  shows: ["field-error"],
})

export const TokenSignedIn = mutation({
  path: `${token}?return_to=%2Faccount`,
  routes: {
    ...offersToken,
    "POST /auth/token-login": ok({ ok: true }, { ...signedIn(), "GET /tokens": ok({ data: [] }) }),
  },
  steps: (page) => page.submit({ "Personal token": "mbf_u_b2k8Ue2Ra9Ci6Xo3Lt8Mb1" }),
  shows: ["landed"],
})

// ---- signing out

const out = "/sign-out"

export const SignOut = mutation({ path: out, routes: signedIn() })

export const SignOutFailed = mutation({
  path: out,
  routes: { ...signedIn(), "POST /auth/logout": unavailable },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

/** Signed out, the chooser says so where the dashboard was. */
export const SignedOut = mutation({
  path: out,
  routes: {
    "GET /me": ok(me()),
    "POST /auth/logout": ok({ ok: true }, signedOut({ oidc: true, tokenLogin: true })),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

/** The API is throttling this address: a refusal about no field, at the top of the form. */
export const TokenTooManyAttempts = mutation({
  path: token,
  routes: { ...offersToken, "POST /auth/token-login": rateLimited },
  steps: (page) => page.submit({ "Personal token": "mbf_u_b2k8Ue2Ra9Ci6Xo3Lt8Mb1" }),
  shows: ["form-error"],
})

export const TokenSigningIn = mutation({
  path: token,
  routes: { ...offersToken, "POST /auth/token-login": PENDING },
  steps: (page) => page.submit({ "Personal token": "mbf_u_b2k8Ue2Ra9Ci6Xo3Lt8Mb1" }),
  shows: ["pending"],
})

export const SigningOut = mutation({
  path: out,
  routes: { ...signedIn(), "POST /auth/logout": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})
