import type { Db } from "../ports/db.js"

export type UserRow = {
  id: string
  provider: string
  subject: string
  email: string | null
  name: string | null
  picture: string | null
  created_at: string
}

export const findUserById = async (db: Db, id: string): Promise<UserRow | undefined> =>
  (await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]))[0]

export const findUserByProvider = async (
  db: Db,
  provider: string,
  subject: string,
): Promise<UserRow | undefined> =>
  (
    await db.query<UserRow>(`SELECT * FROM users WHERE provider = $1 AND subject = $2`, [
      provider,
      subject,
    ])
  )[0]

/**
 * Identity is keyed by `(provider, subject)`, not email — the correct way to
 * key an OAuth-authenticated user, since a provider's `sub` is the only
 * claim guaranteed stable across sign-ins. Re-signing in refreshes profile
 * fields (name/picture can change between sign-ins) but keeps the same row.
 */
export const upsertUserFromIdentity = async (
  db: Db,
  profile: {
    provider: string
    subject: string
    email: string | null
    name: string | null
    picture: string | null
  },
): Promise<UserRow> => {
  const existing = await findUserByProvider(db, profile.provider, profile.subject)
  if (existing) {
    await db.query(
      `UPDATE users SET email = COALESCE($3, email), name = COALESCE($4, name), picture = COALESCE($5, picture) WHERE provider = $1 AND subject = $2`,
      [profile.provider, profile.subject, profile.email, profile.name, profile.picture],
    )
    return (await findUserByProvider(db, profile.provider, profile.subject)) as UserRow
  }
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO users (id, provider, subject, email, name, picture) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, profile.provider, profile.subject, profile.email, profile.name, profile.picture],
  )
  return (await findUserById(db, id)) as UserRow
}
