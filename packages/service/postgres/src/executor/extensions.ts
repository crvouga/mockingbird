import type { CreateExtensionStmt, DropStmt } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { installFuzzystrmatch, uninstallFuzzystrmatch } from "../functions/fuzzystrmatch.ts";
import { installPgcrypto, uninstallPgcrypto } from "../functions/pgcrypto.ts";
import { installPgTrgm, uninstallPgTrgm } from "../functions/pgtrgm.ts";
import { installPgvector, PGVECTOR_OPCLASSES, uninstallPgvector } from "../functions/pgvector.ts";
import { type ExtensionSpec, extensionMembers, findExtensionSpec, installedExtension } from "../schema/extensions.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { typeDisplayName } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";
import { runStatement } from "./select.ts";

function installMembers(state: DatabaseState, spec: ExtensionSpec, schemaName: string): void {
  switch (spec.name) {
    case "pgcrypto":
      installPgcrypto(state, schemaName);
      return;
    case "pg_trgm":
      installPgTrgm(state, schemaName);
      return;
    case "fuzzystrmatch":
      installFuzzystrmatch(state, schemaName);
      return;
    case "vector":
      installPgvector(state, schemaName);
      return;
    default:
      throw unsupported(`CREATE EXTENSION ${spec.name}`);
  }
}

function uninstallMembers(state: DatabaseState, spec: ExtensionSpec): void {
  if (spec.name === "pgcrypto") uninstallPgcrypto(state);
  else if (spec.name === "pg_trgm") uninstallPgTrgm(state);
  else if (spec.name === "fuzzystrmatch") uninstallFuzzystrmatch(state);
  else if (spec.name === "vector") uninstallPgvector(state);
}

export function executeCreateExtension(env: ExecEnv, stmt: CreateExtensionStmt): ExecResult {
  const state = env.ctx.state;
  const spec = findExtensionSpec(stmt.name);
  if (spec && installedExtension(state, spec)) {
    if (stmt.ifNotExists) return commandResult("CREATE EXTENSION", 0);
    throw pgError("duplicate_object", `extension "${stmt.name}" already exists`, "42710");
  }
  if (!spec) {
    throw pgError("feature_not_supported", `extension "${stmt.name}" is not available`, "0A000");
  }
  const version = stmt.version ?? spec.defaultVersion;
  if (!spec.versions.includes(version)) {
    throw pgError(
      "invalid_parameter_value",
      `extension "${spec.name}" has no installation script nor update path for version "${version}"`,
      "22023",
    );
  }
  const schema = state.getSchema(stmt.schema ?? state.currentSchema());
  installMembers(state, spec, schema.name);
  if (version !== spec.defaultVersion) {
    for (const member of extensionMembers(state, spec.name)) member.extensionVersion = version;
  }
  return commandResult("CREATE EXTENSION", 0);
}

/** A function an extension installed goes away with the extension, not on its own. */
export function assertNotExtensionMember(fn: FunctionData): void {
  if (fn.language !== "internal" || fn.rawBody === null || !findExtensionSpec(fn.rawBody)) return;
  const signature = `${fn.name}(${fn.argTypes.map(typeDisplayName).join(",")})`;
  throw pgError(
    "dependent_objects",
    `cannot drop function ${signature} because extension ${fn.rawBody} requires it`,
    "2BP01",
  );
}

/** Operators and operator classes an extension adds besides its functions. */
// (pg_trgm's `%` and `<->` are left out: the same tokens are integer modulo and geometric distance)
const EXTENSION_OPERATORS: Readonly<Record<string, readonly string[]>> = {
  pg_trgm: ["<%", "%>", "<<%", "%>>", "<<->", "<->>", "<<<->", "<->>>"],
};
const EXTENSION_OPCLASSES: Readonly<Record<string, readonly string[]>> = {
  pg_trgm: ["gin_trgm_ops"],
  vector: PGVECTOR_OPCLASSES,
};

/** Types an extension adds: a column of one goes with the extension (DROP EXTENSION ... CASCADE). */
const EXTENSION_TYPES: Readonly<Record<string, readonly string[]>> = { vector: ["vector", "vector[]"] };

