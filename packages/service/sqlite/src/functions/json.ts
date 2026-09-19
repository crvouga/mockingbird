import { SqliteError } from "../errors/index.ts";
import {
  arrayInsertJson,
  ensureJson,
  extractOne,
  isValidJsonText,
  jsonArrowPath,
  jsonErrorPosition,
  jsonNodeToSql,
  mutateJson,
  patchJson,
  prettyJson,
  removeJson,
  sqlValueToJsonNode,
  stringifyJson,
  toJsonbBlob,
  toJsonText,
  wrapJsonError,
} from "../json/index.ts";
import { decodeJsonb, looksLikeJsonb } from "../json/jsonb.ts";
import { jsonTypeName } from "../json/types.ts";
import { asSqlJsonText, isSqlJsonText, type SqlValue, subtypeOf, utf8Decode } from "../types/value.ts";
import type { AggregateAccumulator, AggregateFactory } from "./aggregate.ts";
import type { ScalarFunction } from "./registry.ts";

function textOf(value: SqlValue): string {
  if (value instanceof Uint8Array) return utf8Decode(value);
  if (isSqlJsonText(value)) return value.value;
  return String(value);
}

function _requireOdd(name: string, args: SqlValue[]): void {
  if (args.length % 2 === 0) {
    throw new SqliteError(`json_${name}() requires an odd number of arguments`, "misuse");
  }
}

function arrayInsertArgs(args: SqlValue[], asJsonb: boolean): SqlValue {
  if (args.length === 0) {
    throw new SqliteError("wrong number of arguments to function json_array_insert()", "misuse");
  }
  if (args.length % 2 === 0) {
    throw new SqliteError("json_array_insert() requires an odd number of arguments", "misuse");
  }
  if (args.some((arg) => arg === null)) return null;
  try {
    let node = ensureJson(args[0]!);
    for (let i = 1; i < args.length; i += 2) {
      const path = textOf(args[i]!);
      const value = sqlValueToJsonNode(args[i + 1]!);
      node = arrayInsertJson(node, path, value);
    }
    return asJsonb ? jsonNodeToSql(node, "jsonb") : jsonNodeToSql(node, "json");
  } catch (e) {
    wrapJsonError(e);
  }
}

function mutateArgs(args: SqlValue[], mode: "insert" | "replace" | "set", asJsonb: boolean): SqlValue {
  if (args.length === 0) throw new SqliteError(`wrong number of arguments to function json_${mode}()`, "misuse");
  if (args.length % 2 === 0) {
    throw new SqliteError(`json_${mode}() requires an odd number of arguments`, "misuse");
  }
  try {
    let node = ensureJson(args[0]!);
    for (let i = 1; i < args.length; i += 2) {
      const path = textOf(args[i]!);
      const value = sqlValueToJsonNode(args[i + 1]!);
      node = mutateJson(node, path, value, mode);
    }
    return asJsonb ? jsonNodeToSql(node, "jsonb") : jsonNodeToSql(node, "json");
  } catch (e) {
    wrapJsonError(e);
  }
}

function extract(args: SqlValue[], asJsonb: boolean): SqlValue {
  if (args.length < 2) throw new SqliteError("wrong number of arguments to function json_extract()", "misuse");
  try {
    const root = ensureJson(args[0]!);
    if (args.length === 2) {
      const found = extractOne(root, textOf(args[1]!));
      if (found === undefined) return null;
      if (asJsonb && (found.kind === "array" || found.kind === "object")) {
        return jsonNodeToSql(found, "jsonb");
      }
      if (found.kind === "array" || found.kind === "object") return jsonNodeToSql(found, "json");
      return jsonNodeToSql(found, "sql");
    }
    const parts = args.slice(1).map((p) => {
      const found = extractOne(root, textOf(p!));
      return found === undefined ? { kind: "null" as const } : found;
    });
    const arr = { kind: "array" as const, elements: parts };
    return asJsonb ? jsonNodeToSql(arr, "jsonb") : jsonNodeToSql(arr, "json");
  } catch (e) {
    wrapJsonError(e);
  }
}

export function jsonArrow(left: SqlValue, right: SqlValue, mode: "->" | "->>"): SqlValue {
  if (left === null || right === null) return null;
  try {
    const root = ensureJson(left);
    const path = jsonArrowPath(right);
    const found = extractOne(root, path);
    if (found === undefined) return null;
    if (mode === "->") return asSqlJsonText(stringifyJson(found));
    return jsonNodeToSql(found, "sql");
  } catch (e) {
    // -> on malformed JSON errors
    wrapJsonError(e);
  }
}

