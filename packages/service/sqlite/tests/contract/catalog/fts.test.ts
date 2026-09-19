import { expect } from "bun:test";
import { Snapshot } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("FTS", [
  {
    id: "FTS-f5-01",
    kind: "exec",
    sql: "CREATE TABLE docs(body TEXT)",
  },
  {
    id: "FTS-f5-02",
    kind: "sequence",
    setup: ["CREATE TABLE docs(body TEXT)"],
    steps: [
      { sql: "INSERT INTO docs(body) VALUES ('hello sqlite')" },
      { sql: "UPDATE docs SET body='hello world' WHERE rowid=1" },
      { sql: "SELECT body FROM docs WHERE body LIKE '%hello%'", query: true },
    ],
  },
  {
    id: "FTS-f5-03",
    kind: "parity",
    setup: [
      "CREATE VIRTUAL TABLE docs USING fts5(body)",
      "INSERT INTO docs(body) VALUES ('alpha beta'),('alpha gamma'),('other')",
    ],
    sql: "SELECT rowid FROM docs WHERE docs MATCH 'alpha AND beta' ORDER BY rowid",
  },
  {
    id: "FTS-f5-04",
    kind: "parity",
    setup: [
      "CREATE VIRTUAL TABLE docs USING fts5(body)",
      "INSERT INTO docs(body) VALUES ('one two three'),('prefixable')",
    ],
    sql: "SELECT rowid FROM docs WHERE docs MATCH '\"one two\" OR prefix*' ORDER BY rowid",
  },
  {
    id: "FTS-f5-05",
    kind: "parity",
    setup: [
      "CREATE VIRTUAL TABLE docs USING fts5(title, body)",
      "INSERT INTO docs VALUES ('hello','world'),('world','hello')",
    ],
    sql: "SELECT rowid FROM docs WHERE docs MATCH 'title:hello' ORDER BY rowid",
  },
  {
    id: "FTS-f5-06",
    kind: "parity",
    setup: ["CREATE VIRTUAL TABLE docs USING fts5(body)", "INSERT INTO docs(body) VALUES ('hello there'),('hello')"],
    sql: "SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rank",
  },
  {
    id: "FTS-f5-07",
    kind: "parity",
    setup: ["CREATE VIRTUAL TABLE docs USING fts5(body)", "INSERT INTO docs(body) VALUES ('hello sqlite world')"],
    sql: "SELECT highlight(docs, 0, '<', '>') FROM docs WHERE docs MATCH 'sqlite'",
  },
  {
    id: "FTS-f5-08",
    kind: "exec",
    setup: ["CREATE VIRTUAL TABLE docs USING fts5(body)", "INSERT INTO docs(body) VALUES ('hello')"],
    sql: "INSERT INTO docs(docs) VALUES ('optimize')",
  },
  {
    id: "FTS-f34-01",
    kind: "parity",
    setup: ["CREATE VIRTUAL TABLE t USING fts3(c)", "INSERT INTO t(c) VALUES ('alpha beta')"],
    sql: "SELECT rowid FROM t WHERE t MATCH 'alpha'",
  },
  {
    id: "FTS-f34-02",
    kind: "parity",
    setup: ["CREATE VIRTUAL TABLE t USING fts4(c)", "INSERT INTO t(c) VALUES ('alpha beta')"],
    sql: "SELECT length(matchinfo(t)), offsets(t) IS NOT NULL FROM t WHERE t MATCH 'alpha'",
  },
  {
    id: "FTS-chg-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
      db.exec("INSERT INTO docs(body) VALUES ('hello')");
      expect(typeof db.changes).toBe("number");
    },
  },
  {
    id: "FTS-snap-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
      db.exec("INSERT INTO docs(body) VALUES ('hello')");
      const snap = db.snapshot().encode();
      const other = Snapshot.decode(snap).open();
      expect(other.query("SELECT name FROM sqlite_master WHERE name='docs'").length).toBe(0);
      other.close();
    },
  },
  {
    id: "FTS-series-01",
    kind: "divergence",
    fn: (db) => {
      // generate_series is a sqlite-mem extension; bun:sqlite does not expose it by default.
      const rows = db.query<{ value: number }>("SELECT value FROM generate_series(1, 3) ORDER BY value");
      expect(rows.map((row) => row.value)).toEqual([1, 2, 3]);
    },
  },
]);
