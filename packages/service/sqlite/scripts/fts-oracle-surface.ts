/**
 * Probe the reference bun:sqlite FTS surface and write compat/fts-oracle-surface.json.
 * Run: bun run scripts/fts-oracle-surface.ts
 */
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function tryExec(db: BunDatabase, sql: string): { ok: boolean; error?: string } {
  try {
    db.exec(sql);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error).slice(0, 200) };
  }
}

const db = new BunDatabase(":memory:");
const version = String(db.prepare("select sqlite_version()").get()?.["sqlite_version()"] ?? "?");
const sourceId = String(db.prepare("select sqlite_source_id()").get()?.["sqlite_source_id()"] ?? "?");
const compileOptions = db
  .prepare("pragma compile_options")
  .all()
  .map((row) => String((row as { compile_options: string }).compile_options))
  .filter((option) => /FTS|fts/i.test(option));
const modules = db
  .prepare("select name from pragma_module_list() where name like '%fts%' order by 1")
  .all()
  .map((row) => String((row as { name: string }).name));

const tokenizers = [
  "unicode61",
  "ascii",
  "porter",
  "trigram",
  "porter unicode61",
  "porter ascii",
  "unicode61 remove_diacritics 0",
  "unicode61 remove_diacritics 1",
  "unicode61 remove_diacritics 2",
];
const tokenizerResults: Record<string, { ok: boolean; error?: string }> = {};
for (const tokenizer of tokenizers) {
  db.exec("drop table if exists t");
  tokenizerResults[tokenizer] = tryExec(db, `create virtual table t using fts5(c, tokenize="${tokenizer}")`);
}

const optionProbes: Array<{ label: string; setup?: string[]; sql: string }> = [
  { label: "default", sql: "create virtual table t using fts5(content)" },
  { label: "multi_column", sql: "create virtual table t using fts5(title, body)" },
  { label: "contentless", sql: 'create virtual table t using fts5(c, content="")' },
  {
    label: "contentless_delete",
    sql: 'create virtual table t using fts5(c, content="", contentless_delete=1)',
  },
  {
    label: "external_content",
    setup: ["create table docs(id integer primary key, c text)"],
    sql: 'create virtual table t using fts5(c, content="docs", content_rowid="id")',
  },
  { label: "prefix", sql: 'create virtual table t using fts5(c, prefix="2 3")' },
  { label: "columnsize_0", sql: "create virtual table t using fts5(c, columnsize=0)" },
  { label: "detail_full", sql: "create virtual table t using fts5(c, detail=full)" },
  { label: "detail_column", sql: "create virtual table t using fts5(c, detail=column)" },
  { label: "detail_none", sql: "create virtual table t using fts5(c, detail=none)" },
  { label: "tokendata", sql: "create virtual table t using fts5(c, tokendata=1)" },
  { label: "locale", sql: "create virtual table t using fts5(c, locale=1)" },
  { label: "unindexed", sql: "create virtual table t using fts5(title unindexed, body)" },
  { label: "trigram", sql: 'create virtual table t using fts5(c, tokenize="trigram")' },
];
const optionResults: Record<string, { ok: boolean; error?: string }> = {};
for (const probe of optionProbes) {
  db.exec("drop table if exists t");
  db.exec("drop table if exists docs");
  for (const sql of probe.setup ?? []) db.exec(sql);
  optionResults[probe.label] = tryExec(db, probe.sql);
}

const functions = db
  .prepare(
    `select name, type, narg from pragma_function_list()
     where lower(name) in (
       'bm25','highlight','snippet','matchinfo','offsets','rank','fts5','fts5_source_id',
       'fts5_locale','fts5_get_locale','fts5_insttoken','fts3_tokenizer','match','optimize'
     )
     order by name, type, narg`,
  )
  .all();

const commands = ["optimize", "rebuild", "integrity-check", "delete-all", "automerge=4", "merge=2,2"];
const commandResults: Record<string, { ok: boolean; error?: string }> = {};
db.exec("drop table if exists t");
db.exec("create virtual table t using fts5(c)");
db.exec(`insert into t values ('hello')`);
for (const command of commands) {
  commandResults[command] = tryExec(db, `insert into t(t) values ('${command}')`);
}

const report = {
  generatedAt: new Date().toISOString(),
  referenceSqliteVersion: version,
  referenceSqliteSourceId: sourceId,
  ftsCompileOptions: compileOptions,
  ftsModules: modules,
  tokenizers: tokenizerResults,
  createOptions: optionResults,
  auxiliaryFunctions: functions,
  specialCommands: commandResults,
};

const outPath = join(import.meta.dir, "..", "compat", "fts-oracle-surface.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
console.log(
  JSON.stringify(
    { version, modules, tokenizersOk: Object.keys(tokenizerResults).filter((k) => tokenizerResults[k]?.ok) },
    null,
    2,
  ),
);
