import { Database as BunDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

test("percentile extension aggregate, grouped, window and NULL behavior matches SQLite", () => {
  const memory = new Database();
  const oracle = new BunDatabase(":memory:");
  const enabled =
    (oracle.query("SELECT count(*) AS n FROM pragma_function_list WHERE name='median'").get() as { n: number }).n > 0;
  const queries: Array<[string, unknown[]]> = [
    [
      "SELECT median(x) AS m, percentile(x,25) AS p, percentile_cont(x,0.25) AS c, percentile_disc(x,0.25) AS d FROM t",
      [{ m: 2.5, p: 1.75, c: 1.75, d: 1 }],
    ],
    ["SELECT median(NULL) AS v, percentile(NULL,50) AS p", [{ v: null, p: null }]],
    ["SELECT median(x) AS v FROM t WHERE 0", [{ v: null }]],
    ["SELECT typeof(median(x)) AS t FROM t", [{ t: "real" }]],
    ["SELECT percentile(x,'100') AS v FROM t", [{ v: 4 }]],
    [
      "SELECT x%2 AS g, median(x) AS m FROM t WHERE x IS NOT NULL GROUP BY x%2 ORDER BY g",
      [
        { g: 0, m: 3 },
        { g: 1, m: 2 },
      ],
    ],
    [
      "SELECT x, median(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS m FROM t WHERE x IS NOT NULL ORDER BY x",
      [
        { x: 1, m: 1 },
        { x: 2, m: 1.5 },
        { x: 3, m: 2.5 },
        { x: 4, m: 3.5 },
      ],
    ],
  ];
  try {
    for (const db of [memory, oracle]) db.exec("CREATE TABLE t(x); INSERT INTO t VALUES(4),(NULL),(1),(3),(2)");
    for (const [sql, expected] of queries) {
      const actual = memory.prepare(sql).all();
      expect(actual).toEqual(expected);
      if (enabled) expect(actual).toEqual(oracle.prepare(sql).all());
    }
    for (const sql of [
      "SELECT percentile(1,-1)",
      "SELECT percentile(1,NULL)",
      "SELECT percentile(1,101)",
      "SELECT percentile_cont(1,2)",
      "SELECT percentile('3',50)",
      "SELECT median(1e999)",
      "SELECT percentile(x,x*25) FROM t",
      "SELECT percentile(1)",
    ]) {
      let message = "";
      try {
        memory.prepare(sql).all();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      if (enabled) expect(() => oracle.prepare(sql).all()).toThrow(message);
    }
  } finally {
    memory.close();
    oracle.close();
  }
});
