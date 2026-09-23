import type { FtsTokenizerConfig } from "./options.ts";
import { porterStem } from "./porter.ts";

export interface FtsToken {
  /** Normalized token text stored in the index. */
  term: string;
  /** Byte offset of the token in the UTF-8 encoding of the source. */
  start: number;
  /** Byte length in UTF-8. */
  length: number;
  /** Token position (0-based) within the column. */
  position: number;
  /** Original end offset in JS string code units (for highlight). */
  startUnit: number;
  endUnit: number;
}

export type TokenizerFn = (text: string) => FtsToken[];

export function createTokenizer(config: FtsTokenizerConfig): TokenizerFn {
  if (config.name === "porter") {
    const base = createTokenizer({
      name: config.base === "ascii" ? "ascii" : "unicode61",
      removeDiacritics: config.removeDiacritics ?? 1,
      tokenchars: config.tokenchars,
      separators: config.separators,
    });
    return (text) =>
      base(text).map((token) => ({
        ...token,
        term: porterStem(token.term),
      }));
  }
  if (config.name === "trigram") return createTrigramTokenizer(config);
  if (config.name === "ascii") return createAsciiTokenizer(config);
  return createUnicode61Tokenizer(config);
}

function createAsciiTokenizer(config: FtsTokenizerConfig): TokenizerFn {
  const tokenChar = defaultAsciiTokenChar();
  for (const ch of config.tokenchars ?? "") {
    const code = ch.charCodeAt(0);
    if (code < 128) tokenChar[code] = 1;
  }
  for (const ch of config.separators ?? "") {
    const code = ch.charCodeAt(0);
    if (code < 128) tokenChar[code] = 0;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (text: string) => {
    const bytes = encoder.encode(text);
    const tokens: FtsToken[] = [];
    let is = 0;
    let pos = 0;
    while (is < bytes.length) {
      while (is < bytes.length && (bytes[is]! & 0x80) === 0 && tokenChar[bytes[is]!] === 0) is++;
      if (is >= bytes.length) break;
      let ie = is + 1;
      while (ie < bytes.length && ((bytes[ie]! & 0x80) !== 0 || tokenChar[bytes[ie]!] === 1)) ie++;
      const raw = bytes.slice(is, ie);
      const folded = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i]!;
        folded[i] = c >= 65 && c <= 90 ? c + 32 : c;
      }
      const term = decoder.decode(folded);
      tokens.push({
        term,
        start: is,
        length: ie - is,
        position: pos++,
        startUnit: utf16Offset(text, is),
        endUnit: utf16Offset(text, ie),
      });
      is = ie + 1;
    }
    return tokens;
  };
}

function defaultAsciiTokenChar(): Uint8Array {
  const a = new Uint8Array(128);
  for (let i = 48; i <= 57; i++) a[i] = 1;
  for (let i = 65; i <= 90; i++) a[i] = 1;
  for (let i = 97; i <= 122; i++) a[i] = 1;
  return a;
}

function utf16Offset(text: string, byteOffset: number): number {
  let units = 0;
  let b = 0;
  for (const ch of text) {
    if (b >= byteOffset) break;
    b += new TextEncoder().encode(ch).length;
    units += ch.length;
  }
  return units;
}

function createUnicode61Tokenizer(config: FtsTokenizerConfig): TokenizerFn {
  const removeDiacritics = config.removeDiacritics ?? 1;
  const extraToken = new Set([...(config.tokenchars ?? "")].map((c) => c));
  const extraSep = new Set([...(config.separators ?? "")].map((c) => c));
  return (text: string) => {
    const tokens: FtsToken[] = [];
    let i = 0;
    let pos = 0;
    while (i < text.length) {
      while (i < text.length && !isUnicodeTokenChar(text[i]!, extraToken, extraSep)) i++;
      if (i >= text.length) break;
      const startUnit = i;
      while (i < text.length && isUnicodeTokenChar(text[i]!, extraToken, extraSep)) i++;
      let raw = text.slice(startUnit, i);
      if (removeDiacritics > 0) raw = stripDiacritics(raw, removeDiacritics);
      const term = raw.toLowerCase();
      if (term.length === 0) continue;
      tokens.push({
        term,
        start: utf8Offset(text, startUnit),
        length: utf8Length(text.slice(startUnit, i)),
        position: pos++,
        startUnit,
        endUnit: i,
      });
    }
    return tokens;
  };
}

function createTrigramTokenizer(config: FtsTokenizerConfig): TokenizerFn {
  const caseSensitive = config.caseSensitive ?? false;
  const removeDia = config.removeDiacriticsTrigram ?? false;
  return (text: string) => {
    let source = text;
    if (removeDia) source = stripDiacritics(source, 1);
    if (!caseSensitive) source = source.toLowerCase();
    const tokens: FtsToken[] = [];
    if (source.length < 3) return tokens;
    let pos = 0;
    for (let i = 0; i <= source.length - 3; i++) {
      const term = source.slice(i, i + 3);
      tokens.push({
        term,
        start: utf8Offset(source, i),
        length: utf8Length(term),
        position: pos++,
        startUnit: i,
        endUnit: i + 3,
      });
    }
    return tokens;
  };
}

function isUnicodeTokenChar(ch: string, extraToken: Set<string>, extraSep: Set<string>): boolean {
  if (extraSep.has(ch)) return false;
  if (extraToken.has(ch)) return true;
  // Letters, marks (combining), numbers — exclude punctuation/symbols/emoji
  return /\p{L}|\p{M}|\p{N}/u.test(ch);
}

function stripDiacritics(text: string, mode: 0 | 1 | 2): string {
  if (mode === 0) return text;
  // NFD then strip combining marks. Mode 2 also folds a few special cases similarly.
  const normalized = text.normalize("NFD");
  let out = "";
  for (const ch of normalized) {
    if (/\p{M}/u.test(ch)) continue;
    out += ch;
  }
  return out;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function utf8Offset(text: string, unitIndex: number): number {
  return new TextEncoder().encode(text.slice(0, unitIndex)).length;
}

/** Legacy helper used by older call sites — simple alphanum split. */
export function tokenizeFtsText(text: string): string[] {
  return createUnicode61Tokenizer({ name: "unicode61", removeDiacritics: 1 })(text).map((t) => t.term);
}
