import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { grammarProductionArb } from "./arbs/select.ts";
import { createTableDdl, insertRowSql, rowSeedArb, tableSchemaArb } from "./arbs/schema.ts";
import { renderSqlPred, sqlPredArb } from "./arbs/pred.ts";
import { renderSqlExpr, sqlExprArb } from "./arbs/expr.ts";
import { buildSelectSql, selectShapeArb } from "./arbs/select.ts";
import { fuzzAssertConfig } from "./config.ts";
import type { ContractDb } from "../harness/types.ts";
import { compareOrReport, compareOutcomeOrReport, compareWriteOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

describe("grammar-weighted differential fuzz", () => {
  test("weighted productions match SQLite or fail with same category", () => {
    fc.assert(
      fc.property(
        grammarProductionArb,
        tableSchemaArb,
        fc.uniqueArray(rowSeedArb, { selector: (r) => r.id, minLength: 1, maxLength: 10 }),
        selectShapeArb,
        sqlPredArb,
        sqlExprArb,
        (production, schema, rows, shape, pred, expr) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec(createTableDdl(schema));
              for (const row of rows) {
                db.exec(insertRowSql(schema.name, row, sqlLiteral));
              }
            }

            let sql: string;
            switch (production) {
              case "select_where":
                sql = buildSelectSql({ ...shape, groupBy: null, having: null, setOp: null }, schema.name, sqlLiteral);
                break;
              case "select_group":
                sql = buildSelectSql(
                  { ...shape, groupBy: shape.groupBy ?? "a", setOp: null },
                  schema.name,
                  sqlLiteral,
                  { grouped: true },
                );
                break;
              case "select_setop":
                sql = buildSelectSql(
                  { ...shape, groupBy: null, having: null, setOp: shape.setOp ?? "UNION ALL" },
                  schema.name,
                  sqlLiteral,
                );
                break;
              case "insert_values": {
                const row = rows[0] ?? { id: 99, a: 1, b: "x" };
                sql = `INSERT OR IGNORE INTO ${schema.name} VALUES (${row.id}, ${sqlLiteral(row.a)}, ${sqlLiteral(row.b)})`;
                break;
              }
              case "update_where":
                sql = `UPDATE ${schema.name} SET a = a WHERE ${renderSqlPred(pred, sqlLiteral)}`;
                break;
              case "delete_where":
                sql = `DELETE FROM ${schema.name} WHERE ${renderSqlPred(pred, sqlLiteral)}`;
                break;
              default:
                sql = `SELECT ${renderSqlExpr(expr, sqlLiteral)} AS v`;
            }

            let mem: ReturnType<ContractDb["query"]>;
            let ora: ReturnType<ContractDb["query"]>;
            const isWrite =
              production === "insert_values" || production === "update_where" || production === "delete_where";
            if (isWrite) {
              mem = memory.exec(sql);
              ora = sqlite.exec(sql);
            } else {
              mem = memory.query(sql);
              ora = sqlite.query(sql);
            }
            if (mem.ok && ora.ok) {
              if (isWrite) {
                compareWriteOrReport(production, sql, { production, schema, rows }, mem, ora);
                const stateSql = `SELECT id, a, b FROM ${schema.name} ORDER BY id`;
                compareOrReport(
                  `${production}-state`,
                  stateSql,
                  { production, schema, rows },
                  memory.query(stateSql),
                  sqlite.query(stateSql),
                );
              } else {
                compareOrReport(production, sql, { production, schema, rows }, mem, ora);
              }
            } else {
              compareOutcomeOrReport(production, sql, { production, schema, rows }, mem, ora);
            }
          });
        },
      ),
      fuzzAssertConfig(25),
    );
  });
});
