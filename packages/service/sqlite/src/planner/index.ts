import type { Statement } from "../ast/nodes.ts";

export type Plan = Statement;

export function preparePlan(statement: Statement): Plan {
  return statement;
}
