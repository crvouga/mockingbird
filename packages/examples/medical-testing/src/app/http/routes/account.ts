import { Hono } from "hono"
import { findUserById, publicUser } from "../../db/usersRepo.js"
import { can, isTextChannel, TEST_NOTIFICATIONS, type TestNotification } from "../../model.js"
import {
  notifyPhoneVerified,
  sendTestNotification,
  TestNotificationUnavailable,
} from "../../notifications/accountNotifications.js"
import type { AppEnv } from "../appEnv.js"

/** The signed-in member's phone number and "send a test" playground. */
export const accountRoutes = new Hono<AppEnv>()
accountRoutes.use("*", async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Sign in required" }, 401)
  return next()
})

/** Accepts common US formats and anything already in E.164. Returns E.164 or null. */
export const normalizePhone = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const digits = value.replace(/[\s().-]/g, "")
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits
  if (/^\d{10}$/.test(digits)) return `+1${digits}`
  if (/^1\d{10}$/.test(digits)) return `+${digits}`
  return null
}

const INVALID_PHONE = "Enter a mobile number with its area code, for example (415) 555-0142."

/** Texts a one-time code to a number the member wants to add. Nothing is saved yet. */
accountRoutes.post("/phone/start", async (c) => {
  const body = await c.req.json<{ phone?: unknown; channel?: unknown }>()
  const phone = normalizePhone(body.phone)
  if (!phone || !isTextChannel(body.channel)) return c.json({ error: INVALID_PHONE }, 400)
  const result = await c.get("phoneVerifier").start({ to: phone, channel: body.channel })
  if (result === "invalid_number") return c.json({ error: INVALID_PHONE }, 400)
  if (result === "too_many_requests")
    return c.json(
      { error: "Too many codes requested for this number. Try again in a few minutes." },
      429,
    )
  return c.json({ phone, channel: body.channel })
})

/** Checks the code. Only an approved check puts the number on the account. */
accountRoutes.post("/phone/check", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  const body = await c.req.json<{ phone?: unknown; channel?: unknown; code?: unknown }>()
  const phone = normalizePhone(body.phone)
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : ""
  if (!phone || !isTextChannel(body.channel) || !/^\d{4,8}$/.test(code))
    return c.json({ error: "Enter the code we sent to your phone." }, 400)
  const result = await c.get("phoneVerifier").check({ to: phone, code })
  if (result === "incorrect")
    return c.json({ error: "That code is not right. Check the message and try again." }, 400)
  if (result === "expired")
    return c.json({ error: "That code has expired or was already used. Send a new one." }, 410)
  if (result === "too_many_attempts")
    return c.json({ error: "Too many incorrect attempts. Send a new code." }, 429)
  const db = c.get("db")
  await db.query("UPDATE users SET phone = $2, phone_channel = $3 WHERE id = $1", [
    user.id,
    phone,
    body.channel,
  ])
  const updated = (await findUserById(db, user.id)) ?? user
  await notifyPhoneVerified(c.get("notifier"), updated)
  return c.json({ user: publicUser(updated) })
})

accountRoutes.delete("/phone", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  await c.get("db").query("UPDATE users SET phone = NULL WHERE id = $1", [user.id])
  return c.json({ user: publicUser({ ...user, phone: null }) })
})

/** Sends one sample message on a channel, whatever the member's preferences. */
accountRoutes.post("/notifications/test", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  const { kind } = await c.req.json<{ kind?: unknown }>()
  if (!TEST_NOTIFICATIONS.some((known) => known === kind))
    return c.json({ error: "Choose email, text, push or chat." }, 400)
  if (kind === "chat" && !can(user.role, "orders.read"))
    return c.json({ error: "Staff alerts are for clinicians and administrators." }, 403)
  try {
    const sent = await sendTestNotification(
      c.get("db"),
      c.get("notifier"),
      user,
      kind as TestNotification,
    )
    return c.json({ sent })
  } catch (error) {
    if (error instanceof TestNotificationUnavailable) return c.json({ error: error.message }, 409)
    return c.json({ error: "The provider did not accept the message. Try again." }, 502)
  }
})
