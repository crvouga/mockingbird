import { type Token, tokenize } from "../lexer/tokenize.ts";

const isName = (token: Token | undefined): boolean => token?.type === "ident" || token?.type === "quoted_ident";
const RESERVED_AFTER_TARGET = new Set(["set", "using", "where", "returning"]);

/**
 * Row-lock probe for UPDATE / DELETE: the SELECT that finds the target rows the statement is about to
 * write, so the wire layer can take their row locks first. The alias has to survive (`UPDATE t AS ap`
 * is probed with `FROM t AS ap`, or `ap.column` in WHERE is unknown), and so do the `FROM` / `USING`
 * items (`UPDATE a SET v = b.v FROM b WHERE a.id = b.id`), or a WHERE that names them cannot resolve.
 * Null when the statement is not a plain UPDATE / DELETE the probe understands.
 */
export const lockedMutationQuery = (statement: string): string | null => {
  const sql = statement.replace(/[\s;]+$/, "");
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return null;
  }
  const verb = tokens[0]?.type === "ident" ? tokens[0].value : "";
  if (verb !== "update" && verb !== "delete") return null;

  let at = 1;
  if (verb === "delete") {
    if (tokens[at]?.value !== "from") return null;
    at++;
  }
  // relation: name or schema.name
  const relationStart = at;
  if (!isName(tokens[at])) return null;
  at++;
  if (tokens[at]?.value === "." && isName(tokens[at + 1])) at += 2;
  const relationEnd = at;
  let aliasStart = -1;
  if (tokens[at]?.type === "ident" && tokens[at]?.value === "as" && isName(tokens[at + 1])) {
    aliasStart = at + 1;
    at += 2;
  } else if (isName(tokens[at]) && !(tokens[at]?.type === "ident" && RESERVED_AFTER_TARGET.has(tokens[at]!.value))) {
    aliasStart = at;
    at++;
  }
  const textOf = (from: Token, to: Token | undefined): string => sql.slice(from.pos, to?.pos ?? sql.length).trim();
  const relation = textOf(tokens[relationStart]!, tokens[relationEnd]);
  const alias = aliasStart < 0 ? undefined : textOf(tokens[aliasStart]!, tokens[aliasStart + 1]);

  // top-level clause keywords after the target
  const joinKeyword = verb === "update" ? "from" : "using";
  let depth = 0;
  let setAt = -1;
  let joinAt = -1;
  let whereAt = -1;
  let endAt = tokens.length - 1; // the eof token
  for (let i = at; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "punct" && (token.value === "(" || token.value === "[")) depth++;
    else if (token.type === "punct" && (token.value === ")" || token.value === "]")) depth--;
    else if (token.type === "eof") break;
    else if (depth === 0 && token.type === "ident") {
      if (token.value === "set" && verb === "update" && setAt < 0) setAt = i;
      else if (token.value === joinKeyword && joinAt < 0 && whereAt < 0 && (verb === "delete" || setAt >= 0)) {
        // `a IS DISTINCT FROM b` inside the SET list is not the FROM clause
        if (tokens[i - 1]?.value !== "distinct") joinAt = i;
      } else if (token.value === "where" && whereAt < 0 && (verb === "delete" || setAt >= 0)) whereAt = i;
      else if (token.value === "returning" && (verb === "delete" || setAt >= 0)) {
        endAt = i;
        break;
      }
    }
  }
  if (verb === "update" && setAt < 0) return null;
  const whereEnd = tokens[endAt];
  const where = whereAt < 0 ? undefined : textOf(tokens[whereAt + 1]!, whereEnd);
  const joinEnd = whereAt >= 0 ? tokens[whereAt] : whereEnd;
  const joined = joinAt < 0 ? undefined : textOf(tokens[joinAt + 1]!, joinEnd);

  const target = alias ? `${relation} AS ${alias}` : relation;
  const items = joined ? `${target}, ${joined}` : target;
  // only the target's columns: the lock identity is the target row, not a joined one
  const select = joined ? `${alias ?? relation}.*` : "*";
  return `SELECT ${select} FROM ${items}${where ? ` WHERE ${where}` : ""}`;
};
