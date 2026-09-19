import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { renderSqlExpr, sqlExprArb } from "./arbs/expr.ts";
import { renderSqlPred, sqlTablePredArb } from "./arbs/pred.ts";
import { buildSelectSql, grammarProductionArb, selectShapeArb } from "./arbs/select.ts";
import { createTableDdl, insertRowSql, rowSeedArb, tableSchemaArb } from "./arbs/schema.ts";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

describe("grammar-weighted differential fuzz", () => {
  test("weighted productions match postgres or fail with same category", async () => {
    await fc.assert(
      fc.asyncProperty(
        grammarProductionArb,
        tableSchemaArb,
        fc.uniqueArray(rowSeedArb, { selector: (r) => r.id, minLength: 1, maxLength: 10 }),
        selectShapeArb,
        sqlTablePredArb,
        sqlExprArb,
        async (production, schema, rows, shape, tablePred, expr) => {
          await withDatabases(async (memory, postgres) => {
            for (const db of [memory, postgres]) {
              await db.exec(createTableDdl(schema));
              for (const row of rows) {
                await db.exec(insertRowSql(schema.name, row));
              }
            }

            let sql: string;
            switch (production) {
              case "select_where":
                sql = buildSelectSql(
                  {
                    ...shape,
                    groupBy: null,
                    having: null,
                    setOp: null,
                    where: tablePred,
                  },
                  schema.name,
                );
                break;
              case "select_group": {
                const groupCol = shape.groupBy ?? "a";
                sql = buildSelectSql(
                  {
                    ...shape,
                    groupBy: groupCol,
                    having: null,
                    orderBy: shape.orderBy === groupCol ? shape.orderBy : groupCol,
                    setOp: null,
                  },
                  schema.name,
                  { grouped: true },
                );
                break;
              }
              case "select_setop":
                sql = buildSelectSql(
                  { ...shape, groupBy: null, having: null, setOp: shape.setOp ?? "UNION ALL" },
                  schema.name,
                );
                break;
              case "insert_values": {
                const row = rows[0] ?? { id: 99, a: 1, b: "x" };
                sql = insertRowSql(schema.name, row);
                break;
              }
              case "update_where":
                sql = `UPDATE ${schema.name} SET a = a WHERE ${renderSqlPred(tablePred)}`;
                break;
              case "delete_where":
                sql = `DELETE FROM ${schema.name} WHERE ${renderSqlPred(tablePred)}`;
                break;
              default:
                sql = `SELECT ${renderSqlExpr(expr)} AS v`;
            }

            const mem = await memory.query(sql);
            const ora = await postgres.query(sql);
            if (mem.ok && ora.ok) {
              compareOrReport(production, sql, { production, schema, rows }, mem, ora);
            } else {
              compareOutcomeOrReport(production, sql, { production, schema, rows }, mem, ora);
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  }, 120_000);
});
