import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../adapters/real-sqlite.ts";
import { deepCompareResults } from "../harness/normalize.ts";
import type { ContractDb, QueryResult } from "../harness/types.ts";
import { fuzzAssertConfig, fuzzSeed } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const wordArb = fc.constantFrom(
  "hello",
  "world",
  "sqlite",
  "search",
  "index",
  "token",
  "phrase",
  "near",
  "café",
  "你好",
  "alpha",
  "beta",
  "gamma",
);

const docArb = fc.array(wordArb, { minLength: 1, maxLength: 6 }).map((parts) => parts.join(" "));

const queryArb = fc.oneof(
  wordArb,
  fc.tuple(wordArb, wordArb).map(([a, b]) => `${a} AND ${b}`),
  fc.tuple(wordArb, wordArb).map(([a, b]) => `${a} OR ${b}`),
  fc.tuple(wordArb, wordArb).map(([a, b]) => `${a} NOT ${b}`),
  wordArb.map((w) => `${w.slice(0, Math.max(1, Math.min(3, w.length)))}*`),
  fc.tuple(wordArb, wordArb).map(([a, b]) => `"${a} ${b}"`),
  fc.tuple(wordArb, wordArb).map(([a, b]) => `NEAR(${a} ${b})`),
);

function setupFts(db: ContractDb, docs: string[]): void {
  expect(db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)").ok).toBe(true);
  for (const doc of docs) {
    const result = db.exec("INSERT INTO docs(body) VALUES (?)", [doc]);
    expect(result.ok, result.error?.message).toBe(true);
  }
}

