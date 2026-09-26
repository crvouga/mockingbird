import { SqliteError } from "../../errors/index.ts";
import type { Rowid } from "../../storage/row.ts";
import type { SqlValue } from "../../types/value.ts";
import { type FtsKind, type FtsTableOptions, parseFtsModuleArgs } from "./options.ts";
import { type FtsQueryNode, parseFts3Query, parseFts5Query } from "./query.ts";
import { createTokenizer, type FtsToken, type TokenizerFn, tokenizeFtsText } from "./tokenize.ts";

export interface Fts5Row {
  rowid: Rowid;
  values: Map<string, SqlValue>;
  /** Per-column tokens with positions. */
  tokensByColumn: Map<string, FtsToken[]>;
}

export interface FtsMatchHit {
  column: string;
  position: number;
  startUnit: number;
  endUnit: number;
  term: string;
}

export interface FtsMatchCursor {
  tableName: string;
  rowid: Rowid;
  query: string;
  ast: FtsQueryNode;
  hits: FtsMatchHit[];
  /** Phrase term strings used for ranking (flattened). */
  phraseTerms: string[][];
}

interface Posting {
  rowid: Rowid;
  column: string;
  position: number;
  startUnit: number;
  endUnit: number;
}

export class Fts5VirtualTable {
  readonly kind: FtsKind;
  readonly name: string;
  readonly columns: string[];
  readonly originalSql: string | null;
  readonly options: FtsTableOptions;
  readonly rows = new Map<Rowid, Fts5Row>();
  nextRowid: Rowid = 1;
  private readonly tokenize: TokenizerFn;
  /** term -> postings */
  private readonly index = new Map<string, Posting[]>();
  /** Global doc count for bm25. */
  private docCount = 0;
  /** Average document length (tokens across indexed columns). */
  private avgDocLen = 0;
  private totalTokens = 0;

  constructor(name: string, moduleArgs: string[], originalSql: string | null = null, kind: FtsKind = "fts5") {
    this.kind = kind;
    this.name = name;
    this.originalSql = originalSql;
    this.options = parseFtsModuleArgs(moduleArgs, kind);
    this.columns = this.options.columns.map((c) => c.name);
    if (this.columns.length === 0) throw new SqliteError("fts requires at least one column", "other");
    this.tokenize = createTokenizer(this.options.tokenizer);
  }

  scan(): Fts5Row[] {
    return [...this.rows.values()];
  }

  insert(values: Map<string, SqlValue>, rowid?: Rowid): Rowid {
    // Special command: INSERT INTO t(t) VALUES('optimize') etc.
    const command = this.detectCommand(values);
    if (command !== null) {
      this.runCommand(command, values, rowid);
      // Match SQLite: special commands report lastInsertRowid 0
      return 0;
    }

    const assigned = rowid ?? this.nextRowid++;
    if (this.rows.has(assigned)) throw new SqliteError("PRIMARY KEY constraint failed", "constraint_primary");
    const row = this.buildRow(assigned, values);
    this.rows.set(assigned, row);
    this.indexRow(row);
    this.bumpRowid(assigned);
    return assigned;
  }

  update(rowid: Rowid, updates: Map<string, SqlValue>): void {
    const row = this.rows.get(rowid);
    if (!row) return;
    this.unindexRow(row);
    const values = new Map(row.values);
    for (const [key, value] of updates) values.set(key, value);
    const next = this.buildRow(rowid, values);
    this.rows.set(rowid, next);
    this.indexRow(next);
  }

  delete(rowid: Rowid): void {
    const row = this.rows.get(rowid);
    if (!row) return;
    this.unindexRow(row);
    this.rows.delete(rowid);
  }

  matches(rowid: Rowid, leftTable: string | null, leftColumn: string, query: string): boolean {
    const cursor = this.matchCursor(rowid, leftTable, leftColumn, query);
    return cursor !== null;
  }

