import { expect, test } from "bun:test";
import { analyzeSchema, Database } from "../../../src/index.ts";

test("#457 reports independent gaps with locations and missing prerequisites", () => {
  const report = analyzeSchema(
    `CREATE TABLE broken (id unavailable_type);\nCREATE VIEW dependent AS SELECT * FROM broken;\nCREATE SEQUENCE okay;\nCREATE TABLE also_broken (id another_unavailable_type);`,
  );
  expect(report.statements).toBe(4);
  expect(report.accepted).toBe(1);
  expect(report.compatible).toBe(false);
  expect(report.diagnostics[1]).toMatchObject({
    statement: 2,
    line: 2,
    column: 1,
    object: "dependent",
    category: "prerequisite",
    prerequisiteStatement: 1,
  });
  expect(report.diagnostics[3]).toMatchObject({ statement: 4, line: 4, object: "also_broken", sqlstate: "42704" });
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});

test("#457 isolated validation preserves live database and never claims semantic verification", () => {
  const db = new Database();
  db.exec("CREATE TABLE live (id int)");
  const report = analyzeSchema(
    "CREATE TABLE scratch (id int); CREATE FUNCTION dynamic_fn() RETURNS void LANGUAGE plpgsql AS $$BEGIN EXECUTE 'SELECT 1'; END$$;",
  );
  expect(report.accepted).toBe(2);
  expect(report.compatible).toBeNull();
  expect(report.diagnostics.every((item) => item.category === "unknown")).toBe(true);
  expect(() => db.query("SELECT * FROM scratch")).toThrow();
  expect(db.query("SELECT * FROM live")).toEqual([]);
});

test("#457 respects strings, comments and dollar-quoted body boundaries", () => {
  const report = analyzeSchema(
    "-- ;\nCREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT ';'::text $$; CREATE TABLE t (id int);",
  );
  expect(report.statements).toBe(2);
  expect(report.accepted).toBe(2);
});

test("#457 bounds input, statements and diagnostics", () => {
  expect(analyzeSchema("CREATE TABLE t (id int)", { maxInputBytes: 8 })).toMatchObject({
    statements: 0,
    truncated: true,
    compatible: false,
  });
  expect(analyzeSchema("CREATE TABLE a(id int);CREATE TABLE b(id int)", { maxStatements: 1 }).statements).toBe(1);
  expect(analyzeSchema("SELECT 1;SELECT 2", { maxDiagnostics: 1 })).toMatchObject({
    truncated: true,
    diagnostics: [expect.anything()],
  });
  expect(() => analyzeSchema("", { maxDiagnostics: Infinity })).toThrow(RangeError);
});

test("#457 recognizes qualified missing prerequisites", () => {
  const report = analyzeSchema(
    "CREATE TABLE public.failed (id unavailable_type); CREATE VIEW dependent AS SELECT * FROM public.failed",
  );
  expect(report.diagnostics[1]).toMatchObject({ category: "prerequisite", prerequisiteStatement: 1 });
});
