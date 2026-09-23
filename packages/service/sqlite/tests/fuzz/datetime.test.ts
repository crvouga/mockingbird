import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const timesArb = fc.constantFrom(
  "2024-01-01 12:00:00",
  "2024-01-01 12:00:00.123",
  "2024-01-01 12:00:00.400",
  "2024-06-15 08:30:00",
  "2023-12-31 23:59:59",
);

const modifierArb = fc.constantFrom(
  "subsec",
  "auto",
  "floor",
  "ceiling",
  "start of day",
  "start of month",
  "start of year",
  "weekday 0",
  "weekday 1",
  "+1 day",
  "-1 month",
  "+2 hours",
);

describe("datetime differential fuzz", () => {
  test("datetime modifiers match SQLite", () => {
    fc.assert(
      fc.property(timesArb, modifierArb, (time, modifier) => {
        // Avoid localtime/utc (intentional divergence).
        const sql = `SELECT datetime(${sqlLiteral(time)}, ${sqlLiteral(modifier)}) AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("datetime-mod", sql, { time, modifier }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  });

  test("date time combined modifiers match SQLite", () => {
    fc.assert(
      fc.property(
        timesArb,
        fc.constantFrom("subsec", "floor", "ceiling"),
        fc.constantFrom("+1 day", "-1 day", "start of month"),
        (time, a, b) => {
          const sql = `SELECT datetime(${sqlLiteral(time)}, ${sqlLiteral(a)}, ${sqlLiteral(b)}) AS v`;
          withDatabases((memory, sqlite) => {
            compareOrReport("datetime-chain", sql, { time, a, b }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });

  test("unix auto magnitude matches SQLite", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }), (unix) => {
        const sql = `SELECT datetime(${unix}, 'auto') AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("datetime-auto", sql, { unix }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(20),
    );
  });
});
