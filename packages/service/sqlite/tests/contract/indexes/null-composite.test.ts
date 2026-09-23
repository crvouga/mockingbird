import { errorParity, parity, sequenceParity } from "../helpers.ts";

const userId = "e9547fd5-9c96-4cb4-97be-92fc6b2a4441";

const compositeFirst = [
  `CREATE TABLE t (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    active INTEGER,
    archived_at TEXT
  ) STRICT`,
  "CREATE INDEX t_inbox ON t (user_id, active, archived_at)",
  "CREATE INDEX t_user ON t (user_id)",
];

parity(
  "composite index with trailing NULL still finds WHERE leading = ?",
  [...compositeFirst, `INSERT INTO t VALUES ('n1', '${userId}', 1, NULL)`],
  "SELECT id FROM t WHERE user_id = ?",
  [userId],
);

parity(
  "composite-first index plus active equality finds the STRICT row",
  [...compositeFirst, `INSERT INTO t VALUES ('n1', '${userId}', 1, NULL)`],
  "SELECT id FROM t WHERE user_id = ? AND active = 1",
  [userId],
);

parity(
  "two rows sharing user_id with trailing NULL both match prefix equality",
  [...compositeFirst, `INSERT INTO t VALUES ('n1', '${userId}', 1, NULL), ('n2', '${userId}', 0, NULL)`],
  "SELECT id FROM t WHERE user_id = ? ORDER BY id",
  [userId],
);

sequenceParity("upsert rewriting indexed columns still hits user_id equality", compositeFirst, [
  {
    sql: `INSERT INTO t (id, user_id, active, archived_at) VALUES (?, ?, ?, NULL)
            ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, active = excluded.active`,
    params: ["n1", userId, 1],
  },
  {
    sql: `INSERT INTO t (id, user_id, active, archived_at) VALUES (?, ?, ?, NULL)
            ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, active = excluded.active`,
    params: ["n1", userId, 1],
  },
  { sql: "SELECT id FROM t WHERE user_id = ?", query: true, params: [userId] },
  { sql: "SELECT id FROM t WHERE user_id = ? AND active = 1", query: true, params: [userId] },
]);

sequenceParity("REINDEX after upsert still returns the indexed row", compositeFirst, [
  {
    sql: `INSERT INTO t (id, user_id, active, archived_at) VALUES (?, ?, 1, NULL)
            ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id`,
    params: ["n1", userId],
  },
  { sql: "REINDEX" },
  { sql: "SELECT id FROM t WHERE user_id = ?", query: true, params: [userId] },
]);

errorParity(
  "UNIQUE composite still rejects a full-key duplicate",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, user_id TEXT, src TEXT, kind TEXT, sid TEXT)",
    "CREATE UNIQUE INDEX t_src ON t (user_id, src, kind, sid)",
    `INSERT INTO t VALUES (1, '${userId}', 'friends', 'friend-request', 'req1')`,
  ],
  `INSERT INTO t VALUES (2, '${userId}', 'friends', 'friend-request', 'req1')`,
  "constraint_unique",
);

parity(
  "UNIQUE composite allows multiple NULLs in a trailing column",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, user_id TEXT, src TEXT)",
    "CREATE UNIQUE INDEX t_src ON t (user_id, src)",
    `INSERT INTO t VALUES (1, '${userId}', NULL), (2, '${userId}', NULL)`,
  ],
  "SELECT id FROM t WHERE user_id = ? ORDER BY id",
  [userId],
);
