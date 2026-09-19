import { LIM_SECTION } from "../../../compat/sections/lim.ts";
import { runCatalog } from "./run.ts";

const DEEP_PARENS = `${"(".repeat(60)}1${")".repeat(60)}`;
const UNION_TERMS = Array.from({ length: 50 }, (_, i) => `SELECT ${i} AS v`).join(" UNION ALL ");
const MANY_COLS = Array.from({ length: 120 }, (_, i) => `c${i} int`).join(", ");
const MANY_COL_VALUES = Array.from({ length: 120 }, (_, i) => `${i}`).join(", ");
const MANY_VALUES = Array.from({ length: 300 }, (_, i) => `(${i})`).join(", ");
const BIG_IN = Array.from({ length: 500 }, (_, i) => `${i}`).join(", ");
const LONG_IDENT = "a".repeat(60);

runCatalog(LIM_SECTION, [
  { id: "LIM-depth-01", kind: "parity", sql: `SELECT ${DEEP_PARENS} + 1 AS v` },
  { id: "LIM-cmpd-01", kind: "parity", sql: `SELECT count(*)::int AS c, sum(v)::int AS s FROM (${UNION_TERMS}) u` },
  {
    id: "LIM-cols-01",
    kind: "parity",
    setup: [`CREATE TABLE wide (${MANY_COLS})`, `INSERT INTO wide VALUES (${MANY_COL_VALUES})`],
    sql: "SELECT c0, c59, c119 FROM wide",
  },
  {
    id: "LIM-vals-01",
    kind: "parity",
    sql: `SELECT count(*)::int AS c, min(column1)::int AS lo, max(column1)::int AS hi FROM (VALUES ${MANY_VALUES}) v`,
  },
  {
    id: "LIM-in-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t SELECT generate_series(1, 600)"],
    sql: `SELECT count(*)::int AS c FROM t WHERE n IN (${BIG_IN})`,
  },
  {
    id: "LIM-ident-01",
    kind: "parity",
    setup: [`CREATE TABLE ${LONG_IDENT} (${LONG_IDENT}x int)`, `INSERT INTO ${LONG_IDENT} VALUES (1)`],
    sql: `SELECT ${LONG_IDENT}x FROM ${LONG_IDENT}`,
  },
  {
    id: "LIM-zero-01",
    kind: "parity",
    setup: ["CREATE TABLE t (k text PRIMARY KEY, v int)", "INSERT INTO t VALUES ('', 0)"],
    sql: "SELECT k, v, length(k) AS klen FROM t",
  },
  { id: "LIM-zero-02", kind: "parity", sql: "SELECT 1 AS a, 'x' AS b, NULL::int AS c" },
  {
    id: "LIM-null-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (NULL), (NULL), (NULL)"],
    sql: "SELECT count(*)::int AS c, count(n)::int AS cn, sum(n)::int AS s, min(n)::int AS mn FROM t",
  },
]);
