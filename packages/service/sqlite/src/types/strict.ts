import { SqliteError } from "../errors/index.ts";
import { asSqlReal, coerceToNumber, isSqlReal, storageClassOf, type SqlValue, utf8Decode } from "./value.ts";

const STRICT_TYPES = new Set(["INT", "INTEGER", "REAL", "TEXT", "BLOB", "ANY"]);

export function isStrictTypeName(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return STRICT_TYPES.has(typeName.trim().toUpperCase());
}

export function applyStrictValue(value: SqlValue, typeName: string, table: string, column: string): SqlValue {
  if (value === null) return null;
  const declared = typeName.trim().toUpperCase();
  const storage = storageClassOf(value);
  if (declared === "ANY") return value;

  if (declared === "TEXT") {
    if (storage === "text") return typeof value === "string" ? value : String((value as { value: string }).value);
    if (storage === "integer" || storage === "real") return String(isSqlReal(value) ? value.value : value);
    throw cannotStore(storage, declared, table, column);
  }

  if (declared === "INT" || declared === "INTEGER") {
    if (storage === "integer") return value;
    if (storage === "real") {
      const n = isSqlReal(value) ? value.value : Number(value);
      if (Number.isInteger(n)) return n;
      throw cannotStore(storage, declared, table, column);
    }
    if (storage === "text") {
      const n = coerceToNumber(value);
      if (n !== null && Number.isInteger(n) && String(value).trim() === String(n)) return n;
      throw cannotStore(storage, declared, table, column);
    }
    throw cannotStore(storage, declared, table, column);
  }

  if (declared === "REAL") {
    if (storage === "real") return isSqlReal(value) ? value : asSqlReal(Number(value));
    if (storage === "integer") return asSqlReal(typeof value === "bigint" ? Number(value) : Number(value));
    if (storage === "text") {
      const n = coerceToNumber(value);
      if (n !== null) return asSqlReal(n);
    }
    throw cannotStore(storage, declared, table, column);
  }

  if (declared === "BLOB") {
    if (storage === "blob") return value;
    throw cannotStore(storage, declared, table, column);
  }

  throw new SqliteError(`unknown datatype for ${table}.${column}: "${typeName}"`, "other");
}

function cannotStore(storage: string, declared: string, table: string, column: string): never {
  const shown = storage === "integer" ? "INT" : storage.toUpperCase();
  throw new SqliteError(
    `cannot store ${shown} value in ${declared} column ${table}.${column}`,
    "datatype_mismatch",
    "SQLITE_CONSTRAINT_DATATYPE",
  );
}

export function unknownStrictType(table: string, column: string, typeName: string): never {
  throw new SqliteError(`unknown datatype for ${table}.${column}: "${typeName}"`, "other");
}

/** SQLite reports INT for the integer storage class in STRICT errors. */
export function strictStorageLabel(value: SqlValue): string {
  const storage = storageClassOf(value);
  if (storage === "integer") return "INT";
  if (storage === "text") return "TEXT";
  if (storage === "real") return "REAL";
  if (storage === "blob") return "BLOB";
  return "NULL";
}

void utf8Decode;
