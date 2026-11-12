import type { Expr, FromItem, SelectBody, SelectCore, SelectStmt } from "../ast/nodes.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { TableData, ViewData } from "../storage/database-state.ts";
import { deparseExpr } from "./deparse.ts";
import { quoteIdentifier } from "./keywords.ts";
import { deparseRuleExpr, type RuleScope } from "./ruleutils.ts";

/**
 * pg_get_viewdef(): a view's query in the layout ruleutils.c prints it (`pg_views.definition`,
 * `information_schema.views.view_definition`). The engine keeps the parsed query, not the analyzed
 * one, so this covers the common shapes (targets, FROM with joins, WHERE, GROUP BY, HAVING,
 * ORDER BY, LIMIT / OFFSET, DISTINCT, set operations); the text of anything rarer is the engine's
 * own and not claimed to match PostgreSQL character for character.
 */

class Printer {
  constructor(
    private readonly ctx: EngineCtx,
    private readonly pretty: boolean,
  ) {}

  query(stmt: SelectStmt): string {
    let out = this.body(stmt.body);
    if (stmt.orderBy.length > 0) {
      const scope = this.scopeOf(stmt.body);
      const items = stmt.orderBy.map((item) => {
        let text = this.expr(scope, item.expr);
        if (item.dir === "desc") text += " DESC";
        if (item.nulls === "first" && item.dir !== "desc") text += " NULLS FIRST";
        if (item.nulls === "last" && item.dir === "desc") text += " NULLS LAST";
        return text;
      });
      out += `\n  ORDER BY ${items.join(", ")}`;
    }
    if (stmt.offset) out += `\n OFFSET ${this.expr(this.scopeOf(stmt.body), stmt.offset)}`;
    if (stmt.limit) out += `\n LIMIT ${this.expr(this.scopeOf(stmt.body), stmt.limit)}`;
    return out;
  }

  private body(body: SelectBody, setOperand = false): string {
    switch (body.type) {
      case "select_core":
        return this.core(body, setOperand);
      case "setop":
        return `${this.body(body.left, true)}\n${body.op.toUpperCase()}${body.all ? " ALL" : ""}\n${this.body(body.right, true)}`;
      case "values":
        return ` VALUES ${body.rows.map((row) => `(${row.map((e) => this.expr(null, e)).join(", ")})`).join(", ")}`;
    }
  }

  /** The single table a query reads, whose columns its unqualified references name. */
  private scopeOf(body: SelectBody): RuleScope {
    if (body.type !== "select_core" || body.from.length !== 1 || body.from[0]!.type !== "from_table") {
      return { ctx: this.ctx, table: null };
    }
    return { ctx: this.ctx, table: this.ctx.state.findTable(body.from[0]!.name) };
  }

  private expr(scope: RuleScope | null, expr: Expr): string {
    try {
      return deparseRuleExpr(scope ?? { ctx: this.ctx, table: null }, expr, this.pretty);
    } catch {
      return deparseExpr(expr);
    }
  }

  private core(original: SelectCore, setOperand: boolean): string {
    const multiple = relationCount(original.from) > 1;
    // with more than one relation in sight, ruleutils names each column's relation
    const qualify = multiple || setOperand;
    const core = qualify ? this.qualifyColumns(original) : original;
    const scope: RuleScope = qualify ? { ctx: this.ctx, table: null, qualify: true } : this.scopeOf(core);
    let out = " SELECT ";
    if (core.distinct) {
      out += core.distinct.on
        ? `DISTINCT ON (${core.distinct.on.map((e) => this.expr(scope, e)).join(", ")}) `
        : "DISTINCT ";
    }
    const targets: string[] = [];
    for (const target of core.targets) {
      if (target.expr.type === "star") {
        for (const [qualifier, column] of this.starColumns(core.from, target.expr.table)) {
          targets.push(qualify ? `${quoteIdentifier(qualifier)}.${quoteIdentifier(column)}` : quoteIdentifier(column));
        }
        continue;
      }
      const text = this.expr(scope, target.expr);
      const implied = impliedName(target.expr);
      const name = target.alias ?? implied;
      targets.push(
        name === lastPart(text) && target.expr.type === "colref" ? text : `${text} AS ${quoteIdentifier(name)}`,
      );
    }
    // a target that prints over several lines (CASE) starts on a line of its own, indented
    out += targets
      .map((text, i) => {
        if (!text.startsWith("\n")) return i === 0 ? text : `,\n    ${text}`;
        const block = text
          .slice(1)
          .split("\n")
          .map((line) => `        ${line}`)
          .join("\n");
        return `${i === 0 ? "" : ","}\n${block}`;
      })
      .join("");
    if (core.from.length > 0) out += `\n   FROM ${core.from.map((item) => this.from(scope, item)).join(", ")}`;
    if (core.where) out += `\n  WHERE ${this.expr(scope, core.where)}`;
    if (core.groupBy && core.groupBy.length > 0) {
      const items = core.groupBy.map((g) => (g.kind === "expr" ? this.expr(scope, g.expr) : "()"));
      out += `\n  GROUP BY ${items.join(", ")}`;
    }
    if (core.having) out += `\n HAVING ${this.expr(scope, core.having)}`;
    return out;
  }

