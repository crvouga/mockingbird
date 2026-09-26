import { pgError } from "../errors/error.ts";

/** Internal invariant failure — not a user SQL error. */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw pgError("internal", message, "XX000");
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw pgError("internal", message, "XX000");
  }
  return value;
}

export function assertBounds(value: number, min: number, max: number, label: string): void {
  if (value < min || value > max) {
    throw pgError("internal", `${label} out of bounds: ${value} not in [${min}, ${max}]`, "XX000");
  }
}

export function assertNever(value: never, message = "unreachable"): never {
  throw pgError("internal", `${message}: ${String(value)}`, "XX000");
}
