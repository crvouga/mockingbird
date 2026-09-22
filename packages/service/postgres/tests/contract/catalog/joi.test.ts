import { JOI_SECTION } from "../../../compat/sections/joi.ts";
import { runCatalog } from "./run.ts";

const AB = [
  "CREATE TABLE a (id int, name text)",
  "CREATE TABLE b (id int, aid int, val int)",
  "INSERT INTO a VALUES (1, 'one'), (2, 'two'), (3, 'three')",
  "INSERT INTO b VALUES (10, 1, 100), (11, 1, 110), (12, 2, 120), (13, NULL, 130)",
];

const ABC = [...AB, "CREATE TABLE c (id int, bid int, tag text)", "INSERT INTO c VALUES (20, 10, 'x'), (21, 12, 'y')"];

const UW = [
  "CREATE TABLE u (id int, x text)",
  "CREATE TABLE w (id int, y text)",
  "INSERT INTO u VALUES (1, 'ux1'), (2, 'ux2')",
  "INSERT INTO w VALUES (2, 'wy2'), (3, 'wy3')",
];

const CUST = [
  "CREATE TABLE cust (id int, name text)",
  "CREATE TABLE ord (id int, cid int, amt int)",
  "INSERT INTO cust VALUES (1, 'ann'), (2, 'bob'), (3, 'cid')",
  "INSERT INTO ord VALUES (10, 1, 50), (11, 1, 75), (12, 2, 20)",
];

