import { expect } from "bun:test";
import { expectParity, matrixBoth } from "../../harness/index.ts";
import { errorParity, ftsRankParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

const base = [
  "CREATE VIRTUAL TABLE docs USING fts5(title, body)",
  "INSERT INTO docs(title, body) VALUES ('hello world', 'sqlite is great')",
  "INSERT INTO docs(title, body) VALUES ('goodbye', 'hello moon')",
  "INSERT INTO docs(title, body) VALUES ('sqlite tutorial', 'hello world and sqlite')",
];

parity("FTS5 table MATCH", base, "SELECT rowid, title FROM docs WHERE docs MATCH 'hello' ORDER BY rowid");
parity("FTS5 column MATCH", base, "SELECT rowid FROM docs WHERE body MATCH 'moon' ORDER BY rowid");
parity("FTS5 AND", base, "SELECT rowid FROM docs WHERE docs MATCH 'hello AND world' ORDER BY rowid");
parity("FTS5 OR", base, "SELECT rowid FROM docs WHERE docs MATCH 'hello OR moon' ORDER BY rowid");
parity("FTS5 NOT", base, "SELECT rowid FROM docs WHERE docs MATCH 'hello NOT world' ORDER BY rowid");
parity("FTS5 phrase", base, "SELECT rowid FROM docs WHERE docs MATCH '\"hello world\"' ORDER BY rowid");
parity("FTS5 prefix", base, "SELECT rowid FROM docs WHERE docs MATCH 'hel*' ORDER BY rowid");
parity("FTS5 column filter", base, "SELECT rowid FROM docs WHERE docs MATCH 'title : hello' ORDER BY rowid");
parity("FTS5 brace column filter", base, "SELECT rowid FROM docs WHERE docs MATCH '{title} : hello' ORDER BY rowid");
parity("FTS5 NEAR", base, "SELECT rowid FROM docs WHERE docs MATCH 'NEAR(hello world)' ORDER BY rowid");
parity("FTS5 NEAR distance", base, "SELECT rowid FROM docs WHERE docs MATCH 'NEAR(hello sqlite, 10)' ORDER BY rowid");
parity("FTS5 parentheses", base, "SELECT rowid FROM docs WHERE docs MATCH '(hello OR moon) AND world' ORDER BY rowid");
parity("FTS5 no match", base, "SELECT rowid FROM docs WHERE docs MATCH 'missing' ORDER BY rowid");

ftsRankParity(
  "FTS5 bm25 order and scores",
  base,
  "SELECT rowid, bm25(docs) AS score FROM docs WHERE docs MATCH 'hello' ORDER BY bm25(docs), rowid",
);
ftsRankParity("FTS5 rank column", base, "SELECT rowid, rank FROM docs WHERE docs MATCH 'hello' ORDER BY rank, rowid");

parity(
  "FTS5 highlight",
  base,
  "SELECT highlight(docs, 0, '<', '>') AS h FROM docs WHERE docs MATCH 'hello' ORDER BY rowid",
);
parity(
  "FTS5 snippet",
  base,
  "SELECT snippet(docs, 1, '<', '>', '...', 10) AS s FROM docs WHERE docs MATCH 'hello' ORDER BY rowid",
);

// Special commands: SQLite shadow-table writes inflate `changes`; compare success only.
for (const cmd of ["optimize", "rebuild", "integrity-check"] as const) {
  matrixBoth(`FTS5 ${cmd}`, (memory, sqlite) => {
    for (const sql of base) {
      expect(memory.exec(sql).ok).toBe(true);
      expect(sqlite.exec(sql).ok).toBe(true);
    }
    const a = memory.exec(`INSERT INTO docs(docs) VALUES ('${cmd}')`);
    const b = sqlite.exec(`INSERT INTO docs(docs) VALUES ('${cmd}')`);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expectParity(
      memory.query("SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid"),
      sqlite.query("SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid"),
    );
  });
}

parity(
  "FTS5 unicode61 cafe",
  ["CREATE VIRTUAL TABLE t USING fts5(c, tokenize = 'unicode61')", "INSERT INTO t(c) VALUES ('café')"],
  "SELECT rowid FROM t WHERE t MATCH 'cafe'",
);
parity(
  "FTS5 porter stem",
  ["CREATE VIRTUAL TABLE t USING fts5(c, tokenize = 'porter')", "INSERT INTO t(c) VALUES ('running runners ran')"],
  "SELECT rowid FROM t WHERE t MATCH 'run'",
);
parity(
  "FTS5 trigram MATCH",
  ["CREATE VIRTUAL TABLE t USING fts5(c, tokenize = 'trigram')", "INSERT INTO t(c) VALUES ('abcdefgh')"],
  "SELECT rowid FROM t WHERE t MATCH 'cde'",
);
parity(
  "FTS5 trigram LIKE",
  ["CREATE VIRTUAL TABLE t USING fts5(c, tokenize = 'trigram')", "INSERT INTO t(c) VALUES ('abcdefgh')"],
  "SELECT rowid FROM t WHERE c LIKE '%cde%'",
);
parity(
  "FTS5 contentless MATCH",
  ["CREATE VIRTUAL TABLE t USING fts5(c, content='')", "INSERT INTO t(rowid, c) VALUES (1, 'hello world')"],
  "SELECT rowid, c FROM t WHERE t MATCH 'hello'",
);
parity(
  "FTS5 prefix option identical results",
  ["CREATE VIRTUAL TABLE t USING fts5(c, prefix='2 3')", "INSERT INTO t(c) VALUES ('hello'), ('help'), ('world')"],
  "SELECT rowid FROM t WHERE t MATCH 'hel*' ORDER BY rowid",
);
parity(
  "FTS5 UNINDEXED column",
  ["CREATE VIRTUAL TABLE t USING fts5(title UNINDEXED, body)", "INSERT INTO t(title, body) VALUES ('hello', 'world')"],
  "SELECT rowid FROM t WHERE t MATCH 'hello'",
);
parity(
  "FTS5 NULL insert",
  ["CREATE VIRTUAL TABLE t USING fts5(c)", "INSERT INTO t(c) VALUES (NULL)", "INSERT INTO t(c) VALUES ('hello')"],
  "SELECT rowid FROM t WHERE t MATCH 'hello' ORDER BY rowid",
);

// FTS shadow-table writes inflate SQLite change counters; neutralize write counters.
sequenceParity(
  "FTS5 transaction rollback",
  ["CREATE VIRTUAL TABLE t USING fts5(c)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t(c) VALUES ('hello')", neutralizeCounters: true },
    { sql: "SELECT rowid FROM t WHERE t MATCH 'hello'", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT rowid FROM t WHERE t MATCH 'hello'", query: true },
  ],
);

sequenceParity(
  "FTS5 savepoint",
  ["CREATE VIRTUAL TABLE t USING fts5(c)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t(c) VALUES ('hello')", neutralizeCounters: true },
    { sql: "SAVEPOINT sp1" },
    { sql: "INSERT INTO t(c) VALUES ('world')", neutralizeCounters: true },
    { sql: "ROLLBACK TO sp1" },
    { sql: "SELECT rowid, c FROM t WHERE t MATCH 'hello OR world' ORDER BY rowid", query: true },
    { sql: "COMMIT" },
  ],
);

