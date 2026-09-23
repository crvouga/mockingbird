import { type Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  signOut,
  startSessionForProfile,
} from "../../auth/session.js"
import type { HostedFlowStep } from "../../ports/hostedFlow.js"
import type { IdentityProfile, IdentityProviderKey } from "../../ports/identityProvider.js"
import type { AppEnv } from "../appEnv.js"

export const authRoutes = new Hono<AppEnv>()

const isProvider = (value: string): value is IdentityProviderKey =>
  value === "google" || value === "apple"

/** Kicks off a branded sign-in and returns its first hosted screen (account chooser). */
authRoutes.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider")
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400)
  const result = await c.get("identity").startSignIn(provider)
  return respondToStep(c, result)
})

/**
 * The client's HostedFlowModal intercepted a `<form>` submit (or link click)
 * inside the provider's real hosted screen and is forwarding it here
 * verbatim — see src/client/components/HostedFlowModal.ts.
 */
authRoutes.post("/:provider/step", async (c) => {
  const provider = c.req.param("provider")
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400)
  const body = await c.req.json<{ flowId: string; action: string; method: string; body: string }>()
  const result = await c
    .get("identity")
    .continueSignIn(body.flowId, body.action, body.method, body.body)
  return respondToStep(c, result)
})

const respondToStep = async (c: Context<AppEnv>, result: HostedFlowStep<IdentityProfile>) => {
  if (result.kind === "error") return c.json({ error: result.message }, 400)
  if (result.kind === "html") return c.json({ flowId: result.flowId, html: result.html })
  const { token, user } = await startSessionForProfile(c.get("db"), result.result)
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" })
  c.header(SESSION_HEADER, token)
  return c.json({ user: toPublicUser(user) })
}

authRoutes.post("/sign-out", (c) => {
  const token = getCookie(c, SESSION_COOKIE) ?? c.req.header(SESSION_HEADER)
  if (token) signOut(token)
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
  c.header(SESSION_HEADER, "")
  return c.json({ ok: true })
})

authRoutes.get("/me", (c) => {
  const user = c.get("user")
  if (!user) return c.json({ user: null })
  return c.json({ user: toPublicUser(user) })
})

const toPublicUser = (user: {
  id: string
  provider: string
  email: string | null
  name: string | null
  picture: string | null
}) => ({
  id: user.id,
  provider: user.provider,
  email: user.email,
  name: user.name,
  picture: user.picture,
})
