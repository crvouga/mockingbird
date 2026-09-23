import { findUserById, type UserRow, upsertUserFromIdentity } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { IdentityProfile } from "../ports/identityProvider.js"

export const SESSION_COOKIE = "cove_session"
/**
 * Carries the same session token as `SESSION_COOKIE`, as a plain header
 * instead of a cookie — real browsers block JS from reading `Set-Cookie`/
 * `Cookie` on any Response/Headers object, even ones with no real network
 * hop behind them, so a fully in-process (browser-mounted) run mode can't
 * rely on cookies at all. See http/app.ts's middleware.
 */
export const SESSION_HEADER = "x-cove-session"

const sessions = new Map<string, string>() // token -> user id

export const startSessionForProfile = async (
  db: Db,
  profile: IdentityProfile,
): Promise<{ token: string; user: UserRow }> => {
  const user = await upsertUserFromIdentity(db, profile)
  const token = crypto.randomUUID()
  sessions.set(token, user.id)
  return { token, user }
}

export const signOut = (token: string): void => {
  sessions.delete(token)
}

export const userForToken = async (
  db: Db,
  token: string | undefined,
): Promise<UserRow | undefined> => {
  if (!token) return undefined
  const userId = sessions.get(token)
  if (!userId) return undefined
  return findUserById(db, userId)
}
