import { pgError, unsupported } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { type TypedValue, type TypeId, tv } from "../types/value.ts";

/**
 * `CREATE EXTENSION fuzzystrmatch`: levenshtein / levenshtein_less_equal (PostgreSQL's
 * varstr_levenshtein), soundex / text_soundex / difference and metaphone, ported from
 * contrib/fuzzystrmatch. soundex and metaphone work on bytes in the C locale, so only ASCII
 * letters count as letters. dmetaphone, dmetaphone_alt and daitch_mokotoff are installed but
 * fail with 0A000 when called.
 */

/** Marks functions installed by `CREATE EXTENSION fuzzystrmatch` (survives PGMM). */
const FUZZYSTRMATCH_BODY = "fuzzystrmatch";

const MAX_LEVENSHTEIN_STRLEN = 255;
const MAX_METAPHONE_STRLEN = 255;
const SOUNDEX_LEN = 4;

const MEMBERS: ReadonlyArray<readonly [name: string, args: readonly TypeId[], returns: TypeId]> = [
  ["daitch_mokotoff", ["text"], "text[]"],
  ["difference", ["text", "text"], "int4"],
  ["dmetaphone", ["text"], "text"],
  ["dmetaphone_alt", ["text"], "text"],
  ["levenshtein", ["text", "text"], "int4"],
  ["levenshtein", ["text", "text", "int4", "int4", "int4"], "int4"],
  ["levenshtein_less_equal", ["text", "text", "int4"], "int4"],
  ["levenshtein_less_equal", ["text", "text", "int4", "int4", "int4", "int4"], "int4"],
  ["metaphone", ["text", "int4"], "text"],
  ["soundex", ["text"], "text"],
  ["text_soundex", ["text"], "text"],
];

export function installFuzzystrmatch(state: DatabaseState, schemaName: string): void {
  const schema = state.getSchema(schemaName);
  for (const [name, args, returns] of MEMBERS) {
    const fn: FunctionData = {
      name,
      schema: schema.name,
      argNames: args.map(() => null),
      argTypes: [...args],
      argDefaults: args.map(() => null),
      returns,
      returnsSet: false,
      returnsTable: null,
      language: "internal",
      body: null,
      rawBody: FUZZYSTRMATCH_BODY,
      strict: true,
      volatility: "immutable",
      oid: state.nextOid(),
    };
    schema.functions.set(name, [...(schema.functions.get(name) ?? []), fn]);
  }
}

export function uninstallFuzzystrmatch(state: DatabaseState): void {
  for (const schema of state.schemas.values()) {
    for (const [name, fns] of [...schema.functions.entries()]) {
      const keep = fns.filter((fn) => fn.language !== "internal" || fn.rawBody !== FUZZYSTRMATCH_BODY);
      if (keep.length === fns.length) continue;
      if (keep.length === 0) schema.functions.delete(name);
      else schema.functions.set(name, keep);
    }
  }
}

export function evalFuzzystrmatchFunction(ctx: EngineCtx, fn: FunctionData, args: TypedValue[]): TypedValue {
  const ret = fn.returns ?? "text";
  if (args.some((arg) => arg.v === null)) return tv(ret, null);
  const text = (i: number): string => castTo(ctx, args[i]!, "text").v as string;
  const int = (i: number): number => castTo(ctx, args[i]!, "int4").v as number;
  switch (fn.name) {
    case "levenshtein":
      return tv(
        "int4",
        args.length === 5
          ? levenshtein(text(0), text(1), int(2), int(3), int(4), -1)
          : levenshtein(text(0), text(1), 1, 1, 1, -1),
      );
    case "levenshtein_less_equal":
      return tv(
        "int4",
        args.length === 6
          ? levenshtein(text(0), text(1), int(2), int(3), int(4), int(5))
          : levenshtein(text(0), text(1), 1, 1, 1, int(2)),
      );
    case "soundex":
    case "text_soundex":
      return tv("text", soundex(text(0)));
    case "difference": {
      const a = soundex(text(0)).padEnd(SOUNDEX_LEN, "\0");
      const b = soundex(text(1)).padEnd(SOUNDEX_LEN, "\0");
      let result = 0;
      for (let i = 0; i < SOUNDEX_LEN; i++) if (a[i] === b[i]) result++;
      return tv("int4", result);
    }
    case "metaphone":
      return tv("text", metaphone(text(0), int(1)));
    case "dmetaphone":
    case "dmetaphone_alt":
    case "daitch_mokotoff":
      throw unsupported(`fuzzystrmatch ${fn.name}()`);
    default:
      throw pgError("undefined_function", `function ${fn.schema}.${fn.name} is not implemented`, "42883");
  }
}

