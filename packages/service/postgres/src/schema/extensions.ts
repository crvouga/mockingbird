import type { DatabaseState, FunctionData } from "../storage/database-state.ts";

/**
 * Extensions this engine can install, as `pg_available_extensions` lists
 * them. An extension belongs here only when `CREATE EXTENSION` really
 * installs something: everything else stays unavailable and fails loud.
 * Versions and comments are the ones PostgreSQL 18 ships in each control file.
 */
export interface ExtensionSpec {
  readonly name: string;
  readonly defaultVersion: string;
  /** every version PostgreSQL has an installation script or update path for */
  readonly versions: readonly string[];
  readonly comment: string;
  readonly relocatable: boolean;
  /** false when only a superuser may install it (the control file says `trusted = false`, the default) */
  readonly trusted?: boolean;
  /** set for an extension that is part of every database and lives in a fixed schema */
  readonly builtinSchema?: string;
}

export const AVAILABLE_EXTENSIONS: readonly ExtensionSpec[] = [
  {
    name: "fuzzystrmatch",
    defaultVersion: "1.2",
    versions: ["1.1", "1.2"],
    comment: "determine similarities and distance between strings",
    relocatable: true,
  },
  {
    name: "pg_trgm",
    defaultVersion: "1.6",
    versions: ["1.3", "1.4", "1.5", "1.6"],
    comment: "text similarity measurement and index searching based on trigrams",
    relocatable: true,
  },
  {
    name: "pgcrypto",
    defaultVersion: "1.4",
    versions: ["1.3", "1.4"],
    comment: "cryptographic functions",
    relocatable: true,
  },
  {
    name: "uuid-ossp",
    defaultVersion: "1.1",
    versions: ["1.1"],
    comment: "generate universally unique identifiers (UUIDs)",
    relocatable: true,
  },
  {
    name: "plpgsql",
    defaultVersion: "1.0",
    versions: ["1.0"],
    comment: "PL/pgSQL procedural language",
    relocatable: false,
    builtinSchema: "pg_catalog",
  },
  {
    name: "vector",
    defaultVersion: "0.8.1",
    versions: ["0.8.1"],
    comment: "vector data type and ivfflat and hnsw access methods",
    relocatable: true,
    trusted: false,
  },
];

/** Stable pseudo-oid for the built-in `plpgsql` row of `pg_extension` (below the first user oid). */
const PLPGSQL_EXTENSION_OID = 13563;

export interface InstalledExtension {
  readonly spec: ExtensionSpec;
  readonly version: string;
  readonly schema: string;
  readonly oid: number;
}

export function findExtensionSpec(name: string): ExtensionSpec | null {
  return AVAILABLE_EXTENSIONS.find((spec) => spec.name === name) ?? null;
}

/**
 * Functions an installed extension owns. `CREATE EXTENSION` marks them with
 * `language = internal` and the extension name as the body, which is what a
 * PGMM snapshot carries, so installation state needs no catalog of its own.
 */
export function extensionMembers(state: DatabaseState, name: string): FunctionData[] {
  const members: FunctionData[] = [];
  for (const schema of state.schemas.values()) {
    for (const overloads of schema.functions.values()) {
      for (const fn of overloads) {
        if (fn.language === "internal" && fn.rawBody === name) members.push(fn);
      }
    }
  }
  return members.sort((a, b) => a.oid - b.oid);
}

export function installedExtension(state: DatabaseState, spec: ExtensionSpec): InstalledExtension | null {
  if (spec.builtinSchema !== undefined) {
    return { spec, version: spec.defaultVersion, schema: spec.builtinSchema, oid: PLPGSQL_EXTENSION_OID };
  }
  const first = extensionMembers(state, spec.name)[0];
  if (!first) return null;
  return { spec, version: first.extensionVersion ?? spec.defaultVersion, schema: first.schema, oid: first.oid };
}

export function installedExtensions(state: DatabaseState): InstalledExtension[] {
  const installed: InstalledExtension[] = [];
  for (const spec of AVAILABLE_EXTENSIONS) {
    const entry = installedExtension(state, spec);
    if (entry) installed.push(entry);
  }
  return installed;
}
