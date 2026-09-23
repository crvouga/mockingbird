import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "../config.ts";
import { compareOrReport, withDatabases } from "../helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: intArb,
  b: textArb.filter((s) => s.length <= 12),
});

const predicateArb = fc.oneof(
  fc.record({ kind: fc.constant("gt" as const), n: intArb }),
  fc.record({ kind: fc.constant("eq" as const), n: intArb }),
  fc.record({ kind: fc.constant("isnull" as const) }),
  fc.record({ kind: fc.constant("like" as const), p: fc.constantFrom("%", "a%", "%z", "_") }),
);

function predicateSql(p: fc.InferValue<typeof predicateArb>): string {
  if (p.kind === "gt") return `a > ${p.n}`;
  if (p.kind === "eq") return `a = ${p.n}`;
  if (p.kind === "isnull") return "a IS NULL";
  return `b LIKE '${p.p.replaceAll("'", "''")}'`;
}

/**
 * Ternary Logic Partitioning (SQLancer-style):
 * |Q| = |Q WHERE P| + |Q WHERE NOT P| + |Q WHERE P IS NULL|
 */
describe("TLP metamorphic fuzz", () => {
  test("partition counts sum to full query on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        (rows, pred) => {
          const p = predicateSql(pred);
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              }
            }

            const full = "SELECT id, a, b FROM t ORDER BY id";
            const partTrue = `SELECT id, a, b FROM t WHERE (${p}) ORDER BY id`;
            const partFalse = `SELECT id, a, b FROM t WHERE NOT (${p}) ORDER BY id`;
            const partNull = `SELECT id, a, b FROM t WHERE (${p}) IS NULL ORDER BY id`;

            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-${label}`, sql, { rows, pred }, memory.query(sql), sqlite.query(sql));
            }

            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(
                  `TLP cardinality broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull} pred=${p} engine=${db === memory ? "mem" : "sqlite"}`,
                );
              }
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });

  test("two-table INNER JOIN TLP matches on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        predicateArb,
        (left, right, pred) => {
          const p = predicateSql(pred).replaceAll(/\ba\b/g, "l.a").replaceAll(/\bb\b/g, "l.b");
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of left) db.exec("INSERT INTO l VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of right) db.exec("INSERT INTO r VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const full = "SELECT l.id AS lid, r.id AS rid FROM l INNER JOIN r ON l.id = r.id ORDER BY lid, rid";
            const partTrue = `SELECT l.id AS lid, r.id AS rid FROM l INNER JOIN r ON l.id = r.id WHERE (${p}) ORDER BY lid, rid`;
            const partFalse = `SELECT l.id AS lid, r.id AS rid FROM l INNER JOIN r ON l.id = r.id WHERE NOT (${p}) ORDER BY lid, rid`;
            const partNull = `SELECT l.id AS lid, r.id AS rid FROM l INNER JOIN r ON l.id = r.id WHERE (${p}) IS NULL ORDER BY lid, rid`;
            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-join-${label}`, sql, { left, right, pred }, memory.query(sql), sqlite.query(sql));
            }
            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(`join TLP broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  });

  test("LEFT JOIN TLP on left-table predicate matches on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 8 }),
        predicateArb,
        (left, right, pred) => {
          const p = predicateSql(pred).replaceAll(/\ba\b/g, "l.a").replaceAll(/\bb\b/g, "l.b");
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of left) db.exec("INSERT INTO l VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of right) db.exec("INSERT INTO r VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const full = "SELECT l.id AS lid, r.id AS rid FROM l LEFT JOIN r ON l.a = r.a ORDER BY lid, rid";
            const partTrue = `SELECT l.id AS lid, r.id AS rid FROM l LEFT JOIN r ON l.a = r.a WHERE (${p}) ORDER BY lid, rid`;
            const partFalse = `SELECT l.id AS lid, r.id AS rid FROM l LEFT JOIN r ON l.a = r.a WHERE NOT (${p}) ORDER BY lid, rid`;
            const partNull = `SELECT l.id AS lid, r.id AS rid FROM l LEFT JOIN r ON l.a = r.a WHERE (${p}) IS NULL ORDER BY lid, rid`;
            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-left-${label}`, sql, { left, right, pred }, memory.query(sql), sqlite.query(sql));
            }
            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(`left join TLP broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  });

  test("FULL OUTER JOIN TLP on left-table predicate matches on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 8 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 8 }),
        predicateArb,
        (left, right, pred) => {
          const p = predicateSql(pred).replaceAll(/\ba\b/g, "l.a").replaceAll(/\bb\b/g, "l.b");
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of left) db.exec("INSERT INTO l VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of right) db.exec("INSERT INTO r VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const full = "SELECT l.id AS lid, r.id AS rid FROM l FULL OUTER JOIN r ON l.a = r.a ORDER BY lid, rid";
            const partTrue = `SELECT l.id AS lid, r.id AS rid FROM l FULL OUTER JOIN r ON l.a = r.a WHERE (${p}) ORDER BY lid, rid`;
            const partFalse = `SELECT l.id AS lid, r.id AS rid FROM l FULL OUTER JOIN r ON l.a = r.a WHERE NOT (${p}) ORDER BY lid, rid`;
            const partNull = `SELECT l.id AS lid, r.id AS rid FROM l FULL OUTER JOIN r ON l.a = r.a WHERE (${p}) IS NULL ORDER BY lid, rid`;
            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-full-${label}`, sql, { left, right, pred }, memory.query(sql), sqlite.query(sql));
            }
            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(`full outer TLP broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  });

  test("three-table INNER JOIN chain TLP matches on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 6 }),
        predicateArb,
        (aRows, bRows, cRows, pred) => {
          const p = predicateSql(pred).replaceAll(/\ba\b/g, "a.a").replaceAll(/\bb\b/g, "a.b");
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE b(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of aRows) db.exec("INSERT INTO a VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of bRows) db.exec("INSERT INTO b VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of cRows) db.exec("INSERT INTO c VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const base =
              "SELECT a.id AS aid, b.id AS bid, c.id AS cid FROM a INNER JOIN b ON a.id = b.id INNER JOIN c ON b.id = c.id";
            const order = " ORDER BY aid, bid, cid";
            const full = base + order;
            const partTrue = `${base} WHERE (${p})${order}`;
            const partFalse = `${base} WHERE NOT (${p})${order}`;
            const partNull = `${base} WHERE (${p}) IS NULL${order}`;
            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(
                `tlp-3join-${label}`,
                sql,
                { aRows, bRows, cRows, pred },
                memory.query(sql),
                sqlite.query(sql),
              );
            }
            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(`3-join TLP broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(10),
    );
  });

  test("aggregate SUM partition sums add up to total on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 15 }),
        predicateArb,
        (rows, pred) => {
          const p = predicateSql(pred);
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of rows) db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const total = "SELECT sum(a) AS s FROM t";
            const partTrue = `SELECT sum(a) AS s FROM t WHERE (${p})`;
            const partFalse = `SELECT sum(a) AS s FROM t WHERE NOT (${p})`;
            const partNull = `SELECT sum(a) AS s FROM t WHERE (${p}) IS NULL`;
            for (const [label, sql] of [
              ["total", total],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-agg-${label}`, sql, { rows, pred }, memory.query(sql), sqlite.query(sql));
            }
            for (const db of [memory, sqlite]) {
              const n = (sql: string) => Number(db.query(sql).rows[0]?.[0] ?? 0);
              const delta = n(partTrue) + n(partFalse) + n(partNull) - n(total);
              if (delta !== 0) throw new Error(`aggregate TLP broken: delta=${delta}`);
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  });

  test("DISTINCT count partition (DQP) sums to full on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 15 }),
        predicateArb,
        (rows, pred) => {
          const p = predicateSql(pred);
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of rows) db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const full = "SELECT count(DISTINCT a) AS c FROM t";
            const partTrue = `SELECT count(DISTINCT a) AS c FROM t WHERE (${p})`;
            const partFalse = `SELECT count(DISTINCT a) AS c FROM t WHERE NOT (${p})`;
            const partNull = `SELECT count(DISTINCT a) AS c FROM t WHERE (${p}) IS NULL`;
            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`dqp-${label}`, sql, { rows, pred }, memory.query(sql), sqlite.query(sql));
            }
          });
        },
      ),
      fuzzAssertConfig(12),
    );
  });

  test("IN subquery vs INNER JOIN rewrite yields same ids on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 2, maxLength: 10 }),
        intArb,
        (left, right, threshold) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of left) db.exec("INSERT INTO l VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              for (const row of right) db.exec("INSERT INTO r VALUES (?, ?, ?)", [row.id, row.a, row.b]);
            }
            const inSql = `SELECT l.id FROM l WHERE l.a IN (SELECT r.a FROM r WHERE r.a > ${threshold}) ORDER BY 1`;
            const joinSql = `SELECT DISTINCT l.id FROM l INNER JOIN r ON l.a = r.a WHERE r.a > ${threshold} ORDER BY 1`;
            compareOrReport(
              "in-vs-join-in",
              inSql,
              { left, right, threshold },
              memory.query(inSql),
              sqlite.query(inSql),
            );
            compareOrReport(
              "in-vs-join-join",
              joinSql,
              { left, right, threshold },
              memory.query(joinSql),
              sqlite.query(joinSql),
            );
            const memIn = memory.query(inSql).rows.map((r) => r[0]);
            const memJoin = memory.query(joinSql).rows.map((r) => r[0]);
            const oraIn = sqlite.query(inSql).rows.map((r) => r[0]);
            const oraJoin = sqlite.query(joinSql).rows.map((r) => r[0]);
            if (
              JSON.stringify(memIn) !== JSON.stringify(memJoin) ||
              JSON.stringify(oraIn) !== JSON.stringify(oraJoin)
            ) {
              throw new Error("IN vs JOIN rewrite mismatch between engines or forms");
            }
          });
        },
      ),
      fuzzAssertConfig(15),
    );
  });
});
