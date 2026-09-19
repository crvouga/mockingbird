import type { JsonNode } from "./types.ts";

export function stringifyJson(node: JsonNode): string {
  switch (node.kind) {
    case "null":
      return "null";
    case "true":
      return "true";
    case "false":
      return "false";
    case "integer":
    case "real":
      return node.text;
    case "string":
      return jsonQuoteString(node.value);
    case "array":
      return `[${node.elements.map(stringifyJson).join(",")}]`;
    case "object":
      return `{${node.entries.map((e) => `${jsonQuoteString(e.key)}:${stringifyJson(e.value)}`).join(",")}}`;
  }
}

export function jsonQuoteString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
    }
  }
  return `${out}"`;
}

export function prettyJson(node: JsonNode, indent = "    "): string {
  return prettyNode(node, indent, 0);
}

function prettyNode(node: JsonNode, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  const padInner = indent.repeat(depth + 1);
  switch (node.kind) {
    case "array":
      if (node.elements.length === 0) return "[]";
      return `[\n${node.elements.map((e) => `${padInner}${prettyNode(e, indent, depth + 1)}`).join(",\n")}\n${pad}]`;
    case "object":
      if (node.entries.length === 0) return "{}";
      return `{\n${node.entries
        .map((e) => `${padInner}${jsonQuoteString(e.key)}: ${prettyNode(e.value, indent, depth + 1)}`)
        .join(",\n")}\n${pad}}`;
    default:
      return stringifyJson(node);
  }
}
