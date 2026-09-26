import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { parity, queryErrorParity, sequenceParity } from "../helpers.ts";

parity(
  "LIKE handles NULL empty patterns and blobs",
  [],
  "SELECT NULL LIKE 'x' AS null_lhs,'x' LIKE NULL AS null_rhs,'' LIKE '' AS empty_match,'x' LIKE '' AS empty_miss,X'6162' LIKE 'ab' AS blob_match",
);

parity(
  "LIKE remains ASCII-only case insensitive",
  [],
  "SELECT 'a' LIKE 'A' AS ascii_match,'ß' LIKE 'SS' AS unicode_miss",
);

queryErrorParity("LIKE rejects an empty ESCAPE expression", [], "SELECT 'a' LIKE 'a' ESCAPE ''");

sequenceParity(
  "PRAGMA case_sensitive_like makes LIKE and like() case-sensitive",
  [],
  [
    { sql: "SELECT 'a' LIKE 'A' AS ascii_ci, like('A','a') AS fn_ci", query: true },
    { sql: "PRAGMA case_sensitive_like = 1" },
    {
      sql: "SELECT 'a' LIKE 'A' AS miss, 'A' LIKE 'A' AS hit, like('A','a') AS fn_miss, like('A','A') AS fn_hit",
      query: true,
    },
    { sql: "SELECT 'abc' GLOB 'A*' AS glob_still_sensitive", query: true },
  ],
);

sequenceParity(
  "PRAGMA case_sensitive_like can be turned back off",
  [],
  [
    { sql: "PRAGMA case_sensitive_like = 1" },
    { sql: "PRAGMA case_sensitive_like = 0" },
    { sql: "SELECT 'a' LIKE 'A' AS v", query: true },
  ],
);

test("sqlite-mem case_sensitive_like getter returns 0 then 1", () => {
  const db = new Database();
  try {
    expect(db.query<{ case_sensitive_like: number }>("PRAGMA case_sensitive_like")).toEqual([
      { case_sensitive_like: 0 },
    ]);
    db.exec("PRAGMA case_sensitive_like = ON");
    expect(db.query<{ case_sensitive_like: number }>("PRAGMA case_sensitive_like")).toEqual([
      { case_sensitive_like: 1 },
    ]);
  } finally {
    db.close();
  }
});

parity(
  "NOT GLOB negates GLOB and preserves NULL",
  [],
  "SELECT 'abc' NOT GLOB 'a*' AS no_match,'xyz' NOT GLOB 'a*' AS match,NULL NOT GLOB '*' AS null_value",
);