// --- levenshtein ------------------------------------------------------------------------------

/**
 * `varstr_levenshtein` / `varstr_levenshtein_less_equal` (`maxD >= 0`) over characters, with
 * 32-bit wrapping arithmetic as the oracle's build computes it. With a bound, the answer is
 * exact only up to `maxD`; past it the result is some value greater than `maxD`.
 */
function levenshtein(source: string, target: string, insC: number, delC: number, subC0: number, maxD0: number): number {
  const s = Array.from(source);
  const t = Array.from(target);
  let m = s.length;
  let n = t.length;
  let subC = subC0;
  let maxD = maxD0;
  if (m === 0) return Math.imul(n, insC);
  if (n === 0) return Math.imul(m, delC);
  if (m > MAX_LEVENSHTEIN_STRLEN || n > MAX_LEVENSHTEIN_STRLEN) {
    throw pgError(
      "invalid_parameter_value",
      `levenshtein argument exceeds maximum length of ${MAX_LEVENSHTEIN_STRLEN} characters`,
      "22023",
    );
  }
  const bounded = maxD >= 0;
  let startColumn = 0;
  let stopColumn = m + 1;
  if (bounded) {
    const netInserts = n - m;
    const minTheoD = netInserts < 0 ? Math.imul(-netInserts, delC) : Math.imul(netInserts, insC);
    if (minTheoD > maxD) return (maxD + 1) | 0;
    if (((insC + delC) | 0) < subC) subC = (insC + delC) | 0;
    const maxTheoD = (minTheoD + Math.imul(subC, Math.min(m, n))) | 0;
    if (maxD >= maxTheoD) maxD = -1;
    else if (((insC + delC) | 0) > 0) {
      const slackD = (maxD - minTheoD) | 0;
      const bestColumn = netInserts < 0 ? -netInserts : 0;
      stopColumn = (bestColumn + Math.trunc(slackD / ((insC + delC) | 0)) + 1) | 0;
      if (stopColumn > m + 1) stopColumn = m + 1;
    }
  }
  const limited = bounded && maxD >= 0;

  m++;
  n++;
  let prev = new Int32Array(m);
  let curr = new Int32Array(m);
  for (let i = startColumn; i < stopColumn; i++) prev[i] = Math.imul(i, delC);

  for (let j = 1; j < n; j++) {
    const y = t[j - 1]!;
    let i: number;
    // values percolate down the diagonal: widen by one column (read but not used)
    if (stopColumn < m) {
      prev[stopColumn] = (maxD + 1) | 0;
      stopColumn++;
    }
    if (startColumn === 0) {
      curr[0] = Math.imul(j, insC);
      i = 1;
    } else i = startColumn;
    // column i compares source character i - 1
    let x = i - 1;
    for (; i < stopColumn; i++) {
      const ins = (prev[i]! + insC) | 0;
      const del = (curr[i - 1]! + delC) | 0;
      const sub = (prev[i - 1]! + (s[x] === y ? 0 : subC)) | 0;
      curr[i] = Math.min(ins, del, sub);
      x++;
    }
    const temp = curr;
    curr = prev;
    prev = temp;

    if (limited) {
      const zp = j - (n - m);
      while (stopColumn > 0) {
        const ii = stopColumn - 1;
        const net = ii - zp;
        const residual = net > 0 ? Math.imul(net, insC) : Math.imul(-net, delC);
        if (((prev[ii]! + residual) | 0) <= maxD) break;
        stopColumn--;
      }
      while (startColumn < stopColumn) {
        const net = startColumn - zp;
        const residual = net > 0 ? Math.imul(net, insC) : Math.imul(-net, delC);
        if (((prev[startColumn]! + residual) | 0) <= maxD) break;
        prev[startColumn] = (maxD + 1) | 0;
        curr[startColumn] = (maxD + 1) | 0;
        startColumn++;
      }
      if (startColumn >= stopColumn) return (maxD + 1) | 0;
    }
  }
  return prev[m - 1]!;
}

