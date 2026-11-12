import { pgError } from "../errors/error.ts";

/** In-memory placement supports the database default and the built-in heap AM. */
export function validateStorageSetting(name: string, value: string): void {
  if (
    (name === "default_table_access_method" && value !== "heap") ||
    (name === "default_tablespace" && value !== "" && value !== "pg_default")
  ) {
    throw pgError("invalid_parameter_value", `invalid value for parameter "${name}": "${value}"`, "22023");
  }
}

/**
 * `session_replication_role = replica`: triggers (foreign keys' own included) fire only when
 * enabled for replicas. The engine has no ALTER TABLE ... ENABLE REPLICA / ALWAYS TRIGGER, so every
 * trigger is an origin trigger and none fires.
 */
export function replicaRole(state: { getSetting(name: string): string | undefined }): boolean {
  return state.getSetting("session_replication_role") === "replica";
}
