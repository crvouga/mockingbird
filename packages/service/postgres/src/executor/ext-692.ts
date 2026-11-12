import type { Statement692 } from "../ast/nodes.ts";
import { executeCloseCursor, executeDeclareCursor, executeFetch } from "./cursors.ts";
import type { ExecEnv, ExecResult } from "./relation.ts";
import {
  executeAlterRole,
  executeCreateRole,
  executeDropRole,
  executeGrant,
  executeGrantRole,
  executeRoleUtility,
} from "./roles.ts";
import { executeAlterPolicy, executeCreatePolicy } from "./row-security.ts";
import { executeAlterCompositeType, executeCreateCompositeType } from "./composite.ts";
import { executeAlterEventTrigger, executeCreateEventTrigger } from "./event-triggers.ts";

/** Statements added for issue #692 (cursors, roles, policies, composite types, event triggers). */
export function dispatch692(env: ExecEnv, stmt: Statement692): ExecResult {
  switch (stmt.type) {
    case "declare_cursor":
      return executeDeclareCursor(env, stmt);
    case "fetch":
      return executeFetch(env, stmt);
    case "close_cursor":
      return executeCloseCursor(env, stmt);
    case "create_role":
      return executeCreateRole(env, stmt);
    case "alter_role":
      return executeAlterRole(env, stmt);
    case "drop_role":
      return executeDropRole(env, stmt);
    case "grant_role":
      return executeGrantRole(env, stmt);
    case "grant":
      return executeGrant(env, stmt);
    case "role_utility":
      return executeRoleUtility(env, stmt);
    case "create_policy":
      return executeCreatePolicy(env, stmt);
    case "alter_policy":
      return executeAlterPolicy(env, stmt);
    case "create_composite_type":
      return executeCreateCompositeType(env, stmt);
    case "alter_composite_type":
      return executeAlterCompositeType(env, stmt);
    case "create_event_trigger":
      return executeCreateEventTrigger(env, stmt);
    case "alter_event_trigger":
      return executeAlterEventTrigger(env, stmt);
  }
}
