import { expectParity, matrixBoth } from "../../harness/index.ts";

matrixBoth("SELECT 1", (memory, sqlite) => {
  const memoryResult = memory.query("SELECT 1");
  const sqliteResult = sqlite.query("SELECT 1");
  expectParity(memoryResult, sqliteResult);
});

matrixBoth("SELECT literals with aliases", (memory, sqlite) => {
  const sql = "SELECT 1 as x, 2.5 as y, 'hi' as z, null as n";
  expectParity(memory.query(sql), sqlite.query(sql));
});

matrixBoth("syntax error: SELECT FROM", (memory, sqlite) => {
  const memoryResult = memory.query("SELECT FROM");
  const sqliteResult = sqlite.query("SELECT FROM");
  expectParity(memoryResult, sqliteResult);
  if (!memoryResult.ok || !sqliteResult.ok) {
    expect(memoryResult.error?.category).toBe("syntax");
    expect(sqliteResult.error?.category).toBe("syntax");
  }
});