export const jsonScalarFunctions: Readonly<Record<string, ScalarFunction>> = {
  json(args) {
    if (args.length !== 1) throw new SqliteError("wrong number of arguments to function json()", "misuse");
    if (args[0] === null) return null;
    return toJsonText(args[0]!);
  },
  jsonb(args) {
    if (args.length !== 1) throw new SqliteError("wrong number of arguments to function jsonb()", "misuse");
    if (args[0] === null) return null;
    return toJsonbBlob(args[0]!);
  },
  json_array(args) {
    try {
      const elements = args.map((a) => sqlValueToJsonNode(a));
      return jsonNodeToSql({ kind: "array", elements }, "json");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  jsonb_array(args) {
    try {
      const elements = args.map((a) => sqlValueToJsonNode(a));
      return jsonNodeToSql({ kind: "array", elements }, "jsonb");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_object(args) {
    if (args.length % 2 !== 0) {
      throw new SqliteError("json_object() requires an even number of arguments", "misuse");
    }
    try {
      const entries: Array<{ key: string; value: import("../json/types.ts").JsonNode }> = [];
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] === null) throw new SqliteError("json_object() labels must be TEXT", "other");
        if (args[i] instanceof Uint8Array) throw new SqliteError("JSON cannot hold BLOB values", "other");
        const key = textOf(args[i]!);
        entries.push({ key, value: sqlValueToJsonNode(args[i + 1]!) });
      }
      return jsonNodeToSql({ kind: "object", entries }, "json");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  jsonb_object(args) {
    if (args.length % 2 !== 0) {
      throw new SqliteError("json_object() requires an even number of arguments", "misuse");
    }
    try {
      const entries: Array<{ key: string; value: import("../json/types.ts").JsonNode }> = [];
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] === null) throw new SqliteError("json_object() labels must be TEXT", "other");
        if (args[i] instanceof Uint8Array) throw new SqliteError("JSON cannot hold BLOB values", "other");
        const key = textOf(args[i]!);
        entries.push({ key, value: sqlValueToJsonNode(args[i + 1]!) });
      }
      return jsonNodeToSql({ kind: "object", entries }, "jsonb");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_quote(args) {
    if (args.length !== 1) throw new SqliteError("wrong number of arguments to function json_quote()", "misuse");
    const v = args[0] ?? null;
    if (v === null) return asSqlJsonText("null");
    if (isSqlJsonText(v)) return v;
    if (v instanceof Uint8Array && looksLikeJsonb(v)) return asSqlJsonText(stringifyJson(decodeJsonb(v)));
    try {
      return asSqlJsonText(stringifyJson(sqlValueToJsonNode(v)));
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_extract(args) {
    return extract(args, false);
  },
  jsonb_extract(args) {
    return extract(args, true);
  },
  json_insert(args) {
    return mutateArgs(args, "insert", false);
  },
  jsonb_insert(args) {
    return mutateArgs(args, "insert", true);
  },
  json_array_insert(args) {
    return arrayInsertArgs(args, false);
  },
  jsonb_array_insert(args) {
    return arrayInsertArgs(args, true);
  },
  json_replace(args) {
    return mutateArgs(args, "replace", false);
  },
  jsonb_replace(args) {
    return mutateArgs(args, "replace", true);
  },
  json_set(args) {
    return mutateArgs(args, "set", false);
  },
  jsonb_set(args) {
    return mutateArgs(args, "set", true);
  },
  json_remove(args) {
    if (args.length < 1) throw new SqliteError("wrong number of arguments to function json_remove()", "misuse");
    try {
      let node = ensureJson(args[0]!);
      for (let i = 1; i < args.length; i++) {
        node = removeJson(node, textOf(args[i]!));
      }
      return jsonNodeToSql(node, "json");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  jsonb_remove(args) {
    if (args.length < 1) throw new SqliteError("wrong number of arguments to function jsonb_remove()", "misuse");
    try {
      let node = ensureJson(args[0]!);
      for (let i = 1; i < args.length; i++) {
        node = removeJson(node, textOf(args[i]!));
      }
      return jsonNodeToSql(node, "jsonb");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_patch(args) {
    if (args.length !== 2) throw new SqliteError("wrong number of arguments to function json_patch()", "misuse");
    try {
      return jsonNodeToSql(patchJson(ensureJson(args[0]!), ensureJson(args[1]!)), "json");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  jsonb_patch(args) {
    if (args.length !== 2) throw new SqliteError("wrong number of arguments to function jsonb_patch()", "misuse");
    try {
      return jsonNodeToSql(patchJson(ensureJson(args[0]!), ensureJson(args[1]!)), "jsonb");
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_type(args) {
    if (args.length < 1 || args.length > 2) {
      throw new SqliteError("wrong number of arguments to function json_type()", "misuse");
    }
    if (args[0] === null) return null;
    try {
      let node = ensureJson(args[0]!);
      if (args.length === 2) {
        if (args[1] === null) return null;
        const found = extractOne(node, textOf(args[1]!));
        if (!found) return null;
        node = found;
      }
      return jsonTypeName(node);
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_valid(args) {
    if (args.length < 1 || args.length > 2) {
      throw new SqliteError("wrong number of arguments to function json_valid()", "misuse");
    }
    if (args[0] === null) return 0;
    const flags = args.length === 2 && args[1] !== null ? Number(args[1]) : 0;
    if (args[0] instanceof Uint8Array) {
      return looksLikeJsonb(args[0]) ? 1 : 0;
    }
    return isValidJsonText(textOf(args[0]!), flags) ? 1 : 0;
  },
  json_error_position(args) {
    if (args.length !== 1) {
      throw new SqliteError("wrong number of arguments to function json_error_position()", "misuse");
    }
    if (args[0] === null) return 0;
    if (args[0] instanceof Uint8Array) {
      return looksLikeJsonb(args[0]) ? 0 : 1;
    }
    return jsonErrorPosition(textOf(args[0]!));
  },
  json_array_length(args) {
    if (args.length < 1 || args.length > 2) {
      throw new SqliteError("wrong number of arguments to function json_array_length()", "misuse");
    }
    if (args[0] === null) return null;
    try {
      let node = ensureJson(args[0]!);
      if (args.length === 2) {
        if (args[1] === null) return null;
        const found = extractOne(node, textOf(args[1]!));
        if (!found) return null;
        node = found;
      }
      if (node.kind !== "array") return 0;
      return node.elements.length;
    } catch (e) {
      wrapJsonError(e);
    }
  },
  json_pretty(args) {
    if (args.length < 1 || args.length > 2) {
      throw new SqliteError("wrong number of arguments to function json_pretty()", "misuse");
    }
    if (args[0] === null) return null;
    try {
      const node = ensureJson(args[0]!);
      const indent = args.length === 2 && args[1] !== null ? textOf(args[1]!) : "    ";
      return asSqlJsonText(prettyJson(node, indent));
    } catch (e) {
      wrapJsonError(e);
    }
  },
  subtype(args) {
    if (args.length !== 1) throw new SqliteError("wrong number of arguments to function subtype()", "misuse");
    return subtypeOf(args[0] ?? null);
  },
};

class JsonGroupArrayAccumulator implements AggregateAccumulator {
  private readonly values: import("../json/types.ts").JsonNode[] = [];
  constructor(private readonly asJsonb: boolean) {}
  step(args: SqlValue[]): void {
    if (args[0] === undefined) return;
    // NULLs are included as JSON null in json_group_array
    this.values.push(sqlValueToJsonNode(args[0]!));
  }
  finalize(): SqlValue {
    const node = { kind: "array" as const, elements: this.values };
    return this.asJsonb ? jsonNodeToSql(node, "jsonb") : jsonNodeToSql(node, "json");
  }
}

class JsonGroupObjectAccumulator implements AggregateAccumulator {
  private readonly entries: Array<{ key: string; value: import("../json/types.ts").JsonNode }> = [];
  constructor(private readonly asJsonb: boolean) {}
  step(args: SqlValue[]): void {
    if (args[0] === null || args[0] === undefined) return;
    const key = textOf(args[0]!);
    this.entries.push({ key, value: sqlValueToJsonNode(args[1] ?? null) });
  }
  finalize(): SqlValue {
    const node = { kind: "object" as const, entries: this.entries };
    return this.asJsonb ? jsonNodeToSql(node, "jsonb") : jsonNodeToSql(node, "json");
  }
}

export const jsonAggregateFunctions: Readonly<Record<string, AggregateFactory>> = {
  json_group_array: () => new JsonGroupArrayAccumulator(false),
  jsonb_group_array: () => new JsonGroupArrayAccumulator(true),
  json_group_object: () => new JsonGroupObjectAccumulator(false),
  jsonb_group_object: () => new JsonGroupObjectAccumulator(true),
};
