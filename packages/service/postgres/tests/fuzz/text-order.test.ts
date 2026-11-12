import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { cmpString } from "../../src/types/compare.ts";

// Issue #709: cmpString compared UTF-8 encodings. It now walks code units/points without
// allocating; this pins it to the old implementation, magnitude included, for every input.
const encoder = new TextEncoder();
const reference = (a: string, b: string): number => {
  if (a === b) return 0;
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i]! !== eb[i]!) return ea[i]! < eb[i]! ? -1 : 1;
  }
  return ea.length - eb.length;
};

const both = (a: string, b: string): void => {
  expect([a, b, cmpString(a, b)]).toEqual([a, b, reference(a, b)]);
  expect([b, a, cmpString(b, a)]).toEqual([b, a, reference(b, a)]);
};

// Units that stress the boundaries: ASCII, 2/3-byte BMP, U+E000..U+FFFF, both surrogate halves.
const unit = fc.constantFrom(
  "\u0000",
  "a",
  "b",
  "\u007f",
  "\u0080",
  "é",
  "߿",
  "ࠀ",
  "퟿",
  "\ud800",
  "\udbff",
  "\udc00",
  "\udfff",
  "",
  "",
  "�",
  "￿",
);
const tricky = fc
  .array(fc.oneof(unit, fc.constantFrom("\u{10000}", "😀", "\u{10ffff}")), { maxLength: 8 })
  .map((parts) => parts.join(""));

describe("cmpString (C-locale text order)", () => {
  test("hand-picked cases match the UTF-8 byte order", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["", "a"],
      ["abc", "abd"],
      ["abc", "abcd"],
      ["a", "B"],
      ["", "😀"],
      ["￿", "😀"],
      ["￿", "\u{10000}"],
      ["x", "x😀"],
      ["😀", "😀a"],
      ["😀", "😁"],
      ["é", "é"],
      // Lone surrogates encode as U+FFFD, so these differ as strings but tie as bytes.
      ["\ud800", "\udc00"],
      ["\ud800", "�"],
      ["\ud800", "𐀀"],
      ["\ud800a", "𐀀"],
      ["a\ud800", "a𐏿"],
      ["\udc00\ud800", "��"],
    ];
    for (const [a, b] of cases) both(a, b);
  });

  test("astral code points sort above U+E000..U+FFFF", () => {
    expect(cmpString("￿", "😀")).toBeLessThan(0);
    expect(cmpString("", "\u{10000}")).toBeLessThan(0);
    expect(cmpString("😀", "￿")).toBeGreaterThan(0);
  });

  test("random strings match the TextEncoder reference", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 12 }),
        fc.string({ unit: "binary", maxLength: 12 }),
        (a, b) => {
          both(a, b);
        },
      ),
      { numRuns: 5_000 },
    );
  });

  test("random strings over boundary code units (lone surrogates included) match the reference", () => {
    fc.assert(
      fc.property(tricky, tricky, (a, b) => {
        both(a, b);
        // A shared prefix forces the code-unit fast path before the difference.
        both(`pre${a}`, `pre${b}`);
      }),
      { numRuns: 10_000 },
    );
  });

  test("random UTF-16 code unit soup matches the reference", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary-ascii", maxLength: 6 }),
        fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)), maxLength: 6 }),
        (a, b) => {
          both(a, b);
          both(a + b, a);
        },
      ),
      { numRuns: 5_000 },
    );
  });
});
