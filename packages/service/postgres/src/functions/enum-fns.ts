import { pgError } from "../errors/error.ts";
import {
  arrayTypeOf,
  isEnumType,
  makeArray,
  type TypedValue,
  type TypeId,
  tv,
  typeDisplayName,
} from "../types/value.ts";
import type { ScalarFn } from "./util.ts";

/**
 * `enum_first`, `enum_last` and `enum_range` (https://www.postgresql.org/docs/18/functions-enum.html):
 * the labels of an enum type in sort order. The argument is only read for its type, so the usual call
 * is `enum_range(NULL::mood)`.
 */

/** The enum type of the first argument that has one; a NULL of unknown type next to an enum takes its type. */
function enumTypeOf(name: string, args: TypedValue[]): TypeId {
  const typed = args.find((a) => isEnumType(a.t));
  if (typed) return typed.t;
  throw pgError(
    "undefined_function",
    `function ${name}(${args.map((a) => typeDisplayName(a.t)).join(", ")}) does not exist`,
    "42883",
  );
}

export function getEnumFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();
  const bounds = (name: string, ctx: Parameters<ScalarFn>[0], args: TypedValue[]) => {
    const type = enumTypeOf(name, args);
    return { type, labels: ctx.requireEnum(type) };
  };
  m.set("enum_first", (ctx, args) => {
    const { type, labels } = bounds("enum_first", ctx, args);
    return tv(type, labels[0] ?? null);
  });
  m.set("enum_last", (ctx, args) => {
    const { type, labels } = bounds("enum_last", ctx, args);
    return tv(type, labels.at(-1) ?? null);
  });
  m.set("enum_range", (ctx, args) => {
    const { type, labels } = bounds("enum_range", ctx, args);
    // a NULL bound leaves that side open; a lower bound after the upper one is the empty range
    const at = (arg: TypedValue | undefined, open: number): number => {
      if (!arg || arg.v === null) return open;
      return labels.indexOf(arg.v as string);
    };
    const from = args.length === 2 ? at(args[0], 0) : 0;
    const to = args.length === 2 ? at(args[1], labels.length - 1) : labels.length - 1;
    const items = from > to ? [] : labels.slice(from, to + 1);
    return tv(arrayTypeOf(type), makeArray(type, items));
  });
  return m;
}