runCatalog(JOI_SECTION, [
  {
    id: "JOI-inner-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a JOIN b ON b.aid = a.id ORDER BY b.val",
  },
  {
    id: "JOI-inner-02",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.id, b.id AS bid FROM a JOIN b ON b.id = a.id + 9 ORDER BY a.id",
  },
  {
    id: "JOI-comma-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a, b WHERE b.aid = a.id ORDER BY b.val",
  },
  {
    id: "JOI-cross-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.id, s.v FROM a CROSS JOIN (VALUES (1), (2)) s(v) ORDER BY a.id, s.v",
  },
  {
    id: "JOI-left-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a LEFT JOIN b ON b.aid = a.id ORDER BY a.id, b.val NULLS LAST",
  },
  {
    id: "JOI-left-02",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a LEFT JOIN b ON b.aid = a.id AND b.val > 100 ORDER BY a.id, b.val NULLS LAST",
  },
  {
    id: "JOI-left-03",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a LEFT JOIN b ON b.aid = a.id WHERE b.val > 100 ORDER BY a.id, b.val",
  },
  {
    id: "JOI-right-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, b.val FROM a RIGHT JOIN b ON b.aid = a.id ORDER BY b.val",
  },
  {
    id: "JOI-full-01",
    kind: "parity",
    sql: "SELECT x.k AS xk, y.k AS yk FROM (VALUES (1), (2)) x(k) FULL JOIN (VALUES (2), (3)) y(k) ON x.k = y.k ORDER BY xk NULLS LAST, yk NULLS LAST",
  },
  { id: "JOI-using-01", kind: "parity", setup: UW, sql: "SELECT * FROM u JOIN w USING (id) ORDER BY id" },
  {
    id: "JOI-using-02",
    kind: "parity",
    setup: UW,
    sql: "SELECT id, u.id AS uid, w.id AS wid, x, y FROM u JOIN w USING (id) ORDER BY id",
  },
  { id: "JOI-natural-01", kind: "parity", setup: UW, sql: "SELECT * FROM u NATURAL JOIN w ORDER BY id" },
  { id: "JOI-natural-02", kind: "parity", setup: UW, sql: "SELECT * FROM u NATURAL LEFT JOIN w ORDER BY id" },
  {
    id: "JOI-natural-03",
    kind: "parity",
    sql: "SELECT * FROM (VALUES (1)) p(pa) NATURAL JOIN (VALUES (2)) q(qb)",
  },
  {
    id: "JOI-chain-01",
    kind: "parity",
    setup: ABC,
    sql: "SELECT a.name, b.val, c.tag FROM a JOIN b ON b.aid = a.id JOIN c ON c.bid = b.id ORDER BY c.tag",
  },
  {
    id: "JOI-paren-01",
    kind: "parity",
    setup: ABC,
    sql: "SELECT a.name, b.val, c.tag FROM a LEFT JOIN (b JOIN c ON c.bid = b.id) ON b.aid = a.id ORDER BY a.id, c.tag NULLS LAST",
  },
  {
    id: "JOI-self-01",
    kind: "parity",
    setup: [
      "CREATE TABLE emp (id int, mgr int, name text)",
      "INSERT INTO emp VALUES (1, NULL, 'root'), (2, 1, 'ann'), (3, 1, 'bob'), (4, 2, 'cat')",
    ],
    sql: "SELECT e.name, m.name AS boss FROM emp e LEFT JOIN emp m ON m.id = e.mgr ORDER BY e.id",
  },
  {
    id: "JOI-mixed-01",
    kind: "parity",
    setup: ABC,
    sql: "SELECT a.name, b.val, c.tag FROM a JOIN b ON b.aid = a.id LEFT JOIN c ON c.bid = b.id ORDER BY a.id, b.val, c.tag NULLS LAST",
  },
  {
    id: "JOI-lat-01",
    kind: "parity",
    sql: "SELECT t.n, g FROM (VALUES (2), (3)) t(n), LATERAL generate_series(1, t.n) g ORDER BY t.n, g",
  },
  {
    id: "JOI-lat-02",
    kind: "parity",
    sql: "SELECT t.id, u FROM (VALUES (1, ARRAY[10, 20]), (2, ARRAY[30])) t(id, arr), LATERAL unnest(t.arr) u ORDER BY t.id, u",
  },
  {
    id: "JOI-lat-03",
    kind: "parity",
    setup: CUST,
    sql: "SELECT c.name, o.amt FROM cust c, LATERAL (SELECT amt FROM ord WHERE ord.cid = c.id ORDER BY amt DESC LIMIT 1) o ORDER BY c.name",
  },
  {
    id: "JOI-lat-04",
    kind: "parity",
    setup: CUST,
    sql: "SELECT c.name, o.amt FROM cust c LEFT JOIN LATERAL (SELECT amt FROM ord WHERE ord.cid = c.id ORDER BY amt DESC LIMIT 1) o ON true ORDER BY c.name",
  },
  {
    id: "JOI-semi-01",
    kind: "parity",
    setup: CUST,
    sql: "SELECT name FROM cust WHERE EXISTS (SELECT 1 FROM ord WHERE ord.cid = cust.id) ORDER BY name",
  },
  {
    id: "JOI-anti-01",
    kind: "parity",
    setup: CUST,
    sql: "SELECT name FROM cust WHERE NOT EXISTS (SELECT 1 FROM ord WHERE ord.cid = cust.id) ORDER BY name",
  },
  {
    id: "JOI-multi-01",
    kind: "parity",
    setup: ABC,
    sql: "SELECT a.name, count(c.id) AS tags FROM a JOIN b ON b.aid = a.id LEFT JOIN c ON c.bid = b.id GROUP BY a.name ORDER BY a.name",
  },
  {
    id: "JOI-expr-01",
    kind: "parity",
    sql: "SELECT g.v, r.label FROM generate_series(1, 5) AS g(v) JOIN (VALUES (1, 3, 'low'), (4, 5, 'high')) r(lo, hi, label) ON g.v BETWEEN r.lo AND r.hi ORDER BY g.v",
  },
  {
    id: "JOI-outer-01",
    kind: "parity",
    setup: AB,
    sql: "SELECT a.name, count(b.id) AS n FROM a LEFT JOIN b ON b.aid = a.id GROUP BY a.name ORDER BY a.name",
  },
  {
    id: "JOI-err-01",
    kind: "error",
    setup: UW,
    sql: "SELECT id FROM u JOIN w ON u.id = w.id",
    query: true,
    messageTier: "A",
  },
  {
    id: "JOI-err-02",
    kind: "error",
    setup: ["CREATE TABLE u (id int, x text)", "CREATE TABLE nn (other int)"],
    sql: "SELECT * FROM u JOIN nn USING (id)",
    query: true,
    messageTier: "A",
  },
]);
