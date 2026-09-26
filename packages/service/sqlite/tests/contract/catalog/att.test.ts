import { expect } from "bun:test";
import { Snapshot } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("ATT", [
  {
    id: "ATT-att-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("ATTACH 'ignored.db' AS other");
      db.exec("CREATE TABLE other.t(a INT)");
      expect(db.query<{ n: number }>("SELECT count(*) AS n FROM other.t")[0]!.n).toBe(0);
    },
  },
  { id: "ATT-att-02", kind: "error", setup: ["ATTACH ':memory:' AS other"], sql: "ATTACH ':memory:' AS other" },
  { id: "ATT-det-01", kind: "error", sql: "DETACH nosuch" },
  { id: "ATT-det-02", kind: "error", sql: "DETACH main" },
  {
    id: "ATT-qual-01",
    kind: "parity",
    setup: ["ATTACH ':memory:' AS other", "CREATE TABLE other.t(a INT)", "INSERT INTO other.t VALUES (1)"],
    sql: "SELECT a FROM other.t",
  },
  {
    id: "ATT-res-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (1)"],
    sql: "SELECT a FROM t",
  },
  {
    id: "ATT-amb-01",
    kind: "error",
    setup: ["CREATE TABLE t(a INT)", "ATTACH ':memory:' AS other", "CREATE TABLE other.t(a INT)"],
    sql: "SELECT a FROM t JOIN t",
    query: true,
  },
  {
    id: "ATT-cross-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t(a INT)",
      "INSERT INTO t VALUES (1)",
      "ATTACH ':memory:' AS other",
      "CREATE TABLE other.u(a INT)",
      "INSERT INTO other.u VALUES (1)",
    ],
    sql: "SELECT t.a, u.a FROM t JOIN other.u ON t.a=u.a",
  },
  {
    id: "ATT-list-01",
    kind: "parity",
    setup: ["ATTACH ':memory:' AS other"],
    sql: "SELECT name FROM pragma_database_list() ORDER BY seq",
  },
  {
    id: "ATT-snap-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("ATTACH ':memory:' AS other");
      db.exec("CREATE TABLE other.t(a INT)");
      const other = Snapshot.decode(db.snapshot().encode()).open();
      expect(other.query<{ n: number }>("SELECT count(*) AS n FROM pragma_database_list()")[0]!.n).toBe(1);
      other.close();
    },
  },
]);
