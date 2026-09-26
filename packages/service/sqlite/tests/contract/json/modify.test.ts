import { Database as BunDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { parity } from "../helpers.ts";

parity("json_insert skips existing", [], `SELECT json_insert('{"a":2,"c":4}', '$.a', 99)`);
parity("json_insert creates", [], `SELECT json_insert('{"a":2,"c":4}', '$.e', 99)`);
parity("json_replace overwrites", [], `SELECT json_replace('{"a":2,"c":4}', '$.a', 99)`);
parity("json_replace skips missing", [], `SELECT json_replace('{"a":2,"c":4}', '$.e', 99)`);
parity("json_set overwrite", [], `SELECT json_set('{"a":2,"c":4}', '$.a', 99)`);
parity("json_set create", [], `SELECT json_set('{"a":2,"c":4}', '$.e', 99)`);
parity("json_set quotes plain text", [], `SELECT json_set('{"a":2,"c":4}', '$.c', '[97,96]')`);
parity("json_set nests json()", [], `SELECT json_set('{"a":2,"c":4}', '$.c', json('[97,96]'))`);
parity("json_set append [#]", [], `SELECT json_set('[0,1,2]', '$[#]', 'new')`);
parity("json_set replace [#-1]", [], `SELECT json_set('[0,1,2]', '$[#-1]', 9)`);
parity("json_insert append", [], `SELECT json_insert('[1,2,3,4]', '$[#]', 99)`);
parity("json_remove key", [], `SELECT json_remove('{"a":1,"b":2}', '$.b')`);
parity("json_patch merge", [], `SELECT json_patch('{"a":1,"b":2}', '{"b":null,"c":3}')`);

test("json_array_insert documented examples", () => {
  const db = new InMemoryAdapter();
  try {
    const mid = db.query(`SELECT json_array_insert('[1,2,3]','$[1]','new') AS v`);
    expect(mid.ok).toBe(true);
    expect(String(mid.rows[0]!.v)).toBe('[1,"new",2,3]');
    const nested = db.query(`SELECT json_array_insert('{"a":[1,2,3]}','$.a[0]','new') AS v`);
    expect(nested.ok).toBe(true);
    expect(String(nested.rows[0]!.v)).toBe('{"a":["new",1,2,3]}');
  } finally {
    db.close();
  }
});

test("json_array_insert rejects a path that is not an array index", () => {
  const db = new InMemoryAdapter();
  try {
    const result = db.query(`SELECT json_array_insert('{"a":1}','$.a',2)`);
    expect(result.ok).toBe(false);
  } finally {
    db.close();
  }
});

{
  const oracle = new BunDatabase(":memory:");
  const hasArrayInsert =
    oracle.prepare("select 1 as ok from pragma_function_list() where name = 'json_array_insert' limit 1").get() != null;
  oracle.close();
  if (hasArrayInsert) {
    parity("json_array_insert middle", [], `SELECT json_array_insert('[1,2,3]', '$[1]', 'new') AS v`);
    parity("json_array_insert nested", [], `SELECT json_array_insert('{"a":[1,2,3]}', '$.a[0]', 'new') AS v`);
  }
}