/**
 * Objects that use an extension's functions, operators or operator classes:
 * column defaults, generated columns, CHECK constraints, views and indexes.
 * Each entry removes its object, which is what DROP EXTENSION ... CASCADE does.
 * (Like PostgreSQL, a function whose body is a string is not a dependent.)
 */
function extensionDependents(env: ExecEnv, spec: ExtensionSpec): Array<() => void> {
  const state = env.ctx.state;
  const functions = new Set(extensionMembers(state, spec.name).map((fn) => fn.name));
  const operators = EXTENSION_OPERATORS[spec.name] ?? [];
  const opclasses = EXTENSION_OPCLASSES[spec.name] ?? [];
  const types = EXTENSION_TYPES[spec.name] ?? [];
  const uses = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(uses);
    if (node === null || typeof node !== "object") return false;
    const expr = node as { type?: unknown; name?: unknown; op?: unknown };
    if (expr.type === "func" && Array.isArray(expr.name) && functions.has(String(expr.name[expr.name.length - 1]))) {
      return true;
    }
    if (expr.type === "binop" && typeof expr.op === "string" && operators.includes(expr.op)) return true;
    return Object.values(node).some(uses);
  };
  const drops: Array<() => void> = [];
  for (const schema of state.schemas.values()) {
    for (const index of schema.indexes.values()) {
      const viaOpclass = index.columns.some((c) => opclasses.includes(c.opclass?.[c.opclass.length - 1] ?? ""));
      if (!viaOpclass && !uses(index.where) && !index.columns.some((c) => uses(c.expr))) continue;
      drops.push(() => {
        schema.indexes.delete(index.name);
        const indexed = schema.tables.get(index.table);
        if (indexed) indexed.indexStores = null;
      });
    }
    for (const view of schema.views.values()) {
      if (uses(view.query)) drops.push(() => schema.views.delete(view.name));
    }
    for (const table of schema.tables.values()) {
      const writable = () => state.ensureWritableTable(schema.tables.get(table.name) ?? table);
      for (const column of table.columns) {
        if (types.includes(column.type.id) || uses(column.generated)) {
          drops.push(() => {
            runStatement(env, {
              type: "alter_table",
              table: [table.schema, table.name],
              ifExists: false,
              only: false,
              actions: [{ kind: "drop_column", name: column.name, ifExists: true, cascade: true }],
            });
          });
        } else if (uses(column.defaultExpr)) {
          drops.push(() => {
            const target = writable().columns.find((c) => c.name === column.name);
            if (target) target.defaultExpr = null;
          });
        }
      }
      for (const constraint of table.constraints) {
        if (constraint.kind !== "check" || !uses(constraint.expr)) continue;
        drops.push(() => {
          const target = writable();
          target.constraints = target.constraints.filter((c) => c.name !== constraint.name);
        });
      }
    }
  }
  return drops;
}

/**
 * `DROP EXTENSION [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`: every name
 * is resolved, and every dependency checked, before anything is dropped.
 */
export function executeDropExtension(env: ExecEnv, stmt: DropStmt): ExecResult {
  const state = env.ctx.state;
  const targets: ExtensionSpec[] = [];
  for (const parts of stmt.names) {
    const name = parts[parts.length - 1]!;
    const spec = findExtensionSpec(name);
    if (spec && installedExtension(state, spec)) {
      // plpgsql is part of every database here: dropping it would have to remove the language itself.
      if (spec.builtinSchema !== undefined) throw unsupported(`DROP EXTENSION ${spec.name}`);
      targets.push(spec);
      continue;
    }
    if (stmt.ifExists) continue;
    throw pgError("undefined_object", `extension "${name}" does not exist`, "42704");
  }
  const dependents = targets.map((spec) => ({ spec, drops: extensionDependents(env, spec) }));
  if (!stmt.cascade) {
    const blocked = dependents.find((entry) => entry.drops.length > 0);
    if (blocked) {
      throw pgError(
        "dependent_objects",
        `cannot drop extension ${blocked.spec.name} because other objects depend on it`,
        "2BP01",
      );
    }
  }
  for (const { spec, drops } of dependents) {
    for (const drop of drops) drop();
    uninstallMembers(state, spec);
  }
  return commandResult("DROP EXTENSION", 0);
}
