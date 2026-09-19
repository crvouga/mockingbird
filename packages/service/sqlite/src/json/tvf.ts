import type { SqlValue } from "../types/value.ts";
import { encodeJsonb, type JsonbWalkEntry, walkJsonbTree } from "./jsonb.ts";
import { ensureJson, jsonNodeToSql } from "./ops.ts";
import { stringifyJson } from "./stringify.ts";
import { type JsonNode, jsonTypeName } from "./types.ts";

export interface JsonTvfRow {
  key: SqlValue;
  value: SqlValue;
  type: string;
  atom: SqlValue;
  id: number;
  parent: SqlValue;
  fullkey: string;
  path: string;
}

function atomOf(node: JsonNode): SqlValue {
  switch (node.kind) {
    case "null":
      return null;
    case "true":
      return 1;
    case "false":
      return 0;
    case "integer":
    case "real":
    case "string":
      return jsonNodeToSql(node, "sql");
    default:
      return null;
  }
}

function valueOf(node: JsonNode): SqlValue {
  if (node.kind === "array" || node.kind === "object") return stringifyJson(node);
  return jsonNodeToSql(node, "sql");
}

export function jsonEachRows(json: SqlValue, path?: SqlValue): JsonTvfRow[] {
  // SQL NULL → zero rows (distinct from JSON null, which yields one atom row).
  if (json === null) return [];
  const root = ensureJson(json);
  const blob = encodeJsonb(root);
  const walk = walkJsonbTree(blob);
  const rootEntry = walk[0];
  if (!rootEntry) return [];

  let focus = rootEntry;
  if (path !== undefined && path !== null) {
    const targetPath = String(path);
    const found = walk.find((e) => e.fullkey === targetPath);
    if (!found) return [];
    focus = found;
  }

  if (focus.node.kind !== "array" && focus.node.kind !== "object") {
    return [
      {
        key: focus.key,
        value: valueOf(focus.node),
        type: jsonTypeName(focus.node),
        atom: atomOf(focus.node),
        id: focus.idOffset,
        parent: null,
        fullkey: focus.fullkey,
        path: focus.path,
      },
    ];
  }

  return walk.filter((e) => e.parent === focus.idOffset).map((e) => rowFromWalk(e, true));
}

export function jsonTreeRows(json: SqlValue, path?: SqlValue): JsonTvfRow[] {
  if (json === null) return [];
  const root = ensureJson(json);
  const blob = encodeJsonb(root);
  const walk = walkJsonbTree(blob);

  if (path === undefined || path === null) {
    return walk.map((e) => rowFromWalk(e, false));
  }

  const targetPath = String(path);
  // Keep IDs from the full document; return the subtree rooted at targetPath.
  const rootEntry = walk.find((e) => e.fullkey === targetPath);
  if (!rootEntry) return [];
  const subtree = walk.filter(
    (e) => e.fullkey === targetPath || e.fullkey.startsWith(targetPath + ".") || e.fullkey.startsWith(targetPath + "["),
  );
  return subtree.map((e) => {
    const row = rowFromWalk(e, false);
    if (e.idOffset === rootEntry.idOffset) {
      row.parent = null;
    }
    return row;
  });
}

function rowFromWalk(e: JsonbWalkEntry, eachMode: boolean): JsonTvfRow {
  return {
    key: e.key,
    value: valueOf(e.node),
    type: jsonTypeName(e.node),
    atom: atomOf(e.node),
    id: e.idOffset,
    parent: eachMode ? null : e.parent,
    fullkey: e.fullkey,
    path: e.path,
  };
}