  matchCursor(rowid: Rowid, leftTable: string | null, leftColumn: string, query: string): FtsMatchCursor | null {
    const row = this.rows.get(rowid);
    if (!row) return null;
    const ast = this.kind === "fts5" ? parseFts5Query(query) : parseFts3Query(query);
    const columnLower = leftColumn.toLowerCase();
    const tableLower = this.name.toLowerCase();
    const leftTableLower = leftTable?.toLowerCase() ?? null;
    // Column-restricted MATCH (content MATCH 'x') limits default columns
    let defaultColumns = this.indexedColumns();
    if (columnLower !== tableLower && !(leftTableLower !== null && columnLower === leftTableLower)) {
      const matched = this.columns.find((c) => c.toLowerCase() === columnLower);
      if (matched) defaultColumns = [matched];
      else return null;
    }
    const hits: FtsMatchHit[] = [];
    const ok = this.evalNode(ast, row, defaultColumns, hits);
    if (!ok) return null;
    return {
      tableName: this.name,
      rowid,
      query,
      ast,
      hits,
      phraseTerms: collectPhraseTerms(ast),
    };
  }

  bm25(cursor: FtsMatchCursor, weights?: number[]): number {
    const row = this.rows.get(cursor.rowid);
    if (!row) return -0;
    const phrases = cursor.phraseTerms.length > 0 ? cursor.phraseTerms : [];
    if (phrases.length === 0) return -0;
    const cols = this.indexedColumns();
    const w = cols.map((_, i) => weights?.[i] ?? 1);
    const k1 = 1.2;
    const b = 0.75;
    const N = Math.max(1, this.docCount);
    const avgdl = Math.max(1e-9, this.avgDocLen);
    let score = 0;
    const D = this.docLength(row);

    for (let pi = 0; pi < phrases.length; pi++) {
      const phrase = phrases[pi]!;
      // Phrase frequency: weighted count of phrase occurrences across columns
      let freq = 0;
      for (let ci = 0; ci < cols.length; ci++) {
        const col = cols[ci]!;
        const n = this.phraseFreq(row, col, phrase);
        freq += (w[ci] ?? 1) * n;
      }
      if (freq === 0) continue;
      const df = this.phraseDocFreq(phrase);
      // SQLite FTS5: IDF = log((N - nHit + 0.5) / (nHit + 0.5)); floor at 1e-6
      let idf = Math.log((N - df + 0.5) / (df + 0.5));
      if (idf <= 0) idf = 1e-6;
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * D) / avgdl)));
    }
    return score === 0 ? -0 : -score;
  }

  highlight(cursor: FtsMatchCursor, colIndex: number, open: string, close: string): string {
    const row = this.rows.get(cursor.rowid);
    if (!row) return "";
    const col = this.columns[colIndex];
    if (!col) return "";
    const text = valueToText(row.values.get(col.toLowerCase()) ?? null);
    if (this.options.content === "contentless") return text;
    const hits = cursor.hits
      .filter((h) => h.column.toLowerCase() === col.toLowerCase())
      .sort((a, b) => a.startUnit - b.startUnit);
    if (hits.length === 0) return text;
    let out = "";
    let at = 0;
    for (const hit of mergeHits(hits)) {
      out += text.slice(at, hit.startUnit);
      out += open + text.slice(hit.startUnit, hit.endUnit) + close;
      at = hit.endUnit;
    }
    out += text.slice(at);
    return out;
  }

  snippet(
    cursor: FtsMatchCursor,
    colIndex: number,
    open: string,
    close: string,
    ellipsis: string,
    tokenCount: number,
  ): string {
    const row = this.rows.get(cursor.rowid);
    if (!row) return "";
    const col = this.columns[colIndex];
    if (!col) return "";
    const text = valueToText(row.values.get(col.toLowerCase()) ?? null);
    const tokens = row.tokensByColumn.get(col.toLowerCase()) ?? [];
    const hitPositions = new Set(
      cursor.hits.filter((h) => h.column.toLowerCase() === col.toLowerCase()).map((h) => h.position),
    );
    if (tokens.length === 0 || hitPositions.size === 0) return text;
    const firstHit = Math.min(...hitPositions);
    const window = Math.max(1, tokenCount);
    const startPos = Math.max(0, firstHit - Math.floor(window / 4));
    const endPos = Math.min(tokens.length - 1, startPos + window - 1);
    const startUnit = tokens[startPos]!.startUnit;
    const endUnit = tokens[endPos]!.endUnit;
    const slice = text.slice(startUnit, endUnit);
    // Re-highlight within slice
    const localHits = cursor.hits
      .filter((h) => h.column.toLowerCase() === col.toLowerCase() && h.startUnit >= startUnit && h.endUnit <= endUnit)
      .map((h) => ({ ...h, startUnit: h.startUnit - startUnit, endUnit: h.endUnit - startUnit }));
    let out = "";
    let at = 0;
    for (const hit of mergeHits(localHits)) {
      out += slice.slice(at, hit.startUnit);
      out += open + slice.slice(hit.startUnit, hit.endUnit) + close;
      at = hit.endUnit;
    }
    out += slice.slice(at);
    if (startPos > 0) out = ellipsis + out;
    if (endPos < tokens.length - 1) out = out + ellipsis;
    return out;
  }

  /** FTS3/4 offsets(): "col phrase start length ..." */
  offsets(cursor: FtsMatchCursor): string {
    const row = this.rows.get(cursor.rowid);
    if (!row) return "";
    const parts: string[] = [];
    for (const hit of cursor.hits) {
      const colIndex = this.columns.findIndex((c) => c.toLowerCase() === hit.column.toLowerCase());
      const text = valueToText(row.values.get(hit.column.toLowerCase()) ?? null);
      const start = utf8OffsetLocal(text, hit.startUnit);
      const length = utf8OffsetLocal(text, hit.endUnit) - start;
      parts.push(String(colIndex), "0", String(start), String(length));
    }
    return parts.join(" ");
  }

  /** FTS3 matchinfo format encoded as native-style 32-bit little-endian integers. */
  matchinfo(cursor: FtsMatchCursor, format = "pcx"): Uint8Array {
    const row = this.rows.get(cursor.rowid);
    const nPhrase = Math.max(1, cursor.phraseTerms.length);
    const nCol = this.columns.length;
    const values: number[] = [];
    for (const request of format) {
      switch (request) {
        case "p":
          values.push(nPhrase);
          break;
        case "c":
          values.push(nCol);
          break;
        case "s":
          for (let c = 0; c < nCol; c++) {
            let longest = 0;
            let run = 0;
            for (let p = 0; p < nPhrase; p++) {
              const phrase = cursor.phraseTerms[p] ?? [];
              if (row && this.phraseFreq(row, this.columns[c]!, phrase) > 0) {
                run++;
                longest = Math.max(longest, run);
              } else {
                run = 0;
              }
            }
            values.push(longest);
          }
          break;
        case "x":
          for (let p = 0; p < nPhrase; p++) {
            const phrase = cursor.phraseTerms[p] ?? [];
            for (let c = 0; c < nCol; c++) {
              const column = this.columns[c]!;
              const localHits = row ? this.phraseFreq(row, column, phrase) : 0;
              let globalHits = 0;
              let matchingRows = 0;
              for (const candidate of this.rows.values()) {
                const hits = this.phraseFreq(candidate, column, phrase);
                globalHits += hits;
                if (hits > 0) matchingRows++;
              }
              values.push(localHits, globalHits, matchingRows);
            }
          }
          break;
        case "y":
          for (let p = 0; p < nPhrase; p++) {
            const phrase = cursor.phraseTerms[p] ?? [];
            for (let c = 0; c < nCol; c++) {
              values.push(row ? this.phraseFreq(row, this.columns[c]!, phrase) : 0);
            }
          }
          break;
        default:
          throw new SqliteError(`unrecognized matchinfo request: ${request}`, "other");
      }
    }
    const buf = new Uint8Array(values.length * 4);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]! >>> 0, true);
    return buf;
  }

  vocabRows(mode: "row" | "col" | "instance"): Array<Record<string, SqlValue>> {
    if (mode === "row") {
      const out: Array<Record<string, SqlValue>> = [];
      for (const [term, postings] of [...this.index.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const docs = new Set(postings.map((p) => String(p.rowid)));
        out.push({ term, doc: docs.size, cnt: postings.length });
      }
      return out;
    }
    // col / instance simplified to row shape
    return this.vocabRows("row");
  }

  clone(): Fts5VirtualTable {
    const copy = new Fts5VirtualTable(
      this.name,
      this.options.columns.map((c) => (c.unindexed ? `${c.name} UNINDEXED` : c.name)),
      this.originalSql,
      this.kind,
    );
    // Re-parse options by reconstructing module args is imperfect; copy fields
    Object.assign(copy, {
      options: structuredClone(this.options),
      columns: [...this.columns],
    });
    (copy as unknown as { tokenize: TokenizerFn }).tokenize = this.tokenize;
    copy.nextRowid = this.nextRowid;
    for (const [rowid, row] of this.rows) {
      const cloned: Fts5Row = {
        rowid: row.rowid,
        values: new Map(row.values),
        tokensByColumn: new Map([...row.tokensByColumn.entries()].map(([k, v]) => [k, v.map((t) => ({ ...t }))])),
      };
      copy.rows.set(rowid, cloned);
      copy.indexRow(cloned);
    }
    return copy;
  }

  private detectCommand(values: Map<string, SqlValue>): string | null {
    // INSERT INTO t(t) VALUES('optimize') — column name equals table name
    const key = this.name.toLowerCase();
    if (!values.has(key)) return null;
    const v = values.get(key);
    if (typeof v !== "string") return null;
    return v;
  }

  private runCommand(command: string, _values: Map<string, SqlValue>, rowid?: Rowid): void {
    const cmd = command.toLowerCase();
    if (cmd === "optimize") return;
    if (cmd === "rebuild") {
      this.rebuild();
      return;
    }
    if (cmd === "integrity-check") return;
    if (cmd === "delete-all") {
      if (this.options.content === "normal") {
        throw new SqliteError(
          "'delete-all' may only be used with a contentless or external content fts5 table",
          "other",
        );
      }
      for (const rowid of [...this.rows.keys()]) this.delete(rowid);
      return;
    }
    if (cmd.startsWith("merge=") || cmd.startsWith("automerge=")) {
      throw new SqliteError("SQL logic error", "other");
    }
    if (cmd === "delete") {
      if (rowid === undefined) throw new SqliteError("SQL logic error", "other");
      this.delete(rowid);
      return;
    }
    // Unknown command string may be treated as content insert into table-named column — ignore as no-op command fail
    throw new SqliteError("SQL logic error", "other");
  }

  private rebuild(): void {
    this.index.clear();
    this.docCount = 0;
    this.totalTokens = 0;
    this.avgDocLen = 0;
    for (const row of this.rows.values()) this.indexRow(row);
  }

  private buildRow(rowid: Rowid, values: Map<string, SqlValue>): Fts5Row {
    const stored = new Map<string, SqlValue>();
    const tokensByColumn = new Map<string, FtsToken[]>();
    for (const column of this.columns) {
      const key = column.toLowerCase();
      const value = values.get(key) ?? null;
      if (this.options.content === "contentless") {
        // Contentless stores index only; user-visible content columns are NULL
        stored.set(key, null);
        const text = valueToText(value);
        const colDef = this.options.columns.find((c) => c.name.toLowerCase() === key);
        tokensByColumn.set(key, colDef?.unindexed ? [] : this.tokenize(text));
        continue;
      }
      stored.set(key, value);
      const colDef = this.options.columns.find((c) => c.name.toLowerCase() === key);
      tokensByColumn.set(key, colDef?.unindexed ? [] : this.tokenize(valueToText(value)));
    }
    return { rowid, values: stored, tokensByColumn };
  }

  private indexRow(row: Fts5Row): void {
    let tokenCount = 0;
    for (const [col, tokens] of row.tokensByColumn) {
      for (const token of tokens) {
        tokenCount++;
        this.addPosting(token.term, {
          rowid: row.rowid,
          column: col,
          position: token.position,
          startUnit: token.startUnit,
          endUnit: token.endUnit,
        });
        for (const n of this.options.prefix) {
          if (token.term.length >= n) {
            const pref = `${token.term.slice(0, n)}*`;
            // prefix index entries are optimization only — queries still work via scan
            void pref;
          }
        }
      }
    }
    this.docCount++;
    this.totalTokens += tokenCount;
    this.avgDocLen = this.totalTokens / Math.max(1, this.docCount);
  }

  private unindexRow(row: Fts5Row): void {
    let tokenCount = 0;
    for (const [col, tokens] of row.tokensByColumn) {
      for (const token of tokens) {
        tokenCount++;
        this.removePosting(token.term, row.rowid, col, token.position);
      }
    }
    this.docCount = Math.max(0, this.docCount - 1);
    this.totalTokens = Math.max(0, this.totalTokens - tokenCount);
    this.avgDocLen = this.totalTokens / Math.max(1, this.docCount);
  }

  private addPosting(term: string, posting: Posting): void {
    const key = term.toLowerCase();
    const list = this.index.get(key);
    if (list) list.push(posting);
    else this.index.set(key, [posting]);
  }

  private removePosting(term: string, rowid: Rowid, column: string, position: number): void {
    const key = term.toLowerCase();
    const list = this.index.get(key);
    if (!list) return;
    const next = list.filter((p) => !(p.rowid === rowid && p.column === column && p.position === position));
    if (next.length === 0) this.index.delete(key);
    else this.index.set(key, next);
  }

  private indexedColumns(): string[] {
    return this.options.columns.filter((c) => !c.unindexed).map((c) => c.name);
  }

  private evalNode(node: FtsQueryNode, row: Fts5Row, defaultColumns: string[], hits: FtsMatchHit[]): boolean {
    switch (node.type) {
      case "true":
        return true;
      case "and":
        return node.children.every((child) => this.evalNode(child, row, defaultColumns, hits));
      case "or": {
        // Collect hits from matching branch only
        for (const child of node.children) {
          const local: FtsMatchHit[] = [];
          if (this.evalNode(child, row, defaultColumns, local)) {
            hits.push(...local);
            return true;
          }
        }
        return false;
      }
      case "not": {
        const local: FtsMatchHit[] = [];
        return !this.evalNode(node.child, row, defaultColumns, local);
      }
      case "term": {
        const expanded = this.expandTermNode(node);
        if (expanded.type !== "term") return this.evalNode(expanded, row, defaultColumns, hits);
        const cols = resolveColumns(node.column, node.columns, defaultColumns, this.columns);
        const needle = this.normalizeQueryTerm(node.value);
        let found = false;
        for (const col of cols) {
          const tokens = row.tokensByColumn.get(col.toLowerCase()) ?? [];
          for (const token of tokens) {
            if (node.prefix ? token.term.startsWith(needle) : token.term === needle) {
              hits.push({
                column: col,
                position: token.position,
                startUnit: token.startUnit,
                endUnit: token.endUnit,
                term: token.term,
              });
              found = true;
            }
          }
        }
        return found;
      }
      case "phrase": {
        const cols = resolveColumns(node.column, node.columns, defaultColumns, this.columns);
        let found = false;
        for (const col of cols) {
          const tokens = row.tokensByColumn.get(col.toLowerCase()) ?? [];
          const terms = node.terms.map((t) => ({
            value: this.normalizeQueryTerm(t.value),
            prefix: t.prefix,
          }));
          for (let i = 0; i <= tokens.length - terms.length; i++) {
            let ok = true;
            for (let j = 0; j < terms.length; j++) {
              const tok = tokens[i + j]!;
              const term = terms[j]!;
              if (term.prefix ? !tok.term.startsWith(term.value) : tok.term !== term.value) {
                ok = false;
                break;
              }
            }
            if (ok) {
              found = true;
              for (let j = 0; j < terms.length; j++) {
                const tok = tokens[i + j]!;
                hits.push({
                  column: col,
                  position: tok.position,
                  startUnit: tok.startUnit,
                  endUnit: tok.endUnit,
                  term: tok.term,
                });
              }
            }
          }
        }
        return found;
      }
      case "near": {
        const cols = resolveColumns(node.column, node.columns, defaultColumns, this.columns);
        // Evaluate each child to position sets per column
        for (const col of cols) {
          const posSets: number[][] = [];
          let allOk = true;
          for (const child of node.children) {
            const local: FtsMatchHit[] = [];
            if (!this.evalNode(child, row, [col], local)) {
              allOk = false;
              break;
            }
            posSets.push(local.filter((h) => h.column.toLowerCase() === col.toLowerCase()).map((h) => h.position));
          }
          if (!allOk) continue;
          if (nearMatch(posSets, node.distance)) {
            // re-collect hits
            for (const child of node.children) this.evalNode(child, row, [col], hits);
            return true;
          }
        }
        return false;
      }
    }
  }

  private normalizeQueryTerm(term: string): string {
    // Query terms are tokenized with the same tokenizer when possible
    const tokens = this.tokenize(term);
    if (tokens.length === 1) return tokens[0]!.term;
    if (tokens.length === 0) return term.toLowerCase();
    // Trigram (and multi-token) queries: join is wrong for matching — use first only for df;
    // phrase matching uses tokenize() directly via evalNode.
    return tokens[0]!.term;
  }

  /** For trigram tokenizer, a bare MATCH term is a phrase of overlapping trigrams. */
  private expandTermNode(node: Extract<FtsQueryNode, { type: "term" }>): FtsQueryNode {
    if (this.options.tokenizer.name !== "trigram") return node;
    const tokens = this.tokenize(node.value);
    if (tokens.length <= 1) return node;
    return {
      type: "phrase",
      terms: tokens.map((t) => ({ value: t.term, prefix: false })),
      column: node.column,
      columns: node.columns,
    };
  }

  private phraseFreq(row: Fts5Row, column: string, phrase: string[]): number {
    if (phrase.length === 0) return 0;
    const tokens = row.tokensByColumn.get(column.toLowerCase()) ?? [];
    const terms = phrase.map((t) => this.normalizeQueryTerm(t));
    let count = 0;
    for (let i = 0; i <= tokens.length - terms.length; i++) {
      let ok = true;
      for (let j = 0; j < terms.length; j++) {
        if (tokens[i + j]!.term !== terms[j]) {
          ok = false;
          break;
        }
      }
      if (ok) count++;
    }
    return count;
  }

  private phraseDocFreq(phrase: string[]): number {
    let n = 0;
    for (const row of this.rows.values()) {
      for (const col of this.indexedColumns()) {
        if (this.phraseFreq(row, col, phrase) > 0) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  private docLength(row: Fts5Row): number {
    let n = 0;
    for (const col of this.indexedColumns()) n += (row.tokensByColumn.get(col.toLowerCase()) ?? []).length;
    return Math.max(1, n);
  }

  private bumpRowid(assigned: Rowid): void {
    if (typeof assigned === "bigint") {
      if (assigned >= BigInt(this.nextRowid as number | bigint)) this.nextRowid = assigned + 1n;
    } else if (assigned >= (typeof this.nextRowid === "number" ? this.nextRowid : Number(this.nextRowid))) {
      this.nextRowid = assigned + 1;
    }
  }
}

function resolveColumns(
  column: string | null,
  columns: string[] | null,
  defaultColumns: string[],
  allColumns: string[],
): string[] {
  if (columns && columns.length > 0) {
    return columns
      .map((c) => allColumns.find((x) => x.toLowerCase() === c.toLowerCase()))
      .filter((c): c is string => !!c);
  }
  if (column) {
    const matched = allColumns.find((c) => c.toLowerCase() === column.toLowerCase());
    return matched ? [matched] : [];
  }
  return defaultColumns;
}

function nearMatch(posSets: number[][], distance: number): boolean {
  if (posSets.length === 0) return false;
  if (posSets.length === 1) return posSets[0]!.length > 0;
  // Check if there exists a combination where max-min <= distance + (n-1) roughly (FTS5 NEAR)
  // FTS5: NEAR(a b, N) means the terms are within N tokens of each other.
  const first = posSets[0]!;
  for (const p0 of first) {
    if (nearFrom(p0, posSets.slice(1), distance)) return true;
  }
  return false;
}

function nearFrom(anchor: number, rest: number[][], distance: number): boolean {
  if (rest.length === 0) return true;
  const next = rest[0]!;
  for (const p of next) {
    if (Math.abs(p - anchor) <= distance) {
      if (nearFrom(p, rest.slice(1), distance)) return true;
    }
  }
  return false;
}

function collectPhraseTerms(node: FtsQueryNode): string[][] {
  switch (node.type) {
    case "term":
      return [[node.value]];
    case "phrase":
      return [node.terms.map((t) => t.value)];
    case "and":
    case "or":
    case "near":
      return node.children.flatMap(collectPhraseTerms);
    case "not":
      return [];
    case "true":
      return [];
  }
}

function mergeHits(hits: FtsMatchHit[]): FtsMatchHit[] {
  if (hits.length === 0) return [];
  const sorted = [...hits].sort((a, b) => a.startUnit - b.startUnit);
  const out: FtsMatchHit[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.startUnit <= last.endUnit) last.endUnit = Math.max(last.endUnit, cur.endUnit);
    else out.push({ ...cur });
  }
  return out;
}

function valueToText(value: SqlValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function utf8OffsetLocal(text: string, unitIndex: number): number {
  return new TextEncoder().encode(text.slice(0, unitIndex)).length;
}

export { tokenizeFtsText };
