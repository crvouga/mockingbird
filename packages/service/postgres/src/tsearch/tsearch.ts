import { pgError, unsupported } from "../errors/error.ts";
import { stemEnglish } from "./stem.ts";

/**
 * Minimal-real tsvector / tsquery: canonical text storage, `simple` and
 * `english` configurations, AND/OR/NOT/phrase queries, ts_rank.
 */

const ENGLISH_STOPWORDS = new Set(
  `i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now`.split(
    " ",
  ),
);

export interface Lexeme {
  word: string;
  positions: Array<{ pos: number; weight: string }>;
}

function tokenizeText(text: string): Array<{ word: string; pos: number }> {
  const out: Array<{ word: string; pos: number }> = [];
  const re = /[0-9A-Za-z\u0080-\uffff][0-9A-Za-z\u0080-\uffff']*/g;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(text)) !== null) {
    pos += 1;
    out.push({ word: m[0], pos });
  }
  return out;
}

function normalizeWord(config: string, word: string): string | null {
  const lower = word.toLowerCase().replace(/'+$/, "").replace(/^'+/, "");
  if (lower === "") return null;
  if (config === "simple") return lower;
  if (config === "english") {
    if (ENGLISH_STOPWORDS.has(lower)) return null;
    return stemEnglish(lower);
  }
  throw pgError("undefined_object", `text search configuration "${config}" does not exist`);
}

/** Build canonical tsvector text: lexemes sorted, with positions. */
export function toTsvector(config: string, text: string): string {
  const lexemes = new Map<string, number[]>();
  for (const { word, pos } of tokenizeText(text)) {
    const norm = normalizeWord(config, word);
    if (norm === null) continue;
    const positions = lexemes.get(norm) ?? [];
    if (positions.length < 256) positions.push(Math.min(pos, 16383));
    lexemes.set(norm, positions);
  }
  const words = [...lexemes.keys()].sort();
  return words.map((w) => `'${w.replaceAll("'", "''")}':${lexemes.get(w)!.join(",")}`).join(" ");
}

/** Parse tsvector text (typinput): `'a':1,2 'b':3A b` */
export function parseTsvector(text: string): string {
  const lexemes = new Map<string, Array<{ pos: number; weight: string }>>();
  const re = /'((?:[^']|'')*)'(?::([0-9A-Da-d,]+))?|([^\s':]+)(?::([0-9A-Da-d,]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = (m[1] !== undefined ? m[1].replaceAll("''", "'") : m[3]!) ?? "";
    if (word === "") continue;
    const posSpec = m[2] ?? m[4];
    const existing = lexemes.get(word) ?? [];
    if (posSpec) {
      for (const p of posSpec.split(",")) {
        const wm = /^(\d+)([A-Da-d]?)$/.exec(p.trim());
        if (!wm) throw pgError("syntax", `syntax error in tsvector: "${text}"`);
        existing.push({ pos: Number(wm[1]), weight: (wm[2] || "D").toUpperCase() });
      }
    }
    lexemes.set(word, existing);
  }
  const words = [...lexemes.keys()].sort();
  return words
    .map((w) => {
      const positions = lexemes.get(w)!;
      const quoted = `'${w.replaceAll("'", "''")}'`;
      if (positions.length === 0) return quoted;
      return `${quoted}:${positions.map((p) => `${p.pos}${p.weight === "D" ? "" : p.weight}`).join(",")}`;
    })
    .join(" ");
}

function renderTsvector(lexemes: Map<string, Array<{ pos: number; weight: string }>>): string {
  const words = [...lexemes.keys()].sort();
  return words
    .map((w) => {
      const positions = lexemes.get(w)!;
      const quoted = `'${w.replaceAll("'", "''")}'`;
      if (positions.length === 0) return quoted;
      return `${quoted}:${positions.map((p) => `${p.pos}${p.weight === "D" ? "" : p.weight}`).join(",")}`;
    })
    .join(" ");
}

/** tsvector || tsvector: shift right-side positions by the left's max position, merge lexemes. */
export function tsvectorConcat(a: string, b: string): string {
  const left = tsvectorLexemes(a);
  const right = tsvectorLexemes(b);
  let maxPos = 0;
  for (const lex of left) {
    for (const p of lex.positions) maxPos = Math.max(maxPos, p.pos);
  }
  const merged = new Map<string, Array<{ pos: number; weight: string }>>();
  for (const lex of left) merged.set(lex.word, [...lex.positions]);
  for (const lex of right) {
    const existing = merged.get(lex.word) ?? [];
    for (const p of lex.positions) {
      existing.push({ pos: Math.min(p.pos + maxPos, 16383), weight: p.weight });
    }
    merged.set(lex.word, existing);
  }
  return renderTsvector(merged);
}

