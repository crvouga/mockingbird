/** Internal JSON value tree used by sqlite-mem JSON1/JSONB. */

export type JsonNode =
  | { kind: "null" }
  | { kind: "true" }
  | { kind: "false" }
  | { kind: "integer"; text: string }
  | { kind: "real"; text: string }
  | { kind: "string"; value: string }
  | { kind: "array"; elements: JsonNode[] }
  | { kind: "object"; entries: Array<{ key: string; value: JsonNode }> };

export type JsonTypeName = "null" | "true" | "false" | "integer" | "real" | "text" | "array" | "object";

export function jsonTypeName(node: JsonNode): JsonTypeName {
  switch (node.kind) {
    case "null":
      return "null";
    case "true":
      return "true";
    case "false":
      return "false";
    case "integer":
      return "integer";
    case "real":
      return "real";
    case "string":
      return "text";
    case "array":
      return "array";
    case "object":
      return "object";
  }
}

export function cloneJson(node: JsonNode): JsonNode {
  switch (node.kind) {
    case "array":
      return { kind: "array", elements: node.elements.map(cloneJson) };
    case "object":
      return {
        kind: "object",
        entries: node.entries.map((e) => ({ key: e.key, value: cloneJson(e.value) })),
      };
    case "integer":
    case "real":
      return { kind: node.kind, text: node.text };
    case "string":
      return { kind: "string", value: node.value };
    default:
      return { kind: node.kind };
  }
}