// --- soundex ----------------------------------------------------------------------------------

/*                          ABCDEFGHIJKLMNOPQRSTUVWXYZ */
const SOUNDEX_TABLE = "01230120022455012623010202";

const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const toUpper = (c: number): number => (c >= 0x61 && c <= 0x7a ? c - 0x20 : c);

const utf8 = new TextEncoder();

function soundexCode(letter: number): number {
  const c = toUpper(letter);
  return c >= 0x41 && c <= 0x5a ? SOUNDEX_TABLE.charCodeAt(c - 0x41) : c;
}

/** `_soundex`: four characters, or the empty string when the input has no letter. */
function soundex(input: string): string {
  const bytes = utf8.encode(input);
  let i = 0;
  while (i < bytes.length && !isAlpha(bytes[i]!)) i++;
  if (i >= bytes.length) return "";
  const out: number[] = [toUpper(bytes[i]!)];
  i++;
  while (i < bytes.length && out.length < SOUNDEX_LEN) {
    const c = bytes[i]!;
    if (isAlpha(c) && soundexCode(c) !== soundexCode(bytes[i - 1]!)) {
      const code = soundexCode(c);
      if (code !== 0x30) out.push(code);
    }
    i++;
  }
  while (out.length < SOUNDEX_LEN) out.push(0x30);
  return String.fromCharCode(...out);
}

// --- metaphone --------------------------------------------------------------------------------

/* a  b c  d e f g  h i j k l m n o p q r s t u v w x y z */
const CODES = [1, 16, 4, 16, 9, 2, 4, 16, 9, 2, 0, 2, 2, 2, 1, 4, 0, 2, 4, 4, 1, 0, 0, 0, 8, 0];

function getcode(c: number): number {
  if (!isAlpha(c)) return 0;
  return CODES[toUpper(c) - 0x41]!;
}

/** AEIOU */
const isVowel = (c: number): boolean => (getcode(c) & 1) !== 0;
/** CGPST: form diphthongs when preceding H */
const affectH = (c: number): boolean => (getcode(c) & 4) !== 0;
/** EIY: make C and G soft */
const makeSoft = (c: number): boolean => (getcode(c) & 8) !== 0;
/** BDH: prevent GH from becoming F */
const noGhToF = (c: number): boolean => (getcode(c) & 16) !== 0;

const ch = (c: string): number => c.charCodeAt(0);
const SH = ch("X");
const TH = ch("0");