export function tsvectorLexemes(vec: string): Lexeme[] {
  const out: Lexeme[] = [];
  const re = /'((?:[^']|'')*)'(?::([0-9A-Da-d,]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vec)) !== null) {
    const word = m[1]!.replaceAll("''", "'");
    const positions: Array<{ pos: number; weight: string }> = [];
    if (m[2]) {
      for (const p of m[2].split(",")) {
        const wm = /^(\d+)([A-Da-d]?)$/.exec(p.trim());
        if (wm) positions.push({ pos: Number(wm[1]), weight: (wm[2] || "D").toUpperCase() });
      }
    }
    out.push({ word, positions });
  }
  return out;
}

// --- tsquery ------------------------------------------------------------------

export type TsQueryNode =
  | { kind: "lexeme"; word: string; prefix: boolean; weights: string | null }
  | { kind: "and"; left: TsQueryNode; right: TsQueryNode }
  | { kind: "or"; left: TsQueryNode; right: TsQueryNode }
  | { kind: "not"; operand: TsQueryNode }
  | { kind: "phrase"; left: TsQueryNode; right: TsQueryNode; distance: number };

class TsQueryParser {
  private pos = 0;
  constructor(
    private readonly text: string,
    private readonly config: string,
  ) {}

  parse(): TsQueryNode | null {
    const node = this.parseOr();
    this.skipWs();
    if (this.pos < this.text.length) {
      throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
    }
    return node;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }

