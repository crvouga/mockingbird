import { type Context, Hono } from "hono"
import { setCookie } from "hono/cookie"
import {
  issueSignInCode,
  normalizeEmail,
  redeemSignInCode,
  redeemSignInLink,
  type SignInCodeCheck,
  userForVerifiedEmail,
} from "../../auth/emailSignIn.js"
import { SESSION_COOKIE, SESSION_HEADER, startSession } from "../../auth/session.js"
import { APP_ORIGIN } from "../../checkout/createCheckout.js"
import { publicUser } from "../../db/usersRepo.js"
import {
  notifyNewSignIn,
  notifyWelcome,
  sendSignInCode,
} from "../../notifications/accountNotifications.js"
import type { AppEnv } from "../appEnv.js"

/** Passwordless sign-in: an emailed six-digit code, or the link in the same email. */
export const emailAuthRoutes = new Hono<AppEnv>()

/** The query parameter the emailed link carries back to the app. */
export const SIGN_IN_LINK_PARAM = "sign-in"

/**
 * Where the emailed link points. On the standalone server that is the server
 * itself, so the link works when clicked. In-process there is no address to
 * come back to, so it is the app's internal one and the client accepts the
 * link pasted into the code field instead.
 */
const linkOrigin = (requestUrl: string): string => {
  const url = new URL(requestUrl)
  return url.port ? url.origin : APP_ORIGIN
}

/**
 * Always answers the same way for any well-formed address: whether an account
 * exists is not something this endpoint reveals (unknown addresses simply get
 * an account when the code is redeemed).
 */
emailAuthRoutes.post("/start", async (c) => {
  const body = await c.req.json<{ email?: unknown }>()
  const email = normalizeEmail(body.email)
  if (!email) return c.json({ error: "Enter a valid email address." }, 400)
  const issued = await issueSignInCode(c.get("db"), email)
  if (issued.kind === "cooldown") {
    c.header("retry-after", String(issued.retryAfterSeconds))
    return c.json(
      {
        error: `We just sent a code. You can request another in ${issued.retryAfterSeconds} seconds.`,
        retryAfterSeconds: issued.retryAfterSeconds,
      },
      429,
    )
  }
  try {
    await sendSignInCode(c.get("notifier"), {
      email,
      code: issued.code,
      link: `${linkOrigin(c.req.url)}/?${SIGN_IN_LINK_PARAM}=${issued.linkToken}`,
      expiresInMinutes: issued.expiresInMinutes,
    })
  } catch {
    return c.json({ error: "We could not send the email. Try again in a moment." }, 502)
  }
  return c.json({ email, expiresInMinutes: issued.expiresInMinutes })
})

const REJECTIONS = {
  expired: "That code has expired or was already used. Request a new one.",
  too_many_attempts: "Too many incorrect attempts. Request a new code.",
}

const finish = async (c: Context<AppEnv>, check: SignInCodeCheck, method: "code" | "link") => {
  if (check.kind === "incorrect")
    return c.json(
      {
        error: `That code is not right. ${check.attemptsLeft} ${check.attemptsLeft === 1 ? "try" : "tries"} left.`,
        attemptsLeft: check.attemptsLeft,
      },
      400,
    )
  if (check.kind !== "ok")
    return c.json({ error: REJECTIONS[check.kind] }, check.kind === "expired" ? 410 : 429)
  const { user, created } = await userForVerifiedEmail(c.get("db"), check.email)
  const token = startSession(user)
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" })
  c.header(SESSION_HEADER, token)
  await (created
    ? notifyWelcome(c.get("notifier"), user)
    : notifyNewSignIn(c.get("notifier"), user, method))
  return c.json({ user: publicUser(user), created })
}

emailAuthRoutes.post("/verify", async (c) => {
  const body = await c.req.json<{ email?: unknown; code?: unknown }>()
  const email = normalizeEmail(body.email)
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : ""
  if (!email || !/^\d{6}$/.test(code))
    return c.json({ error: "Enter the 6-digit code from the email." }, 400)
  return finish(c, await redeemSignInCode(c.get("db"), email, code), "code")
})

emailAuthRoutes.post("/link", async (c) => {
  const body = await c.req.json<{ token?: unknown }>()
  if (typeof body.token !== "string" || body.token.length > 200)
    return c.json({ error: "That sign-in link is not valid." }, 400)
  return finish(c, await redeemSignInLink(c.get("db"), body.token), "link")
})