describe("FTS differential fuzz", () => {
  test("random MATCH queries", () => {
    fc.assert(
      fc.property(fc.array(docArb, { minLength: 1, maxLength: 6 }), queryArb, (docs, query) => {
        const memory = new InMemoryAdapter();
        const sqlite = new RealSqliteAdapter();
        try {
          setupFts(memory, docs);
          setupFts(sqlite, docs);
          const sql = `SELECT rowid, body FROM docs WHERE docs MATCH ? ORDER BY rowid`;
          const a = memory.query(sql, [query]);
          const b = sqlite.query(sql, [query]);
          // Syntax errors must agree on outcome category; successes must match rows.
          if (!a.ok || !b.ok) {
            if (a.ok !== b.ok || a.error?.category !== b.error?.category) {
              compareOrReport("fts-match-error", sql, { docs, query }, a, b);
            }
            return;
          }
          compareOrReport("fts-match", sql, { docs, query }, a, b);
        } finally {
          memory.close();
          sqlite.close();
        }
      }),
      fuzzAssertConfig(40),
    );
  });

  test("random tokenizer configs", () => {
    const tokArb = fc.constantFrom("unicode61", "ascii", "porter", "trigram", "porter unicode61");
    fc.assert(
      fc.property(tokArb, fc.array(docArb, { minLength: 1, maxLength: 4 }), wordArb, (tok, docs, term) => {
        const memory = new InMemoryAdapter();
        const sqlite = new RealSqliteAdapter();
        try {
          const create = `CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='${tok}')`;
          const aCreate = memory.exec(create);
          const bCreate = sqlite.exec(create);
          if (!aCreate.ok || !bCreate.ok) {
            expect(aCreate.ok).toBe(bCreate.ok);
            return;
          }
          for (const doc of docs) {
            expect(memory.exec("INSERT INTO docs(body) VALUES (?)", [doc]).ok).toBe(true);
            expect(sqlite.exec("INSERT INTO docs(body) VALUES (?)", [doc]).ok).toBe(true);
          }
          const sql = `SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid`;
          compareOrReport("fts-tok", sql, { tok, docs, term }, memory.query(sql, [term]), sqlite.query(sql, [term]));
        } finally {
          memory.close();
          sqlite.close();
        }
      }),
      fuzzAssertConfig(25),
    );
  });

  test("matchinfo format strings match SQLite", () => {
    const fmtArb = fc.constantFrom("p", "pcx", "pcn", "px");
    fc.assert(
      fc.property(fc.array(docArb, { minLength: 1, maxLength: 4 }), wordArb, fmtArb, (docs, term, fmt) => {
        const memory = new InMemoryAdapter();
        const sqlite = new RealSqliteAdapter();
        try {
          expect(memory.exec("CREATE VIRTUAL TABLE docs USING fts3(body)").ok).toBe(true);
          expect(sqlite.exec("CREATE VIRTUAL TABLE docs USING fts3(body)").ok).toBe(true);
          for (const doc of docs) {
            expect(memory.exec("INSERT INTO docs(body) VALUES (?)", [doc]).ok).toBe(true);
            expect(sqlite.exec("INSERT INTO docs(body) VALUES (?)", [doc]).ok).toBe(true);
          }
          const matchSql = `SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid LIMIT 1`;
          const memHit = memory.query(matchSql, [term]);
          const oraHit = sqlite.query(matchSql, [term]);
          if (!memHit.ok || !oraHit.ok || memHit.rows.length === 0) return;
          const rowid = memHit.rows[0]!.rowid;
          const sql = `SELECT hex(matchinfo(docs, '${fmt}')) FROM docs WHERE docs MATCH ? AND rowid = ?`;
          compareOrReport(
            "fts-matchinfo",
            sql,
            { docs, term, fmt, rowid },
            memory.query(sql, [term, rowid]),
            sqlite.query(sql, [term, rowid]),
          );
        } finally {
          memory.close();
          sqlite.close();
        }
      }),
      fuzzAssertConfig(15),
    );
  });

  test("insert update delete match sequences", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom("insert", "update", "delete", "match"),
            text: docArb,
            term: wordArb,
          }),
          { minLength: 3, maxLength: 8 },
        ),
        (ops) => {
          withDatabases((memory, sqlite) => {
            expect(memory.exec("CREATE VIRTUAL TABLE docs USING fts5(body)").ok).toBe(true);
            expect(sqlite.exec("CREATE VIRTUAL TABLE docs USING fts5(body)").ok).toBe(true);
            let nextId = 1;
            const ids: number[] = [];
            for (const op of ops) {
              if (op.op === "insert") {
                const id = nextId++;
                for (const db of [memory, sqlite]) {
                  const r = db.exec("INSERT INTO docs(rowid, body) VALUES (?, ?)", [id, op.text]);
                  expect(r.ok, r.error?.message).toBe(true);
                }
                ids.push(id);
              } else if (op.op === "update" && ids.length > 0) {
                const id = ids[ids.length - 1]!;
                for (const db of [memory, sqlite]) {
                  const r = db.exec("UPDATE docs SET body = ? WHERE rowid = ?", [op.text, id]);
                  // SQLite change counts differ; only require success
                  expect(r.ok, r.error?.message).toBe(true);
                }
              } else if (op.op === "delete" && ids.length > 0) {
                const id = ids.pop()!;
                for (const db of [memory, sqlite]) {
                  expect(db.exec("DELETE FROM docs WHERE rowid = ?", [id]).ok).toBe(true);
                }
              } else if (op.op === "match") {
                const sql = `SELECT rowid, body FROM docs WHERE docs MATCH ? ORDER BY rowid`;
                const a = memory.query(sql, [op.term]);
                const b = sqlite.query(sql, [op.term]);
                compareOrReport("fts-stateful-match", sql, { ops, term: op.term }, a, b);
              }
            }
            // Skip logical state dump: SQLite FTS shadow tables are not mirrored.
            const finalSql = `SELECT rowid, body FROM docs ORDER BY rowid`;
            compareOrReport("fts-stateful-final", finalSql, { ops }, memory.query(finalSql), sqlite.query(finalSql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});

void fuzzSeed;
void deepCompareResults;
void (null as unknown as QueryResult);
