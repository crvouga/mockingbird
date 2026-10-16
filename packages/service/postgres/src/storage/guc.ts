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
