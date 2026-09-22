import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { TypedValue } from "../types/value.ts";
import { getArrayFunctions } from "./array-fns.ts";
import { getDatetimeFunctions } from "./datetime-registry.ts";
import { getJsonFunctions } from "./json-fns.ts";
import { getMathFunctions } from "./math-fns.ts";
import { getMiscFunctions } from "./misc-fns.ts";
import { getStringFunctions } from "./string-fns.ts";
import { getTsearchFunctions } from "./tsearch-fns.ts";
import type { ScalarFn } from "./util.ts";

let REGISTRY: Map<string, ScalarFn> | null = null;

/**
 * All engine scalar builtins keyed by lowercase name. Built lazily once;
 * the inventory gate walks this map against the oracle's pg_proc.
 */
export function getScalarFunctions(): Map<string, ScalarFn> {
  if (REGISTRY) return REGISTRY;
  const registry = new Map<string, ScalarFn>();
  for (const source of [
    getStringFunctions(),
    getMathFunctions(),
    getDatetimeFunctions(),
    getJsonFunctions(),
    getArrayFunctions(),
    getTsearchFunctions(),
    getMiscFunctions(),
  ]) {
    for (const [name, fn] of source) {
      registry.set(name, fn);
    }
  }
  // `length(tsvector)` overload: dispatch by arg type over the string version
  const stringLength = registry.get("length")!;
  const tsvectorLength = registry.get("tsvector_length")!;
  registry.set("length", (ctx, args) => {
    if (args[0] !== undefined && args[0].t === "tsvector") return tsvectorLength(ctx, args);
    return stringLength(ctx, args);
  });
  REGISTRY = registry;
  return registry;
}

export function hasScalarFunction(name: string): boolean {
  return getScalarFunctions().has(name);
}

export function callScalarFunction(ctx: EngineCtx, name: string, args: TypedValue[]): TypedValue {
  const fn = getScalarFunctions().get(name);
  if (!fn) {
    throw pgError("undefined_function", `function ${name}(${args.map((a) => a.t).join(", ")}) does not exist`, "42883");
  }
  return fn(ctx, args);
}