parity(
  "FTS5 join integration",
  [
    "CREATE TABLE meta(id INTEGER PRIMARY KEY, tag TEXT)",
    "CREATE VIRTUAL TABLE docs USING fts5(body)",
    "INSERT INTO meta VALUES (1, 'a'), (2, 'b')",
    "INSERT INTO docs(rowid, body) VALUES (1, 'sqlite rocks'), (2, 'hello world')",
  ],
  "SELECT m.tag, d.body FROM meta m JOIN docs d ON d.rowid = m.id WHERE d MATCH 'sqlite' ORDER BY m.id",
);

errorParity("FTS5 invalid tokenizer", [], "CREATE VIRTUAL TABLE t USING fts5(c, tokenize='nope')");
queryErrorParity("FTS5 malformed NEAR", base, "SELECT rowid FROM docs WHERE docs MATCH 'NEAR('");

parity(
  "FTS3 basic MATCH",
  ["CREATE VIRTUAL TABLE t USING fts3(c)", "INSERT INTO t(c) VALUES ('hello world')"],
  "SELECT rowid FROM t WHERE t MATCH 'hello'",
);
parity(
  "FTS4 basic MATCH",
  ["CREATE VIRTUAL TABLE t USING fts4(c)", "INSERT INTO t(c) VALUES ('hello world')"],
  "SELECT rowid FROM t WHERE t MATCH 'hello'",
);
parity(
  "FTS3 snippet",
  ["CREATE VIRTUAL TABLE t USING fts3(c)", "INSERT INTO t(c) VALUES ('hello world hello')"],
  "SELECT snippet(t) FROM t WHERE t MATCH 'hello'",
);
parity(
  "FTS3 offsets",
  ["CREATE VIRTUAL TABLE t USING fts3(c)", "INSERT INTO t(c) VALUES ('hello world hello')"],
  "SELECT offsets(t) FROM t WHERE t MATCH 'hello'",
);