/** `metaphone(text, int)`: Lawrence Philips' metaphone as contrib/fuzzystrmatch implements it. */
function metaphone(input: string, reqlen: number): string {
  const word = utf8.encode(input);
  if (word.length === 0) return "";
  if (word.length > MAX_METAPHONE_STRLEN) {
    throw pgError(
      "invalid_parameter_value",
      `argument exceeds the maximum length of ${MAX_METAPHONE_STRLEN} bytes`,
      "22023",
    );
  }
  if (reqlen > MAX_METAPHONE_STRLEN) {
    throw pgError(
      "invalid_parameter_value",
      `output exceeds the maximum length of ${MAX_METAPHONE_STRLEN} bytes`,
      "22023",
    );
  }
  if (!(reqlen > 0)) throw pgError("data_exception", "output cannot be empty string", "2200F");

  const at = (i: number): number => (i >= 0 && i < word.length ? word[i]! : 0);
  const out: number[] = [];
  const phonize = (c: number): void => {
    out.push(c);
  };
  let w = 0;
  const curr = (): number => toUpper(at(w));
  const next = (): number => toUpper(at(w + 1));
  const lookBack = (n: number): number => (w >= n ? toUpper(at(w - n)) : 0);
  const prev = (): number => lookBack(1);
  const afterNext = (): number => (next() !== 0 ? toUpper(at(w + 2)) : 0);
  /** `Lookahead`: the letter `howFar` ahead, or the terminating NUL if the word ends first. */
  const lookAhead = (howFar: number): number => {
    let idx = 0;
    while (at(w + idx) !== 0 && idx < howFar) idx++;
    return toUpper(at(w + idx));
  };

  // the first letter is handled specially
  for (; !isAlpha(curr()); w++) {
    if (curr() === 0) return "";
  }
  switch (curr()) {
    case ch("A"):
      if (next() === ch("E")) {
        phonize(ch("E"));
        w += 2;
      } else {
        phonize(ch("A"));
        w++;
      }
      break;
    case ch("G"):
    case ch("K"):
    case ch("P"):
      if (next() === ch("N")) {
        phonize(ch("N"));
        w += 2;
      }
      break;
    case ch("W"):
      if (next() === ch("H") || next() === ch("R")) {
        phonize(next());
        w += 2;
      } else if (isVowel(next())) {
        phonize(ch("W"));
        w += 2;
      }
      break;
    case ch("X"):
      phonize(ch("S"));
      w++;
      break;
    case ch("E"):
    case ch("I"):
    case ch("O"):
    case ch("U"):
      phonize(curr());
      w++;
      break;
    default:
      break;
  }

  for (; curr() !== 0 && out.length < reqlen; w++) {
    let skip = 0;
    const c = curr();
    if (!isAlpha(c)) continue;
    // drop duplicates, except CC
    if (c === prev() && c !== ch("C")) continue;
    switch (c) {
      case ch("B"):
        if (prev() !== ch("M")) phonize(ch("B"));
        break;
      case ch("C"):
        if (makeSoft(next())) {
          if (afterNext() === ch("A") && next() === ch("I")) phonize(SH);
          else if (prev() === ch("S")) {
            // SC[IEY]: dropped
          } else phonize(ch("S"));
        } else if (next() === ch("H")) {
          if (afterNext() === ch("R") || prev() === ch("S")) phonize(ch("K"));
          else phonize(SH);
          skip++;
        } else phonize(ch("K"));
        break;
      case ch("D"):
        if (next() === ch("G") && makeSoft(afterNext())) {
          phonize(ch("J"));
          skip++;
        } else phonize(ch("T"));
        break;
      case ch("G"):
        if (next() === ch("H")) {
          if (!(noGhToF(lookBack(3)) || lookBack(4) === ch("H"))) {
            phonize(ch("F"));
            skip++;
          }
        } else if (next() === ch("N")) {
          const after = afterNext();
          if (!isAlpha(after) || (after === ch("E") && lookAhead(3) === ch("D"))) {
            // dropped
          } else phonize(ch("K"));
        } else if (makeSoft(next()) && prev() !== ch("G")) phonize(ch("J"));
        else phonize(ch("K"));
        break;
      case ch("H"):
        if (isVowel(next()) && !affectH(prev())) phonize(ch("H"));
        break;
      case ch("K"):
        if (prev() !== ch("C")) phonize(ch("K"));
        break;
      case ch("P"):
        phonize(next() === ch("H") ? ch("F") : ch("P"));
        break;
      case ch("Q"):
        phonize(ch("K"));
        break;
      case ch("S"):
        if (next() === ch("I") && (afterNext() === ch("O") || afterNext() === ch("A"))) phonize(SH);
        else if (next() === ch("H")) {
          phonize(SH);
          skip++;
        } else if (next() === ch("C") && lookAhead(2) === ch("H") && lookAhead(3) === ch("W")) {
          phonize(SH);
          skip += 2;
        } else phonize(ch("S"));
        break;
      case ch("T"):
        if (next() === ch("I") && (afterNext() === ch("O") || afterNext() === ch("A"))) phonize(SH);
        else if (next() === ch("H")) {
          phonize(TH);
          skip++;
        } else phonize(ch("T"));
        break;
      case ch("V"):
        phonize(ch("F"));
        break;
      case ch("W"):
        if (isVowel(next())) phonize(ch("W"));
        break;
      case ch("X"):
        phonize(ch("K"));
        if (out.length < reqlen) phonize(ch("S"));
        break;
      case ch("Y"):
        if (isVowel(next())) phonize(ch("Y"));
        break;
      case ch("Z"):
        phonize(ch("S"));
        break;
      case ch("F"):
      case ch("J"):
      case ch("L"):
      case ch("M"):
      case ch("N"):
      case ch("R"):
        phonize(c);
        break;
      default:
        break;
    }
    w += skip;
  }
  return String.fromCharCode(...out);
}
