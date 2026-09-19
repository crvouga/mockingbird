import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

/** Constrained calendar fields: always-valid dates, well inside both engines' supported range. */
const yearArb = fc.integer({ min: 1, max: 2500 });
const monthArb = fc.integer({ min: 1, max: 12 });
const dayArb = fc.integer({ min: 1, max: 28 });
const hourArb = fc.integer({ min: 0, max: 23 });
const minuteArb = fc.integer({ min: 0, max: 59 });
const secondArb = fc.integer({ min: 0, max: 59 });

const dateArb = fc.record({ y: yearArb, m: monthArb, d: dayArb });
const timestampArb = fc.record({ y: yearArb, m: monthArb, d: dayArb, h: hourArb, mi: minuteArb, s: secondArb });

type DateFields = fc.InferValue<typeof dateArb>;
type TimestampFields = fc.InferValue<typeof timestampArb>;

function makeDate(f: DateFields): string {
  return `make_date(${f.y}, ${f.m}, ${f.d})`;
}

function makeTimestamp(f: TimestampFields): string {
  return `make_timestamp(${f.y}, ${f.m}, ${f.d}, ${f.h}, ${f.mi}, ${f.s})`;
}

describe("datetime differential fuzz", () => {
  test("date arithmetic: +n days and date-date", async () => {
    await fc.assert(
      fc.asyncProperty(dateArb, dateArb, fc.integer({ min: -5000, max: 5000 }), async (d1, d2, n) => {
        const sql =
          `SELECT ${makeDate(d1)} AS a, (${makeDate(d1)} + ${n < 0 ? `(${n})` : n}) AS b, ` +
          `(${makeDate(d1)} - ${n < 0 ? `(${n})` : n}) AS c, (${makeDate(d1)} - ${makeDate(d2)}) AS d`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("date-arith", sql, { d1, d2, n }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("extract fields from random timestamps", async () => {
    const fieldArb = fc.constantFrom(
      "year",
      "month",
      "day",
      "hour",
      "minute",
      "dow",
      "isodow",
      "doy",
      "quarter",
      "week",
      "century",
      "decade",
    );
    await fc.assert(
      fc.asyncProperty(timestampArb, fieldArb, fieldArb, async (ts, f1, f2) => {
        const sql =
          `SELECT extract(${f1} FROM ${makeTimestamp(ts)}) AS a, ` +
          `extract(${f2} FROM ${makeTimestamp(ts)}) AS b, ` +
          `extract(${f1} FROM make_date(${ts.y}, ${ts.m}, ${ts.d})) AS c`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("extract", sql, { ts, f1, f2 }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(30),
    );
  }, 120_000);

  test("date_trunc units on random timestamps", async () => {
    const unitArb = fc.constantFrom("year", "quarter", "month", "week", "day", "hour", "minute");
    await fc.assert(
      fc.asyncProperty(timestampArb, unitArb, unitArb, async (ts, u1, u2) => {
        const sql =
          `SELECT date_trunc('${u1}', ${makeTimestamp(ts)}) AS a, ` +
          `date_trunc('${u2}', ${makeTimestamp(ts)}) AS b, ` +
          `(date_trunc('${u1}', ${makeTimestamp(ts)}) = ${makeTimestamp(ts)}) AS same`;
        await withDatabases(async (memory, postgres) => {
          compareOrReport("date-trunc", sql, { ts, u1, u2 }, await memory.query(sql), await postgres.query(sql));
        });
      }),
      fuzzAssertConfig(25),
    );
  }, 120_000);

  test("interval multiplication and timestamp offsets", async () => {
    await fc.assert(
      fc.asyncProperty(
        timestampArb,
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 0, max: 50 }),
        async (ts, n, k) => {
          const nLit = n < 0 ? `(${n})` : String(n);
          const sql =
            `SELECT (interval '1 day' * ${nLit}) AS a, (interval '2 hours 30 minutes' * ${k}) AS b, ` +
            `(interval '1 hour' * ${nLit}) AS c, ` +
            `(${makeTimestamp(ts)} + interval '1 day' * ${nLit}) AS d, ` +
            `(${makeTimestamp(ts)} - interval '3 hours' * ${k}) AS e`;
          await withDatabases(async (memory, postgres) => {
            compareOrReport("interval-mult", sql, { ts, n, k }, await memory.query(sql), await postgres.query(sql));
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  }, 120_000);
});
