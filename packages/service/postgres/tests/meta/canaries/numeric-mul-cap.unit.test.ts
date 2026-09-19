import { expect, test } from "bun:test";
import { numericMul, parseNumeric } from "../../../src/types/numeric.ts";

test("numericMul caps display scale at MAX_DISPLAY_SCALE", () => {
  const a = parseNumeric(`0.${"1".repeat(600)}`);
  const b = parseNumeric(`0.${"1".repeat(600)}`);
  const product = numericMul(a, b);
  expect(product.dscale).toBeLessThanOrEqual(1000);
  expect(product.special).toBeNull();
});
