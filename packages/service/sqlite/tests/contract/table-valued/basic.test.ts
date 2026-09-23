import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

describe("table-valued functions", () => {
  test("generate_series yields inclusive integer range", () => {
    const db = new Database();
    expect(db.query<{ value: number }>("SELECT value FROM generate_series(1, 3) ORDER BY value")).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
  });

  test("generate_series respects step", () => {
    const db = new Database();
    expect(db.query<{ value: number }>("SELECT value FROM generate_series(1, 5, 2) ORDER BY value")).toEqual([
      { value: 1 },
      { value: 3 },
      { value: 5 },
    ]);
  });
});