  private parseOr(): TsQueryNode | null {
    let left = this.parseAnd();
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === "|") {
        this.pos++;
        const right = this.parseAnd();
        if (left === null) left = right;
        else if (right !== null) left = { kind: "or", left, right };
        continue;
      }
      return left;
    }
  }

  private parseAnd(): TsQueryNode | null {
    let left = this.parsePhrase();
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === "&") {
        this.pos++;
        const right = this.parsePhrase();
        if (left === null) left = right;
        else if (right !== null) left = { kind: "and", left, right };
        continue;
      }
      return left;
    }
  }

  private parsePhrase(): TsQueryNode | null {
    let left = this.parseNot();
    for (;;) {
      this.skipWs();
      const m = /^<(?:(\d+)|-)>/.exec(this.text.slice(this.pos));
      if (m) {
        this.pos += m[0].length;
        const distance = m[1] !== undefined ? Number(m[1]) : 1;
        const right = this.parseNot();
        if (left === null) left = right;
        else if (right !== null) left = { kind: "phrase", left, right, distance };
        continue;
      }
      return left;
    }
  }

  private parseNot(): TsQueryNode | null {
    this.skipWs();
    if (this.text[this.pos] === "!") {
      this.pos++;
      const operand = this.parseNot();
      if (operand === null) throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
      return { kind: "not", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): TsQueryNode | null {
    this.skipWs();
    const c = this.text[this.pos];
    if (c === undefined) throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
    if (c === "(") {
      this.pos++;
      const inner = this.parseOr();
      this.skipWs();
      if (this.text[this.pos] !== ")") throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
      this.pos++;
      return inner;
    }
    if (c === "'") {
      this.pos++;
      let word = "";
      for (;;) {
        const ch = this.text[this.pos];
        if (ch === undefined) throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
        if (ch === "'") {
          if (this.text[this.pos + 1] === "'") {
            word += "'";
            this.pos += 2;
            continue;
          }
          this.pos++;
          break;
        }
        word += ch;
        this.pos++;
      }
      return this.finishLexeme(word);
    }
    const m = /^[^\s&|!()<'"]+/.exec(this.text.slice(this.pos));
    if (!m) throw pgError("syntax", `syntax error in tsquery: "${this.text}"`);
    this.pos += m[0].length;
    return this.finishLexeme(m[0]);
  }

  private finishLexeme(word: string): TsQueryNode | null {
    let prefix = false;
    let weights: string | null = null;
    if (this.text[this.pos] === ":") {
      const rest = /^:([A-Da-d*]+)/.exec(this.text.slice(this.pos));
      if (rest) {
        this.pos += rest[0].length;
        if (rest[1]!.includes("*")) prefix = true;
        const w = rest[1]!.replaceAll("*", "").toUpperCase();
        if (w.length > 0) weights = w;
      }
    }
    const norm = normalizeWord(this.config, word);
    if (norm === null) return null;
    return { kind: "lexeme", word: norm, prefix, weights };
  }
}

export function toTsquery(config: string, text: string): string {
  const node = new TsQueryParser(text, config).parse();
  return tsqueryText(node);
}

export function plaintoTsquery(config: string, text: string): string {
  const words: string[] = [];
  for (const { word } of tokenizeText(text)) {
    const norm = normalizeWord(config, word);
    if (norm !== null) words.push(norm);
  }
  return words.map((w) => `'${w.replaceAll("'", "''")}'`).join(" & ");
}

export function phrasetoTsquery(config: string, text: string): string {
  const words: string[] = [];
  for (const { word } of tokenizeText(text)) {
    const norm = normalizeWord(config, word);
    if (norm !== null) words.push(norm);
  }
  return words.map((w) => `'${w.replaceAll("'", "''")}'`).join(" <-> ");
}

export function websearchToTsquery(_config: string, _text: string): string {
  throw unsupported("websearch_to_tsquery");
}

export function tsqueryText(node: TsQueryNode | null): string {
  if (node === null) return "";
  const render = (n: TsQueryNode, parentPrec: number): string => {
    switch (n.kind) {
      case "lexeme": {
        let out = `'${n.word.replaceAll("'", "''")}'`;
        if (n.prefix || n.weights) {
          out += ":";
          if (n.weights) out += n.weights;
          if (n.prefix) out += "*";
        }
        return out;
      }
      case "not": {
        return `!${render(n.operand, 4)}`;
      }
      case "phrase": {
        const s = `${render(n.left, 3)} ${n.distance === 1 ? "<->" : `<${n.distance}>`} ${render(n.right, 3)}`;
        return parentPrec > 2 ? `( ${s} )` : s;
      }
      case "and": {
        const s = `${render(n.left, 2)} & ${render(n.right, 2)}`;
        return parentPrec > 1 ? `( ${s} )` : s;
      }
      case "or": {
        const s = `${render(n.left, 1)} | ${render(n.right, 1)}`;
        return parentPrec > 0 ? `( ${s} )` : s;
      }
    }
  };
  return render(node, 0);
}

export function parseTsqueryText(text: string): TsQueryNode | null {
  return new TsQueryParser(text, "simple").parse();
}

/** tsquery || tsquery / tsquery && tsquery */
export function tsqueryCombine(op: "and" | "or", a: string, b: string): string {
  const l = parseTsqueryText(a);
  const r = parseTsqueryText(b);
  if (l === null) return tsqueryText(r);
  if (r === null) return tsqueryText(l);
  return tsqueryText({ kind: op, left: l, right: r });
}

/**
 * ts_headline (minimal): wraps query-matching words of the document in
 * StartSel/StopSel. Fragment selection (MaxWords/MinWords windows) is not
 * implemented — short documents match PG output exactly.
 */
export function tsHeadline(config: string, document: string, query: string, options?: string): string {
  let startSel = "<b>";
  let stopSel = "</b>";
  if (options) {
    for (const part of options.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      let val = part.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (key === "startsel") startSel = val;
      else if (key === "stopsel") stopSel = val;
    }
  }
  const node = parseTsqueryText(query);
  const queryWords = new Map<string, LexemeNode>();
  if (node !== null) collectQueryOperands(node, queryWords);
  const items = [...queryWords.values()];
  const matches = (norm: string): boolean =>
    items.some((it) => (it.prefix ? norm.startsWith(it.word) : norm === it.word));
  const re = /[0-9A-Za-z\u0080-\uffff][0-9A-Za-z\u0080-\uffff']*/g;
  return document.replace(re, (word) => {
    const norm = normalizeWord(config, word);
    if (norm !== null && matches(norm)) return `${startSel}${word}${stopSel}`;
    return word;
  });
}

/** !! tsquery */
export function tsqueryNegate(a: string): string {
  const n = parseTsqueryText(a);
  if (n === null) return "";
  return tsqueryText({ kind: "not", operand: n });
}

// --- matching ------------------------------------------------------------------

interface MatchPos {
  pos: number;
  weight: string;
}

function lexemeMatches(lexemes: Map<string, MatchPos[]>, node: Extract<TsQueryNode, { kind: "lexeme" }>): MatchPos[] {
  const out: MatchPos[] = [];
  if (node.prefix) {
    for (const [word, positions] of lexemes) {
      if (word.startsWith(node.word)) out.push(...positions);
    }
  } else {
    out.push(...(lexemes.get(node.word) ?? []));
  }
  if (node.weights) {
    return out.filter((p) => node.weights!.includes(p.weight));
  }
  return out;
}

function evalMatch(lexemes: Map<string, MatchPos[]>, node: TsQueryNode): boolean {
  switch (node.kind) {
    case "lexeme": {
      if (node.prefix) {
        for (const word of lexemes.keys()) {
          if (word.startsWith(node.word)) return true;
        }
        return false;
      }
      if (!node.weights) return lexemes.has(node.word);
      return lexemeMatches(lexemes, node).length > 0;
    }
    case "and":
      return evalMatch(lexemes, node.left) && evalMatch(lexemes, node.right);
    case "or":
      return evalMatch(lexemes, node.left) || evalMatch(lexemes, node.right);
    case "not":
      return !evalMatch(lexemes, node.operand);
    case "phrase": {
      return phrasePositions(lexemes, node).length > 0;
    }
  }
}

function phrasePositions(lexemes: Map<string, MatchPos[]>, node: TsQueryNode): number[] {
  switch (node.kind) {
    case "lexeme":
      return lexemeMatches(lexemes, node).map((p) => p.pos);
    case "phrase": {
      const leftPos = phrasePositions(lexemes, node.left);
      const rightPos = phrasePositions(lexemes, node.right);
      const out: number[] = [];
      for (const r of rightPos) {
        if (leftPos.includes(r - node.distance)) out.push(r);
      }
      return out;
    }
    case "and": {
      const l = phrasePositions(lexemes, node.left);
      const r = phrasePositions(lexemes, node.right);
      return l.length > 0 && r.length > 0 ? [...l, ...r] : [];
    }
    case "or": {
      return [...phrasePositions(lexemes, node.left), ...phrasePositions(lexemes, node.right)];
    }
    case "not":
      return [];
  }
}

function vectorMap(vec: string): Map<string, MatchPos[]> {
  const map = new Map<string, MatchPos[]>();
  for (const lex of tsvectorLexemes(vec)) {
    map.set(lex.word, lex.positions.length > 0 ? lex.positions : []);
  }
  return map;
}

export function tsvectorMatches(vec: string, query: string): boolean {
  const node = parseTsqueryText(query);
  if (node === null) return false;
  return evalMatch(vectorMap(vec), node);
}

// --- ranking (ts_rank) — faithful port of PG src/backend/utils/adt/tsrank.c -------

export const DEFAULT_RANK_WEIGHTS = [0.1, 0.2, 0.4, 1.0]; // indexed D, C, B, A

const MAXENTRYPOS = 16384;
const f32 = Math.fround;

function weightIndex(w: string): number {
  return w === "A" ? 3 : w === "B" ? 2 : w === "C" ? 1 : 0;
}

type LexemeNode = Extract<TsQueryNode, { kind: "lexeme" }>;

/** SortAndUniqItems: all unique QI_VAL operands of the query (including under NOT). */
function collectQueryOperands(node: TsQueryNode, out: Map<string, LexemeNode>): void {
  switch (node.kind) {
    case "lexeme": {
      const key = `${node.word}\u0000${node.prefix ? "*" : ""}`;
      if (!out.has(key)) out.set(key, node);
      break;
    }
    case "not":
      collectQueryOperands(node.operand, out);
      break;
    default:
      collectQueryOperands(node.left, out);
      collectQueryOperands(node.right, out);
  }
}

interface RankEntry {
  posts: MatchPos[];
  posnull: boolean;
}

/** find_wordentry: vector entries matching a query operand (prefix may hit several). */
function rankEntriesFor(lexemes: Map<string, MatchPos[]>, item: LexemeNode): RankEntry[] {
  const out: RankEntry[] = [];
  const add = (positions: MatchPos[]): void => {
    if (positions.length === 0) out.push({ posts: [{ pos: 0, weight: "D" }], posnull: true });
    else out.push({ posts: positions, posnull: false });
  };
  if (item.prefix) {
    for (const [word, positions] of lexemes) {
      if (word.startsWith(item.word)) add(positions);
    }
  } else {
    const positions = lexemes.get(item.word);
    if (positions !== undefined) add(positions);
  }
  return out;
}

function calcRankOr(w: number[], lexemes: Map<string, MatchPos[]>, items: LexemeNode[]): number {
  let res = 0;
  for (const item of items) {
    for (const entry of rankEntriesFor(lexemes, item)) {
      const post = entry.posts;
      let resj = 0;
      let wjm = -1;
      let jm = 0;
      for (let j = 0; j < post.length; j++) {
        const wp = w[weightIndex(post[j]!.weight)]!;
        resj = f32(resj + f32(wp / ((j + 1) * (j + 1))));
        if (wp > wjm) {
          wjm = wp;
          jm = j;
        }
      }
      res = f32(res + f32(f32(wjm + resj) - f32(wjm / ((jm + 1) * (jm + 1)))) / 1.64493406685);
    }
  }
  if (items.length > 0) res = f32(res / items.length);
  return res;
}

function wordDistance(dist: number): number {
  if (dist > 100) return 1e-30;
  return f32(1.0 / (1.005 + 0.05 * Math.exp(dist / 1.5 - 2)));
}

function calcRankAnd(w: number[], lexemes: Map<string, MatchPos[]>, items: LexemeNode[]): number {
  if (items.length < 2) return calcRankOr(w, lexemes, items);
  let res = -1;
  // pos[i]: positions of the last matched entry for item i (POSNULL uses MAXENTRYPOS-1)
  const prev: (RankEntry | null)[] = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i++) {
    for (const entry of rankEntriesFor(lexemes, items[i]!)) {
      const post = entry.posnull ? { posts: [{ pos: MAXENTRYPOS - 1, weight: "D" }], posnull: true } : entry;
      for (let k = 0; k < i; k++) {
        const ct = prev[k];
        if (!ct) continue;
        for (const pj of post.posts) {
          for (const cl of ct.posts) {
            let dist = Math.abs(pj.pos - cl.pos);
            if (dist !== 0 || post.posnull || ct.posnull) {
              if (dist === 0) dist = MAXENTRYPOS;
              const wp = f32(f32(w[weightIndex(pj.weight)]! * w[weightIndex(cl.weight)]!) * wordDistance(dist));
              const curw = f32(Math.sqrt(wp));
              res = res < 0 ? curw : f32(1.0 - (1.0 - res) * (1.0 - curw));
            }
          }
        }
      }
      prev[i] = post;
    }
  }
  return res;
}

/** cnt_length: total positions in the vector (posless entries count as 1). */
function cntLength(lexemes: Map<string, MatchPos[]>): number {
  let len = 0;
  for (const positions of lexemes.values()) len += positions.length === 0 ? 1 : positions.length;
  return len;
}

/** calc_rank + normalization flags (RANK_NORM_*). */
export function tsRank(vec: string, query: string, weights?: number[], method = 0): number {
  const node = parseTsqueryText(query);
  if (node === null) return 0;
  const lexemes = vectorMap(vec);
  if (lexemes.size === 0) return 0;
  const w = (weights ?? DEFAULT_RANK_WEIGHTS).map(f32);
  const opMap = new Map<string, LexemeNode>();
  collectQueryOperands(node, opMap);
  const items = [...opMap.values()];

  let res =
    node.kind === "and" || node.kind === "phrase" ? calcRankAnd(w, lexemes, items) : calcRankOr(w, lexemes, items);
  if (res < 0) res = 1e-20;

  if ((method & 1) !== 0) res = f32(res / (Math.log(cntLength(lexemes) + 1) / Math.LN2));
  if ((method & 2) !== 0) {
    const len = cntLength(lexemes);
    if (len > 0) res = f32(res / len);
  }
  if ((method & 8) !== 0) res = f32(res / lexemes.size);
  if ((method & 16) !== 0) res = f32(res / (Math.log(lexemes.size + 1) / Math.LN2));
  if ((method & 32) !== 0) res = f32(res / (res + 1));
  return f32(res);
}

export function tsvectorLength(vec: string): number {
  return tsvectorLexemes(vec).length;
}

export function tsvectorStrip(vec: string): string {
  const words = tsvectorLexemes(vec)
    .map((l) => l.word)
    .sort();
  return words.map((w) => `'${w.replaceAll("'", "''")}'`).join(" ");
}

export function tsvectorSetweight(vec: string, weight: string): string {
  const w = weight.toUpperCase();
  if (!/^[A-D]$/.test(w)) {
    throw pgError("invalid_parameter_value", `unrecognized weight: "${weight}"`);
  }
  return tsvectorLexemes(vec)
    .map((l) => {
      const quoted = `'${l.word.replaceAll("'", "''")}'`;
      if (l.positions.length === 0) return quoted;
      return `${quoted}:${l.positions.map((p) => `${p.pos}${w === "D" ? "" : w}`).join(",")}`;
    })
    .join(" ");
}