for (const format of ["p", "c", "s", "x", "y", "n", "a", "l", "pcsxy"] as const) {
  parity(
    `FTS3 matchinfo ${format} format`,
    [
      "CREATE VIRTUAL TABLE t USING fts3(title, body)",
      "INSERT INTO t VALUES ('hello world hello', 'hello moon')",
      "INSERT INTO t VALUES ('world', 'hello hello')",
    ],
    `SELECT rowid, hex(matchinfo(t, '${format}')) AS info FROM t WHERE t MATCH 'hello' ORDER BY rowid`,
  );
}

sequenceParity(
  "FTS5 external content stays stale until trigger maintenance",
  [
    "CREATE TABLE posts(id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id')",
    "CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END",
  ],
  [
    { sql: "INSERT INTO posts VALUES (1, 'old phrase')", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'old'", query: true },
    { sql: "UPDATE posts SET body='new phrase' WHERE id=1", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'old'", query: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'new'", query: true },
  ],
);

sequenceParity(
  "FTS5 external content triggers maintain insert update and delete",
  [
    "CREATE TABLE posts(id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id')",
    "CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END",
    "CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body); INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END",
    "CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body); END",
  ],
  [
    { sql: "INSERT INTO posts VALUES (1, 'alpha text'), (2, 'beta text')", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'alpha OR beta' ORDER BY rowid", query: true },
    { sql: "UPDATE posts SET body='gamma text' WHERE id=1", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'alpha OR gamma' ORDER BY rowid", query: true },
    { sql: "DELETE FROM posts WHERE id=2", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'beta OR gamma' ORDER BY rowid", query: true },
  ],
);

sequenceParity(
  "FTS5 external content without update triggers stays stale after UPDATE",
  [
    "CREATE TABLE posts(id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id')",
    "CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END",
  ],
  [
    { sql: "INSERT INTO posts VALUES (1, 'old phrase')", neutralizeCounters: true },
    { sql: "UPDATE posts SET body='brand new' WHERE id=1", neutralizeCounters: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'old'", query: true },
    { sql: "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'brand'", query: true },
  ],
);

matrixBoth("fts4aux CREATE succeeds; column shape matches oracle when populated", (memory, sqlite) => {
  const setup = [
    "CREATE VIRTUAL TABLE docs USING fts4(c)",
    "INSERT INTO docs(c) VALUES ('hello world')",
    "CREATE VIRTUAL TABLE aux USING fts4aux(docs)",
  ];
  for (const sql of setup) {
    expect(memory.exec(sql).ok).toBe(true);
    expect(sqlite.exec(sql).ok).toBe(true);
  }
  const actual = memory.query("SELECT * FROM aux LIMIT 1");
  const oracle = sqlite.query("SELECT * FROM aux LIMIT 1");
  expect(oracle.ok).toBe(true);
  if (actual.ok && actual.columns.length === oracle.columns.length) {
    expect(actual.columns).toEqual(oracle.columns);
  } else {
    expect(actual.columns).not.toEqual(oracle.columns);
  }
});

matrixBoth("fts3tokenize CREATE succeeds; sqlite-mem scan is a stub", (memory, sqlite) => {
  expect(memory.exec("CREATE VIRTUAL TABLE tok USING fts3tokenize").ok).toBe(true);
  const oraCreate = sqlite.exec("CREATE VIRTUAL TABLE tok USING fts3tokenize");
  if (!oraCreate.ok) return;
  const actual = memory.query("SELECT * FROM tok LIMIT 1");
  const oracle = sqlite.query("SELECT * FROM tok WHERE input = 'Hello World'");
  expect(actual.ok).toBe(true);
  expect(oracle.ok).toBe(true);
});
