import { parity, sequenceParity } from "../helpers.ts";

parity(
  "json + join",
  [
    "CREATE TABLE users(id INTEGER PRIMARY KEY, data TEXT)",
    "CREATE TABLE tags(user_id INT, tag TEXT)",
    `INSERT INTO users VALUES (1, '{"name":"a"}'), (2, '{"name":"b"}')`,
    "INSERT INTO tags VALUES (1, 'x'), (1, 'y'), (2, 'z')",
  ],
  `SELECT u.id AS id, json_extract(u.data, '$.name') AS name, t.tag AS tag
    FROM users u JOIN tags t ON t.user_id = u.id
    ORDER BY u.id, t.tag`,
);

parity(
  "json + group by",
  [
    "CREATE TABLE events(data TEXT)",
    `INSERT INTO events VALUES ('{"user":"a","action":"login"}'), ('{"user":"a","action":"logout"}'), ('{"user":"b","action":"login"}')`,
  ],
  `SELECT json_extract(data, '$.user') AS user, COUNT(*) AS c, json_group_array(json_extract(data, '$.action')) AS actions
    FROM events GROUP BY 1 ORDER BY 1`,
);

parity(
  "json + cte",
  [],
  `
  WITH j(x) AS (SELECT json_object('a', 1))
  SELECT json_extract(x, '$.a') AS a FROM j`,
);

parity(
  "json + case cast",
  [],
  `
  SELECT CASE WHEN json_extract('{"n":1}', '$.n') = 1 THEN 'yes' ELSE 'no' END AS c,
         CAST(json_extract('{"n":"2"}', '$.n') AS INTEGER) AS n`,
);

parity("json + parameters", [], `SELECT json_extract(?, '$.a') AS a`, ['{"a":1}']);

parity(
  "json + window",
  ["CREATE TABLE t(id INTEGER, data TEXT)", `INSERT INTO t VALUES (1, '{"v":10}'), (2, '{"v":20}'), (3, '{"v":30}')`],
  `SELECT id, json_extract(data, '$.v') AS v,
          SUM(json_extract(data, '$.v')) OVER (ORDER BY id) AS running
   FROM t ORDER BY id`,
);

sequenceParity(
  "json + view + transaction",
  ["CREATE TABLE t(data TEXT)", "CREATE VIEW v AS SELECT json_extract(data, '$.x') AS x FROM t"],
  [
    { sql: "BEGIN" },
    { sql: `INSERT INTO t VALUES ('{"x":1}'), ('{"x":2}')` },
    { sql: "SELECT * FROM v ORDER BY x", query: true },
    { sql: "COMMIT" },
  ],
  { compareFinalState: true },
);
