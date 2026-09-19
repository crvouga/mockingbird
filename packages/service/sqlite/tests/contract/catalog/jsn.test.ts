import { expect } from "bun:test";
import { runCatalog } from "./run.ts";

runCatalog("JSN", [
  { id: "JSN-json-01", kind: "parity", sql: "SELECT json(' { \"a\" : 1 } ')" },
  { id: "JSN-valid-01", kind: "parity", sql: "SELECT json_valid('{\"a\":1}'), json_valid('{')" },
  { id: "JSN-valid-02", kind: "parity", sql: "SELECT json_valid('{\"a\":1}', 1)" },
  { id: "JSN-errpos-01", kind: "parity", sql: "SELECT json_error_position('{')" },
  { id: "JSN-arr-01", kind: "parity", sql: "SELECT json_array(1, 'a', NULL)" },
  { id: "JSN-obj-01", kind: "parity", sql: "SELECT json_object('a', 1, 'b', NULL)" },
  { id: "JSN-obj-02", kind: "error", sql: "SELECT json_object('a', 1, 'b')", query: true },
  { id: "JSN-quote-01", kind: "parity", sql: "SELECT json_quote('a'), json_quote(1)" },
  { id: "JSN-extract-01", kind: "parity", sql: "SELECT json_extract('{\"a\":1}', '$.a')" },
  { id: "JSN-extract-02", kind: "parity", sql: "SELECT json_extract('{\"a\":1,\"b\":2}', '$.a', '$.b')" },
  { id: "JSN-arrow-01", kind: "parity", sql: "SELECT '{\"a\":1}' -> '$.a'" },
  { id: "JSN-arrow-02", kind: "parity", sql: "SELECT '{\"a\":1}' ->> '$.a'" },
  { id: "JSN-arrow-03", kind: "parity", sql: "SELECT '[10,20]' -> 1" },
  { id: "JSN-path-01", kind: "parity", sql: "SELECT json_extract('{\"a\":{\"b\":1}}', '$.a.b')" },
  {
    id: "JSN-path-02",
    kind: "parity",
    sql: "SELECT json_extract('[1,2,3]', '$[0]'), json_extract('[1,2,3]', '$[#-1]')",
  },
  { id: "JSN-path-03", kind: "parity", sql: "SELECT json_extract('{\"a b\":1}', '$.\"a b\"')" },
  { id: "JSN-path-04", kind: "error", sql: "SELECT json_extract('{}', 'not-a-path')", query: true },
  { id: "JSN-set-01", kind: "parity", sql: "SELECT json_set('{\"a\":1}', '$.b', 2)" },
  { id: "JSN-insert-01", kind: "parity", sql: "SELECT json_insert('{\"a\":1}', '$.a', 9)" },
  { id: "JSN-replace-01", kind: "parity", sql: "SELECT json_replace('{\"a\":1}', '$.a', 9)" },
  { id: "JSN-remove-01", kind: "parity", sql: "SELECT json_remove('{\"a\":1,\"b\":2}', '$.a', '$.b')" },
  { id: "JSN-patch-01", kind: "parity", sql: "SELECT json_patch('{\"a\":1}', '{\"b\":2}')" },
  { id: "JSN-type-01", kind: "parity", sql: "SELECT json_type('{\"a\":[1]}'), json_type('{\"a\":[1]}', '$.a')" },
  { id: "JSN-len-01", kind: "parity", sql: "SELECT json_array_length('[1,2,3]')" },
  {
    id: "JSN-garr-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a)", "INSERT INTO t VALUES (1),(2)"],
    sql: "SELECT json_group_array(a) FROM t",
  },
  {
    id: "JSN-gobj-01",
    kind: "parity",
    setup: ["CREATE TABLE t(k TEXT, v INT)", "INSERT INTO t VALUES ('a',1),('b',2)"],
    sql: "SELECT json_group_object(k,v) FROM t",
  },
  { id: "JSN-each-01", kind: "parity", sql: "SELECT key, value, type FROM json_each('[1,2]') ORDER BY id" },
  {
    id: "JSN-each-02",
    kind: "parity",
    setup: ["CREATE TABLE t(j TEXT)", "INSERT INTO t VALUES ('[1,2]'),('[3]')"],
    sql: "SELECT t.j FROM t ORDER BY t.rowid",
  },
  { id: "JSN-tree-01", kind: "parity", sql: "SELECT key, fullkey, path FROM json_tree('{\"a\":[1]}') ORDER BY id" },
  { id: "JSN-sub-01", kind: "parity", sql: "SELECT json_array(json_extract('{\"a\":1}', '$.a'))" },
  { id: "JSN-sub-02", kind: "parity", sql: "SELECT json('{\"a\":1}'), '{\"a\":1}'" },
  {
    id: "JSN-sub-03",
    kind: "divergence",
    fn: (db) => {
      const row = db.query<{ v: unknown }>("SELECT json('{\"a\":1}') AS v")[0]!;
      expect(typeof row.v).toBe("string");
    },
  },
  { id: "JSN-jsonb-01", kind: "parity", sql: "SELECT typeof(jsonb('{\"a\":1}'))" },
]);
