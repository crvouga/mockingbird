import { isPostgresError } from "../errors/error.ts";
import { tokenize, type Token } from "../lexer/tokenize.ts";
import { parse } from "../parser/index.ts";
import { Database } from "./database.ts";

declare const MOCKINGBIRD_POSTGRES_VERSION: string | undefined;

export interface SchemaReportOptions {
  /** Hard upper bounds are 4 MiB, 10,000 statements and 1,000 diagnostics. */
  maxInputBytes?: number;
  maxStatements?: number;
  maxDiagnostics?: number;
}

export interface SchemaDiagnostic {
  statement: number;
  offset: number;
  line: number;
  column: number;
  object?: string;
  sqlstate: string | null;
  category: "unsupported" | "syntax" | "prerequisite" | "execution" | "unknown" | "limit";
  message: string;
  prerequisiteStatement?: number;
}

export interface SchemaReport {
  /** Identifies the local implementation; this is not a live PostgreSQL compatibility assertion. */
  engine: "mockingbird-postgres";
  version: string;
  statements: number;
  accepted: number;
  /** false means a detected gap; null means semantics still require oracle verification. */
  compatible: false | null;
  truncated: boolean;
  diagnostics: SchemaDiagnostic[];
}

const bounded = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError(`limit must be an integer between 1 and ${max}`);
  return value;
};

/** Analyze plain schema SQL in a discarded in-memory database, without network or filesystem access.
 * Successful execution is explicitly unverified: function bodies and dynamic SQL are not proved.
 */
export function analyzeSchema(sql: string, options: SchemaReportOptions = {}): SchemaReport {
  const inputLimit = bounded(options.maxInputBytes, 1024 * 1024, 4 * 1024 * 1024);
  const statementLimit = bounded(options.maxStatements, 1000, 10000);
  const diagnosticLimit = bounded(options.maxDiagnostics, 100, 1000);
  const report: SchemaReport = {
    engine: "mockingbird-postgres",
    version: typeof MOCKINGBIRD_POSTGRES_VERSION === "string" ? MOCKINGBIRD_POSTGRES_VERSION : "source-tree",
    statements: 0,
    accepted: 0,
    compatible: null,
    truncated: false,
    diagnostics: [],
  };
  const add = (diagnostic: SchemaDiagnostic): boolean => {
    if (report.diagnostics.length >= diagnosticLimit) {
      report.truncated = true;
      return false;
    }
    report.diagnostics.push({
      ...diagnostic,
      ...(diagnostic.object ? { object: diagnostic.object.slice(0, 200) } : {}),
    });
    if (diagnostic.category !== "unknown") report.compatible = false;
    return true;
  };
  const location = (offset: number) => {
    const prefix = sql.slice(0, offset);
    return { offset, line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
  };
  if (sql.length > inputLimit || new TextEncoder().encode(sql).length > inputLimit) {
    add({
      statement: 0,
      ...location(0),
      sqlstate: null,
      category: "limit",
      message: `Input exceeds ${inputLimit} bytes`,
    });
    report.truncated = true;
    return report;
  }
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (error) {
    add({
      statement: 1,
      ...location(0),
      sqlstate: isPostgresError(error) ? error.code : null,
      category: "syntax",
      message: error instanceof Error ? error.message.slice(0, 500) : "Cannot tokenize input",
    });
    return report;
  }
  const db = new Database();
  const failed = new Map<string, number>();
  let start = 0;
  let tokenStart = 0;
  let atomicDepth = 0;
  const run = (end: number, tokenEnd: number) => {
    const statementTokens = tokens.slice(tokenStart, tokenEnd);
    tokenStart = tokenEnd + 1;
    const offset = statementTokens[0]?.pos;
    const statementSql = sql.slice(start, end);
    start = end + 1;
    if (offset === undefined) return;
    if (report.statements >= statementLimit) {
      report.truncated = true;
      add({
        statement: report.statements + 1,
        ...location(offset),
        sqlstate: null,
        category: "limit",
        message: `Statement limit ${statementLimit} reached`,
      });
      return;
    }
    report.statements++;
    let object: string | undefined;
    // Lexical fallback preserves an object's name even when its CREATE statement cannot parse.
    const candidate = statementTokens.findIndex((token) =>
      ["table", "view", "function", "sequence", "schema", "type", "index"].includes(token.value),
    );
    if (candidate >= 0) {
      const name = statementTokens[candidate + 1];
      if (name?.type === "ident" || name?.type === "quoted_ident") object = name.value;
    }
    try {
      const ast = parse(statementSql);
      const statement = ast[0];
      if (statement && "name" in statement && Array.isArray(statement.name)) object = statement.name.join(".");
      if (statement && !/^(create_|alter_|comment|grant|revoke|set|reset)/.test(statement.type)) {
        add({
          statement: report.statements,
          ...location(offset),
          object,
          sqlstate: null,
          category: "unknown",
          message: "Only schema statements are analyzed; data, queries and dynamic commands are unknown",
        });
        return;
      }
      const references = statementTokens.flatMap((token, index) => {
        if (!["from", "join", "references"].includes(token.value)) return [];
        const parts: string[] = [];
        for (let at = index + 1; at < statementTokens.length; at += 2) {
          const part = statementTokens[at];
          if (!part || (part.type !== "ident" && part.type !== "quoted_ident")) break;
          parts.push(part.value);
          if (statementTokens[at + 1]?.value !== ".") break;
        }
        return parts.length ? [parts.join(".")] : [];
      });
      const missing = [...failed].find(([name]) =>
        references.some(
          (reference) =>
            reference === name ||
            (!reference.includes(".") && reference === name.split(".").at(-1)) ||
            (!name.includes(".") && name === reference.split(".").at(-1)),
        ),
      );
      if (missing) {
        add({
          statement: report.statements,
          ...location(offset),
          object,
          sqlstate: "42P01",
          category: "prerequisite",
          message: `Prerequisite ${missing[0]} was not created`,
          prerequisiteStatement: missing[1],
        });
        if (object) failed.set(object, report.statements);
        return;
      }
      db.exec(statementSql);
      report.accepted++;
      add({
        statement: report.statements,
        ...location(offset),
        object,
        sqlstate: null,
        category: "unknown",
        message:
          "Accepted by the ephemeral engine; semantics, function bodies and dynamic SQL require oracle verification",
      });
    } catch (error) {
      const code = isPostgresError(error) ? error.code : null;
      const message = error instanceof Error ? error.message.slice(0, 500) : "Schema analysis failed";
      const prerequisite = code?.startsWith("42")
        ? [...failed].find(([name]) => message.includes(`"${name}"`) || message.includes(`"${name.split(".").at(-1)}"`))
        : undefined;
      add({
        statement: report.statements,
        ...location(offset),
        object,
        sqlstate: code,
        category: prerequisite
          ? "prerequisite"
          : code === "0A000"
            ? "unsupported"
            : code?.startsWith("426")
              ? "syntax"
              : "execution",
        message,
        ...(prerequisite ? { prerequisiteStatement: prerequisite[1] } : {}),
      });
      if (object) failed.set(object, report.statements);
    }
  };
  try {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.value === "begin" && tokens[index + 1]?.value === "atomic") atomicDepth++;
      if (token.value === "end" && atomicDepth > 0) atomicDepth--;
      if ((token.type === "punct" && token.value === ";" && atomicDepth === 0) || token.type === "eof")
        run(token.pos, index);
      if (report.truncated) break;
    }
  } finally {
    db.close();
  }
  return report;
}
