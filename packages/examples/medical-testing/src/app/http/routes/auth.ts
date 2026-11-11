import { type Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  signOut,
  startSessionForProfile,
} from "../../auth/session.js"
import { findUserById, publicUser } from "../../db/usersRepo.js"
import type { NotificationPreferences } from "../../model.js"
import { notifyNewSignIn, notifyWelcome } from "../../notifications/accountNotifications.js"
import type { HostedFlowStep } from "../../ports/hostedFlow.js"
import type { IdentityProfile, IdentityProviderKey } from "../../ports/identityProvider.js"
import type { AppEnv } from "../appEnv.js"

export const authRoutes = new Hono<AppEnv>()

const isProvider = (value: string): value is IdentityProviderKey =>
  value === "google" || value === "apple"

/** Kicks off sign-in and returns its first hosted screen (account chooser). */
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
  const { token, user, created } = await startSessionForProfile(c.get("db"), result.result)
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" })
  c.header(SESSION_HEADER, token)
  await (created
    ? notifyWelcome(c.get("notifier"), user)
    : notifyNewSignIn(c.get("notifier"), user, result.result.provider))
  return c.json({ user: publicUser(user) })
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
  return c.json({ user: publicUser(user) })
})

const isPreferences = (value: unknown): value is NotificationPreferences => {
  if (!value || typeof value !== "object") return false
  const { email, text, push } = value as Record<string, unknown>
  return typeof email === "boolean" && typeof text === "boolean" && typeof push === "boolean"
}

/**
 * Name, the overview highlight, and which channels order updates use.
 * `notify` is optional so a client that only edits the name keeps working.
 */
authRoutes.patch("/profile", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  const body = await c.req.json<{ name?: unknown; notifications?: unknown; notify?: unknown }>()
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 80 ||
    typeof body.notifications !== "boolean" ||
    (body.notify !== undefined && !isPreferences(body.notify))
  )
    return c.json({ error: "Enter a name of 1–80 characters and a notification preference." }, 400)
  const notify = isPreferences(body.notify) ? body.notify : publicUser(user).notify
  const db = c.get("db")
  await db.query(
    "UPDATE users SET name = $2, notifications = $3, notify_email = $4, notify_text = $5, notify_push = $6 WHERE id = $1",
    [user.id, body.name.trim(), body.notifications, notify.email, notify.text, notify.push],
  )
  return c.json({ user: publicUser((await findUserById(db, user.id)) ?? user) })
})
