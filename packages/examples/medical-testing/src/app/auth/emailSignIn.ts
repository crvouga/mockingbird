import { findUserByEmail, type UserRow, upsertUserFromIdentity } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"

/** How long a code (and its link) works. */
export const SIGN_IN_CODE_TTL_MS = 10 * 60_000
/** Wrong guesses allowed before the code is burned. */
export const SIGN_IN_MAX_ATTEMPTS = 5
/** Minimum gap between two codes for one address. */
export const SIGN_IN_RESEND_COOLDOWN_MS = 30_000

type CodeRow = {
  id: string
  email: string
  code_hash: string
  link_hash: string
  attempts: number
  expires_at: string
  consumed_at: string | null
  created_at: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Six digits from the platform CSPRNG, without modulo bias. */
const randomCode = (): string => {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    const value = buffer[0] as number
    if (value < limit) return String(value % 1_000_000).padStart(6, "0")
  }
}

const randomToken = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const time = (value: string | Date): number => new Date(value).getTime()

const latestCode = async (db: Db, email: string): Promise<CodeRow | undefined> =>
  (
    await db.query<CodeRow>(
      `SELECT * FROM sign_in_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    )
  )[0]

export type SignInCodeIssue =
  | { kind: "issued"; code: string; linkToken: string; expiresInMinutes: number }
  | { kind: "cooldown"; retryAfterSeconds: number }

/**
 * Issues a fresh code and link for an address. Only their hashes are stored,
 * salted with the row id, so a database read does not reveal a working code.
 * Any earlier code for the address stops working: the newest email is the
 * only one that signs in.
 */
export const issueSignInCode = async (db: Db, email: string): Promise<SignInCodeIssue> => {
  const now = Date.now()
  const previous = await latestCode(db, email)
  if (previous) {
    const wait = time(previous.created_at) + SIGN_IN_RESEND_COOLDOWN_MS - now
    if (wait > 0) return { kind: "cooldown", retryAfterSeconds: Math.ceil(wait / 1000) }
  }
  await db.query(
    `UPDATE sign_in_codes SET consumed_at = $2 WHERE email = $1 AND consumed_at IS NULL`,
    [email, new Date(now).toISOString()],
  )
  const id = crypto.randomUUID()
  const code = randomCode()
  const linkToken = `${id}.${randomToken()}`
  await db.query(
    `INSERT INTO sign_in_codes (id, email, code_hash, link_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      email,
      await sha256(`${id}:${code}`),
      await sha256(linkToken),
      new Date(now + SIGN_IN_CODE_TTL_MS).toISOString(),
      new Date(now).toISOString(),
    ],
  )
  return { kind: "issued", code, linkToken, expiresInMinutes: SIGN_IN_CODE_TTL_MS / 60_000 }
}

export type SignInCodeCheck =
  | { kind: "ok"; email: string }
  | { kind: "incorrect"; attemptsLeft: number }
  /** No live code: never requested, already used, replaced by a newer one, or timed out. */
  | { kind: "expired" }
  | { kind: "too_many_attempts" }

const consume = (db: Db, id: string): Promise<unknown> =>
  db.query(`UPDATE sign_in_codes SET consumed_at = $2 WHERE id = $1`, [
    id,
    new Date().toISOString(),
  ])

const usable = (row: CodeRow | undefined): row is CodeRow =>
  Boolean(row && !row.consumed_at && time(row.expires_at) > Date.now())

/** Checks a typed code. A correct code works once; every wrong guess counts against it. */
export const redeemSignInCode = async (
  db: Db,
  email: string,
  code: string,
): Promise<SignInCodeCheck> => {
  const row = await latestCode(db, email)
  if (!usable(row)) return { kind: "expired" }
  if (row.attempts >= SIGN_IN_MAX_ATTEMPTS) return { kind: "too_many_attempts" }
  if ((await sha256(`${row.id}:${code}`)) !== row.code_hash) {
    const attempts = row.attempts + 1
    await db.query(`UPDATE sign_in_codes SET attempts = $2 WHERE id = $1`, [row.id, attempts])
    return attempts >= SIGN_IN_MAX_ATTEMPTS
      ? { kind: "too_many_attempts" }
      : { kind: "incorrect", attemptsLeft: SIGN_IN_MAX_ATTEMPTS - attempts }
  }
  await consume(db, row.id)
  return { kind: "ok", email: row.email }
}

/** Checks the token from an emailed link. It is single-use and shares the code's lifetime. */
export const redeemSignInLink = async (db: Db, linkToken: string): Promise<SignInCodeCheck> => {
  const id = linkToken.split(".")[0] ?? ""
  if (!/^[0-9a-f-]{36}$/.test(id)) return { kind: "expired" }
  const row = (await db.query<CodeRow>(`SELECT * FROM sign_in_codes WHERE id = $1`, [id]))[0]
  if (!usable(row) || (await sha256(linkToken)) !== row.link_hash) return { kind: "expired" }
  await consume(db, row.id)
  return { kind: "ok", email: row.email }
}

/** "ada.lovelace@…" reads as "Ada Lovelace" until the member sets a name. */
const nameFromEmail = (email: string): string =>
  (email.split("@")[0] ?? "")
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 80) || "New member"

/**
 * The account a proven address signs in to: the existing one with that email
 * (so a member who first used Google lands in the same workspace), or a new
 * patient account.
 */
export const userForVerifiedEmail = async (
  db: Db,
  email: string,
): Promise<{ user: UserRow; created: boolean }> => {
  const existing = await findUserByEmail(db, email)
  if (existing) return { user: existing, created: false }
  return upsertUserFromIdentity(db, {
    provider: "email",
    subject: email,
    email,
    name: nameFromEmail(email),
    picture: null,
  })
}