  private from(scope: RuleScope, item: FromItem): string {
    switch (item.type) {
      case "from_table": {
        const name = item.name.length > 1 ? item.name.map(quoteIdentifier).join(".") : quoteIdentifier(item.name[0]!);
        return item.alias && item.alias !== item.name.at(-1) ? `${name} ${quoteIdentifier(item.alias)}` : name;
      }
      case "from_join": {
        const kind =
          item.kind === "inner" ? "JOIN" : item.kind === "cross" ? "CROSS JOIN" : `${item.kind.toUpperCase()} JOIN`;
        // pretty-printing drops the parentheses around each join and its condition
        const [open, close] = this.pretty ? ["", ""] : ["(", ")"];
        let text = `${open}${this.from(scope, item.left)}\n     ${item.natural ? "NATURAL " : ""}${kind} ${this.from(scope, item.right)}`;
        if (item.using) text += ` USING (${item.using.map(quoteIdentifier).join(", ")})`;
        else if (item.on) text += ` ON ${open}${this.expr(scope, item.on)}${close}`;
        return `${text}${close}`;
      }
      case "from_subquery":
        return `(${new Printer(this.ctx, this.pretty).query(item.query)}) ${quoteIdentifier(item.alias ?? "subquery")}`;
      case "from_func":
        return `${this.expr(scope, item.call)}${item.alias ? ` ${quoteIdentifier(item.alias)}` : ""}`;
    }
  }

  /** The query with each bare column reference qualified by the relation that has the column. */
  private qualifyColumns(core: SelectCore): SelectCore {
    const owners = new Map<string, string>();
    for (const [label, column] of this.starColumns(core.from, undefined)) {
      if (!owners.has(column)) owners.set(column, label);
    }
    const rewrite = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rewrite);
      if (typeof node !== "object" || node === null) return node;
      const item = node as { type?: unknown; parts?: unknown };
      // a subquery has relations of its own
      if (item.type === "select") return node;
      if (item.type === "colref" && Array.isArray(item.parts) && item.parts.length === 1) {
        const owner = owners.get(item.parts[0] as string);
        return owner ? { ...item, parts: [owner, item.parts[0]] } : node;
      }
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, rewrite(value)]));
    };
    return rewrite(core) as SelectCore;
  }

  /** The columns `*` (or `t.*`) stands for, with the name of the relation each comes from. */
  private starColumns(from: readonly FromItem[], table: readonly string[] | undefined): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const visit = (item: FromItem) => {
      if (item.type === "from_join") {
        visit(item.left);
        visit(item.right);
        return;
      }
      if (item.type !== "from_table") return;
      const label = item.alias ?? item.name.at(-1)!;
      if (table && table.at(-1) !== label) return;
      const relation: TableData | ViewData | null =
        this.ctx.state.findTable(item.name) ?? this.ctx.state.findView(item.name);
      const columns =
        relation === null
          ? []
          : "rowCount" in relation
            ? relation.columns.map((c) => c.name)
            : (relation.columns ?? relation.matColumns?.map((c) => c.name) ?? []);
      for (const column of columns) out.push([label, column]);
    };
    for (const item of from) visit(item);
    return out;
  }
}

function relationCount(from: readonly FromItem[]): number {
  let count = 0;
  const visit = (item: FromItem) => {
    if (item.type === "from_join") {
      visit(item.left);
      visit(item.right);
    } else count++;
  };
  for (const item of from) visit(item);
  return count;
}

function lastPart(text: string): string {
  const dot = text.lastIndexOf(".");
  return dot === -1 ? text : text.slice(dot + 1);
}

/** FigureColname: the name a target without an alias gets. */
function impliedName(expr: Expr): string {
  switch (expr.type) {
    case "colref":
      return expr.parts.at(-1)!;
    case "func":
      return expr.name.at(-1)!;
    case "cast":
      return impliedName(expr.expr);
    case "case":
      return "case";
    default:
      return "?column?";
  }
}

/** pg_get_viewdef(view, pretty): the query text, ending in a semicolon. */
export function viewDefinition(ctx: EngineCtx, view: ViewData, pretty = false): string {
  return `${new Printer(ctx, pretty).query(view.query)};`;
}
