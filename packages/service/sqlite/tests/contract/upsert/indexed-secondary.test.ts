import { sequenceParity } from "../helpers.ts";

const userId = "e9547fd5-9c96-4cb4-97be-92fc6b2a4441";
const created = "2026-08-21 20:37:34.214+00";

const schema = [
  `CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    user_id TEXT,
    source_namespace TEXT,
    source_type TEXT,
    source_id TEXT,
    category TEXT,
    priority INTEGER,
    title TEXT,
    archived_at TEXT,
    dismissed_at TEXT,
    active INTEGER
  ) STRICT`,
  // Composite-with-NULL first: this is the access path that used to miss the heap row.
  "CREATE INDEX notifications_inbox ON notifications (user_id, active, archived_at, priority, created_at)",
  "CREATE INDEX notifications_user_id ON notifications (user_id)",
  "CREATE UNIQUE INDEX notifications_source ON notifications (user_id, source_namespace, source_type, source_id)",
];

const upsert = `
  INSERT INTO notifications (
    id, created_at, updated_at, deleted_at, user_id,
    source_namespace, source_type, source_id, category, priority,
    title, archived_at, dismissed_at, active
  ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  ON CONFLICT (id) DO UPDATE SET
    user_id = excluded.user_id,
    active = excluded.active,
    archived_at = excluded.archived_at,
    dismissed_at = excluded.dismissed_at,
    category = excluded.category,
    priority = excluded.priority,
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`;

const binds = [
  `friends:friend-request:req1:${userId}`,
  created,
  created,
  userId,
  "friends",
  "friend-request",
  "req1",
  "action_required",
  10,
  "@alice sent you a friend request",
  1,
];

sequenceParity("STRICT notifications upsert then indexed user_id equality", schema, [
  { sql: upsert, params: binds },
  { sql: upsert, params: binds },
  { sql: "SELECT COUNT(*) AS c FROM notifications", query: true },
  { sql: "SELECT id FROM notifications WHERE user_id = ?", query: true, params: [userId] },
  { sql: "SELECT id FROM notifications WHERE user_id = ? AND active = 1", query: true, params: [userId] },
  {
    sql: "SELECT id FROM notifications WHERE substr(user_id, 1) = ? AND active = 1",
    query: true,
    params: [userId],
  },
]);
