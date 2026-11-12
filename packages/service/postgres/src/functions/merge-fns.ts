import { pgError } from "../errors/error.ts";
import type { ScalarFn } from "./util.ts";

/**
 * `merge_action()`: the MERGE executor binds it per RETURNING row (executor/returning.ts), so a call
 * that reaches evaluation is outside a MERGE RETURNING list.
 */
export function getMergeFunctions(): Map<string, ScalarFn> {
  return new Map<string, ScalarFn>([
    [
      "merge_action",
      () => {
        throw pgError("syntax", "MERGE_ACTION() can only be used in the RETURNING list of a MERGE command", "42601");
      },
    ],
  ]);
}
