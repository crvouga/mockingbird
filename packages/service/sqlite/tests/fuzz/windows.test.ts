import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  team: fc.constantFrom("a", "b", "c"),
  name: textArb.filter((s) => s.length > 0),
  score: intArb,
});

describe("window differential fuzz", () => {
  test("random row_number and sum windows match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom("team", "score"),
        (rows, partitionCol) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
              for (const row of rows) {
                db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
              }
            }

            const sql = [
              "SELECT team, name, score,",
              `row_number() OVER (PARTITION BY ${partitionCol} ORDER BY score, name) AS rn,`,
              "sum(score) OVER (PARTITION BY team ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running",
              "FROM scores",
              "ORDER BY team, score, name",
            ].join(" ");

            compareOrReport("windows", sql, { rows, partitionCol }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("random FILTER predicates and ROWS frames match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        intArb,
        fc.integer({ min: 0, max: 3 }),
        (rows, threshold, preceding) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(id INTEGER PRIMARY KEY, team TEXT, name TEXT, score INTEGER)");
              rows.forEach((row, index) => {
                db.exec("INSERT INTO scores(id, team, name, score) VALUES (?, ?, ?, ?)", [
                  index + 1,
                  row.team,
                  row.name,
                  row.score,
                ]);
              });
            }

            const sql = [
              "SELECT id, team, score,",
              `sum(score) FILTER (WHERE score >= ${threshold}) OVER (`,
              `PARTITION BY team ORDER BY score, id ROWS BETWEEN ${preceding} PRECEDING AND CURRENT ROW`,
              ") AS filtered_running,",
              `count(*) FILTER (WHERE score < ${threshold}) OVER (PARTITION BY team) AS filtered_count`,
              "FROM scores ORDER BY id",
            ].join(" ");

            compareOrReport(
              "window-filter-frame",
              sql,
              { rows, threshold, preceding },
              memory.query(sql),
              sqlite.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("RANGE frames and ntile match SQLite", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 8 }), (rows) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
            for (const row of rows) {
              db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
            }
          }

          const sql = [
            "SELECT team, name, score,",
            "ntile(2) OVER (PARTITION BY team ORDER BY score, name) AS bucket,",
            "sum(score) OVER (PARTITION BY team ORDER BY score RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS range_sum",
            "FROM scores ORDER BY team, score, name",
          ].join(" ");

          compareOrReport("window-range-ntile", sql, { rows }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(25),
    );
  });

  test("GROUPS frames and EXCLUDE match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom("CURRENT ROW", "GROUP", "TIES", "NO OTHERS"),
        (rows, exclude) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
              for (const row of rows) {
                db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
              }
            }
            const sql = [
              "SELECT team, name, score,",
              `sum(score) OVER (PARTITION BY team ORDER BY score, name GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE ${exclude}) AS gsum`,
              "FROM scores ORDER BY team, score, name",
            ].join(" ");
            compareOrReport("window-groups-exclude", sql, { rows, exclude }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });

  test("IGNORE NULLS and RESPECT NULLS on lead/lag match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 20 }), v: fc.option(intArb, { nil: null }) }), {
          minLength: 2,
          maxLength: 10,
        }),
        fc.constantFrom("IGNORE NULLS", "RESPECT NULLS"),
        (rows, nullsOpt) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?)", [row.id, row.v]);
              }
            }
            const sql = `SELECT id, v, lag(v) OVER (ORDER BY id ${nullsOpt}) AS p, lead(v) OVER (ORDER BY id ${nullsOpt}) AS n FROM t ORDER BY id`;
            compareOrReport("window-nulls-opt", sql, { rows, nullsOpt }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });

  test("nth_value and illegal window in WHERE error parity", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 2, maxLength: 6 }), fc.integer({ min: 1, max: 3 }), (rows, n) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
            for (const row of rows) {
              db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
            }
          }
          const okSql = `SELECT team, nth_value(score, ${n}) OVER (PARTITION BY team ORDER BY score, name) AS nv FROM scores ORDER BY team, score, name`;
          compareOrReport("nth-value", okSql, { rows, n }, memory.query(okSql), sqlite.query(okSql));
          const badSql = "SELECT id FROM scores WHERE row_number() OVER (ORDER BY score) = 1";
          const memBad = memory.query(badSql);
          const oraBad = sqlite.query(badSql);
          if (memBad.ok !== oraBad.ok) {
            throw new Error(`window-in-where outcome mismatch mem=${memBad.ok} sqlite=${oraBad.ok}`);
          }
        });
      }),
      fuzzAssertConfig(15),
    );
  });
});
