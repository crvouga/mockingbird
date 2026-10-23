import { expect, test } from "bun:test";
import * as fc from "fast-check";
import { Writer } from "../../src/serialization/wire.ts";

test("Number int64 encoding is byte-identical to BigInt encoding, including signed and unsafe boundaries", () => {
  const verify = (value: number) => {
    const reference = new Writer();
    const optimized = new Writer();
    reference.i64(BigInt(value));
    optimized.i64Number(value);
    expect(optimized.finish()).toEqual(reference.finish());
  };
  for (const value of [
    0,
    -0,
    1,
    -1,
    2147483647,
    -2147483648,
    4294967295,
    4294967296,
    -4294967297,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    2 ** 63,
    -(2 ** 63),
    2 ** 70,
    -(2 ** 70),
    Number.MAX_VALUE,
  ])
    verify(value);
  fc.assert(
    fc.property(fc.bigInt({ min: -(1n << 100n), max: 1n << 100n }), (value) => verify(Number(value))),
    { seed: 3217, numRuns: 300 },
  );
});
