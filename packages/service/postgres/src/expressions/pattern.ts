import { pgError } from "../errors/error.ts";

/** LIKE pattern → anchored RegExp source. */
export function likeToRegex(pattern: string, escape: string | null): string {
  const esc = escape === null ? "\\" : escape;
  if (esc.length > 1) throw pgError("invalid_parameter_value", "invalid escape string", "22025");
  let out = "^";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (esc !== "" && c === esc) {
      const next = chars[i + 1];
      if (next === undefined) {
        throw pgError("invalid_parameter_value", "LIKE pattern must not end with escape character", "22025");
      }
      out += escapeRegexChar(next);
      i++;
      continue;
    }
    if (c === "%") {
      out += "[\\s\\S]*";
      continue;
    }
    if (c === "_") {
      out += "[\\s\\S]";
      continue;
    }
    out += escapeRegexChar(c);
  }
  return `${out}$`;
}

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

export function likeMatch(text: string, pattern: string, escape: string | null, caseInsensitive: boolean): boolean {
  const re = new RegExp(likeToRegex(pattern, escape), caseInsensitive ? "is" : "s");
  return re.test(text);
}

/** SIMILAR TO pattern → anchored RegExp source (SQL regex dialect). */
export function similarToRegex(pattern: string, escape: string | null): string {
  const esc = escape === null ? "\\" : escape;
  let out = "^(?:";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (esc !== "" && c === esc) {
      const next = chars[i + 1];
      if (next === undefined) {
        throw pgError(
          "invalid_regular_expression",
          "invalid regular expression: pattern must not end with escape character",
          "2201B",
        );
      }
      out += escapeRegexChar(next);
      i++;
      continue;
    }
    if (c === "%") {
      out += "[\\s\\S]*";
      continue;
    }
    if (c === "_") {
      out += "[\\s\\S]";
      continue;
    }
    // pass through SQL regex metacharacters
    if ("|*+?{}()[]".includes(c)) {
      out += c;
      continue;
    }
    out += escapeRegexChar(c);
  }
  return `${out})$`;
}

export function similarToMatch(text: string, pattern: string, escape: string | null): boolean {
  let re: RegExp;
  try {
    re = new RegExp(similarToRegex(pattern, escape), "s");
  } catch {
    throw pgError("invalid_regular_expression", "invalid regular expression", "2201B");
  }
  return re.test(text);
}

/**
 * Translate a POSIX ARE (PG regex flavor) to a JS RegExp source.
 * Covers the common surface: classes, quantifiers, anchors, \m/\M/\y word
 * boundaries, [[:class:]] names. Exotic ARE features (\A directors, back
 * refs into lookahead) are passed through and may diverge (documented).
 */
export function pgRegexToJs(pattern: string): string {
  let out = "";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\\") {
      const next = chars[i + 1];
      i++;
      switch (next) {
        case "m":
          out += "\\b(?=\\w)";
          break;
        case "M":
          out += "\\b(?<=\\w)";
          break;
        case "y":
          out += "\\b";
          break;
        case "Y":
          out += "\\B";
          break;
        case "A":
          out += "^";
          break;
        case "Z":
          out += "$";
          break;
        case undefined:
          throw pgError(
            "invalid_regular_expression",
            "invalid regular expression: invalid escape \\ sequence",
            "2201B",
          );
        default:
          out += `\\${next}`;
      }
      continue;
    }
    if (c === "[") {
      // character class — translate [[:name:]] inside
      let cls = "[";
      let j = i + 1;
      if (chars[j] === "^") {
        cls += "^";
        j++;
      }
      if (chars[j] === "]") {
        cls += "\\]";
        j++;
      }
      for (; j < chars.length; j++) {
        const cc = chars[j]!;
        if (cc === "[" && chars[j + 1] === ":") {
          const end = pattern.indexOf(":]", j);
          if (end === -1)
            throw pgError(
              "invalid_regular_expression",
              "invalid regular expression: brackets [] not balanced",
              "2201B",
            );
          const name = pattern.slice(j + 2, end);
          cls += posixClass(name);
          j = end + 1;
          continue;
        }
        if (cc === "]") break;
        if (cc === "\\") {
          cls += "\\\\";
          continue;
        }
        cls += cc;
      }
      if (chars[j] !== "]") {
        throw pgError("invalid_regular_expression", "invalid regular expression: brackets [] not balanced", "2201B");
      }
      cls += "]";
      out += cls;
      i = j;
      continue;
    }
    if (
      c === "(" &&
      chars[i + 1] === "?" &&
      chars[i + 2] !== ":" &&
      chars[i + 2] !== "=" &&
      chars[i + 2] !== "!" &&
      chars[i + 2] !== "<"
    ) {
      // inline options like (?i) — JS lacks these; approximate by ignoring
      const close = pattern.indexOf(")", i);
      if (close !== -1 && /^\(\?[a-z]+\)$/.test(pattern.slice(i, close + 1))) {
        i = close;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function posixClass(name: string): string {
  switch (name) {
    case "alpha":
      return "a-zA-Z";
    case "digit":
      return "0-9";
    case "alnum":
      return "a-zA-Z0-9";
    case "upper":
      return "A-Z";
    case "lower":
      return "a-z";
    case "space":
      return " \\t\\n\\r\\f\\v";
    case "punct":
      return "!-/:-@\\[-`{-~";
    case "word":
      return "a-zA-Z0-9_";
    case "xdigit":
      return "0-9a-fA-F";
    case "blank":
      return " \\t";
    case "cntrl":
      return "\\x00-\\x1f\\x7f";
    case "graph":
      return "\\x21-\\x7e";
    case "print":
      return "\\x20-\\x7e";
    default:
      throw pgError("invalid_regular_expression", `invalid regular expression: invalid character class`, "2201B");
  }
}

export function pgRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pgRegexToJs(pattern), flags);
  } catch (e) {
    if (e instanceof Error && e.name === "PostgresError") throw e;
    throw pgError("invalid_regular_expression", `invalid regular expression: ${(e as Error).message}`, "2201B");
  }
}

export function regexMatch(text: string, pattern: string, caseInsensitive: boolean): boolean {
  return pgRegex(pattern, caseInsensitive ? "is" : "s").test(text);
}

/**
 * Translate PG regex option letters to JS RegExp flags. PG default is
 * newline-insensitive (JS `s`); `n`/`m` switch to newline-sensitive (`m`).
 */
export function regexFlags(pgFlags: string, dropGlobal = false): string {
  let insensitive = false;
  let global = false;
  let newlineSensitive = false;
  for (const f of pgFlags) {
    switch (f) {
      case "i":
        insensitive = true;
        break;
      case "c":
        insensitive = false;
        break;
      case "g":
        global = true;
        break;
      case "n":
      case "m":
      case "p":
        newlineSensitive = true;
        break;
      case "s":
        newlineSensitive = false;
        break;
      case "w":
        newlineSensitive = true;
        break;
      case "x":
      case "q":
      case "t":
      case "b":
      case "e":
        throw pgError("feature_not_supported", `regexp option "${f}" is not supported`, "0A000");
      default:
        throw pgError("invalid_regular_expression", `invalid regular expression option: "${f}"`, "2201B");
    }
  }
  let out = "";
  if (insensitive) out += "i";
  if (global && !dropGlobal) out += "g";
  out += newlineSensitive ? "m" : "s";
  return out;
}
