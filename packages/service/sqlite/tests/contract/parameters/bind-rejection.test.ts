import { expect, test } from "bun:test";
import { Database, SqliteError } from "../../../src/index.ts";
import { divergence } from "../helpers.ts";

/**
 * Intentional API divergence: JS NaN / Infinity binds are rejected.
 * bun:sqlite coerces NaN→NULL and accepts Infinity. Pin so the divergence cannot drift.
 * @no-oracle (intentional divergence nan-infinity-bind)
 */
test("NaN bind is datatype_mismatch", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [Number.NaN])).toThrow(SqliteError);
  try {
    db.query("SELECT ?", [Number.NaN]);
  } catch (error) {
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

test("Infinity bind is datatype_mismatch", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [Number.POSITIVE_INFINITY])).toThrow(SqliteError);
  try {
    db.query("SELECT ?", [Number.POSITIVE_INFINITY]);
  } catch (error) {
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

test("negative Infinity bind is datatype_mismatch", () => {
  const db = new Database();
  try {
    db.query("SELECT ?", [Number.NEGATIVE_INFINITY]);
    expect.unreachable();
  } catch (error) {
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

test("undefined bind is rejected", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [undefined as unknown as null])).toThrow(SqliteError);
});

divergence("bind-reject-date", "Date objects are datatype_mismatch (API-only; oracle has no Date bind)", (db) => {
  try {
    db.query("SELECT ?", [new Date("2020-01-01T00:00:00.000Z") as never]);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteError);
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

divergence("bind-reject-dataview", "DataView is misuse (only Uint8Array / ArrayBuffer as BLOB)", (db) => {
  try {
    db.query("SELECT ?", [new DataView(new ArrayBuffer(4)) as never]);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteError);
    expect((error as SqliteError).category).toBe("misuse");
  }
});

divergence("bind-reject-plain-object", "plain objects are datatype_mismatch", (db) => {
  try {
    db.query("SELECT ?", [{ a: 1 } as never]);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteError);
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

divergence("bind-reject-shared-buffer", "SharedArrayBuffer-backed views are misuse", (db) => {
  if (typeof SharedArrayBuffer === "undefined") return;
  const sab = new SharedArrayBuffer(4);
  try {
    db.query("SELECT ?", [new Uint8Array(sab) as never]);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteError);
    expect((error as SqliteError).category).toBe("misuse");
  }
});
