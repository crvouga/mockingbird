import { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { executeDrop, executeTruncate } from "./ddl.ts";
import type { ExecEnv } from "./relation.ts";

/**
 * PreCommit_on_commit_actions: at commit (an explicit COMMIT, or the end of an autocommit
 * statement) drop the temporary tables created `ON COMMIT DROP` and empty those created
 * `ON COMMIT DELETE ROWS`.
 */
export function runOnCommitActions(state: DatabaseState): void {
  if (!state.mayHaveOnCommitActions) return;
  let drop: string[][] | null = null;
  let truncate: string[][] | null = null;
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) {
      if (!table.temp || table.onCommit === null) continue;
      if (table.onCommit === "drop") (drop ??= []).push([table.schema, table.name]);
      else if (table.rowCount() > 0) (truncate ??= []).push([table.schema, table.name]);
    }
  }
  if (!drop && !truncate) return;
  const env: ExecEnv = { ctx: new EngineCtx(state), params: [], ctes: new Map(), outer: null };
  if (truncate) executeTruncate(env, { type: "truncate", tables: truncate, restartIdentity: false, cascade: false });
  if (drop) {
    executeDrop(env, {
      type: "drop",
      kind: "table",
      names: drop,
      onTable: null,
      funcArgs: null,
      ifExists: true,
      cascade: true,
    });
  }
}
