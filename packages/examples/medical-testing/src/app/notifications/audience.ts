import type { UserRow } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { Notifier, OutboundEmail, OutboundPush } from "../ports/notifier.js"

/**
 * Where one member can be reached, already filtered by their preferences:
 * a channel they turned off (or never set up) is null or empty here, so the
 * senders below simply skip it.
 */
export type Audience = {
  user: UserRow
  email: string | null
  text: { to: string; channel: "sms" | "whatsapp" } | null
  devices: string[]
}

/**
 * The registration tokens of the member's (fictional) phones: one iPhone and
 * one Android phone each, so both platforms show up in the demo. A real app
 * gets these from the push SDK on each device and stores them per user.
 */
export const deviceTokensFor = async (db: Db, user: Pick<UserRow, "id">): Promise<string[]> => {
  const rows = await db.query<{ token: string }>(
    `SELECT token FROM push_devices WHERE user_id = $1 ORDER BY platform ASC`,
    [user.id],
  )
  if (rows.length) return rows.map((row) => row.token)
  const suffix = user.id.replaceAll("-", "").slice(0, 12)
  const devices = [
    { token: `android-${suffix}`, platform: "android" },
    { token: `ios-${suffix}`, platform: "ios" },
  ]
  for (const device of devices)
    await db.query(`INSERT INTO push_devices (token, user_id, platform) VALUES ($1, $2, $3)`, [
      device.token,
      user.id,
      device.platform,
    ])
  return devices.map((device) => device.token)
}

/** `everything` ignores preferences: for security messages and tests the member asked for. */
export const audienceFor = async (
  db: Db,
  user: UserRow,
  options: { everything?: boolean } = {},
): Promise<Audience> => {
  const all = options.everything === true
  return {
    user,
    email: all || user.notify_email ? user.email : null,
    text:
      user.phone && (all || user.notify_text)
        ? { to: user.phone, channel: user.phone_channel }
        : null,
    devices: all || user.notify_push ? await deviceTokensFor(db, user) : [],
  }
}

export const firstName = (user: Pick<UserRow, "name">): string =>
  user.name?.split(" ")[0] || "there"

const warn = (label: string, reason: unknown): void =>
  console.warn(
    `[notifications] ${label}: ${reason instanceof Error ? reason.message : String(reason)}`,
  )

/**
 * Sends every message and never throws: a provider outage must not fail the
 * payment or lab webhook that triggered it (the provider would retry the
 * webhook and the app would act twice).
 */
export const deliver = async (
  label: string,
  sends: (Promise<void> | null | undefined)[],
): Promise<void> => {
  const results = await Promise.allSettled(sends.filter(Boolean))
  for (const result of results) if (result.status === "rejected") warn(label, result.reason)
}

export const guarded = async (label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (error) {
    warn(label, error)
  }
}

export const toEmail = (notifier: Notifier, to: Audience, message: Omit<OutboundEmail, "to">) =>
  to.email ? notifier.sendEmail({ to: to.email, ...message }) : null

export const toText = (notifier: Notifier, to: Audience, body: string) =>
  to.text ? notifier.sendSms({ ...to.text, body }) : null

export const toDevices = (
  notifier: Notifier,
  to: Audience,
  message: Omit<OutboundPush, "deviceToken">,
) => to.devices.map((deviceToken) => notifier.sendPush({ deviceToken, ...message }))
