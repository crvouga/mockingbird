import type { Expr, SelectBody, SelectStmt } from "../ast/nodes.ts";

/** Minimal SELECT deparsing for pg_get_viewdef / information_schema. */
export function deparseSelect(stmt: SelectStmt): string {
  return deparseBody(stmt.body);
}

function deparseBody(body: SelectBody): string {
  switch (body.type) {
    case "select_core":
      return deparseSelectCore(body);
    case "setop":
      return `${deparseBody(body.left)} ${body.op.toUpperCase()}${body.all ? " ALL" : ""} ${deparseBody(body.right)}`;
    case "values":
      return `VALUES ${body.rows.map((r) => `(${r.map(deparseExpr).join(", ")})`).join(", ")}`;
  }
}

function deparseSelectCore(body: Extract<SelectBody, { type: "select_core" }>): string {
  const targets =
    body.targets.length === 0
      ? "*"
      : body.targets
          .map((t) => {
            const expr = deparseExpr(t.expr);
            return t.alias ? `${expr} AS ${quoteIdent(t.alias)}` : expr;
          })
          .join(", ");
  let sql = `SELECT ${targets}`;
  if (body.from.length > 0) {
    sql += ` FROM ${body.from.map(deparseFrom).join(", ")}`;
  }
  if (body.where) sql += ` WHERE ${deparseExpr(body.where)}`;
  if (body.groupBy && body.groupBy.length > 0) {
    sql += ` GROUP BY ${body.groupBy.map((g) => (g.kind === "expr" ? deparseExpr(g.expr) : "?")).join(", ")}`;
  }
  if (body.having) sql += ` HAVING ${deparseExpr(body.having)}`;
  return sql;
}

function deparseFrom(item: Extract<SelectBody, { type: "select_core" }>["from"][number]): string {
  if (item.type === "from_table") {
    const name = item.name.join(".");
    return item.alias ? `${name} ${quoteIdent(item.alias)}` : name;
  }
  return "(subquery)";
}

function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name)) return name;
  return `"${name.replaceAll('"', '""')}"`;
}

function deparseExpr(e: Expr): string {
  switch (e.type) {
    case "null_lit":
      return "NULL";
    case "string_lit":
      return `'${e.value.replaceAll("'", "''")}'`;
    case "number_lit":
      return e.raw;
    case "bool_lit":
      return e.value ? "true" : "false";
    case "colref":
      return e.parts.join(".");
    case "star":
      return e.table ? `${e.table.join(".")}.*` : "*";
    case "binop":
      return `(${deparseExpr(e.left)} ${e.op} ${deparseExpr(e.right)})`;
    case "unop":
      return `${e.op}${deparseExpr(e.operand)}`;
    case "cast":
      return `CAST(${deparseExpr(e.expr)} AS ${e.target.parts.join(".")})`;
    case "func":
      return `${e.name.join(".")}(${e.args.map(deparseExpr).join(", ")})`;
    case "case": {
      let out = "CASE";
      if (e.operand) out += ` ${deparseExpr(e.operand)}`;
      for (const arm of e.whens) {
        out += ` WHEN ${deparseExpr(arm.when)} THEN ${deparseExpr(arm.then)}`;
      }
      if (e.elseExpr) out += ` ELSE ${deparseExpr(e.elseExpr)}`;
      return `${out} END`;
    }
    case "subquery_expr":
      return `(${deparseSelect(e.query)})`;
    default:
      return "?";
  }
}
