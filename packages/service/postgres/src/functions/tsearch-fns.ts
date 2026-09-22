import { pgError } from "../errors/error.ts";
import {
  parseTsvector,
  phrasetoTsquery,
  plaintoTsquery,
  toTsquery,
  toTsvector,
  tsHeadline,
  tsRank,
  tsvectorLength,
  tsvectorMatches,
  tsvectorSetweight,
  tsvectorStrip,
} from "../tsearch/tsearch.ts";
import { castTo } from "../types/cast.ts";
import { type PgArray, tv } from "../types/value.ts";
import { argText, type ScalarFn, strict } from "./util.ts";

export function getTsearchFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set(
    "to_tsvector",
    strict("tsvector", (ctx, args) => {
      const config = args.length > 1 ? argText(ctx, args[0]!) : "english";
      const text = argText(ctx, args[args.length - 1]!);
      return tv("tsvector", toTsvector(config, text));
    }),
  );
  m.set(
    "to_tsquery",
    strict("tsquery", (ctx, args) => {
      const config = args.length > 1 ? argText(ctx, args[0]!) : "english";
      const text = argText(ctx, args[args.length - 1]!);
      return tv("tsquery", toTsquery(config, text));
    }),
  );
  m.set(
    "plainto_tsquery",
    strict("tsquery", (ctx, args) => {
      const config = args.length > 1 ? argText(ctx, args[0]!) : "english";
      const text = argText(ctx, args[args.length - 1]!);
      return tv("tsquery", plaintoTsquery(config, text));
    }),
  );
  m.set(
    "phraseto_tsquery",
    strict("tsquery", (ctx, args) => {
      const config = args.length > 1 ? argText(ctx, args[0]!) : "english";
      const text = argText(ctx, args[args.length - 1]!);
      return tv("tsquery", phrasetoTsquery(config, text));
    }),
  );
  m.set(
    "ts_rank",
    strict("float4", (ctx, args) => {
      // signatures: (v, q) | (w, v, q) | (v, q, norm) | (w, v, q, norm)
      let i = 0;
      let weights: number[] | undefined;
      if (args[0]!.t === "float4[]" || args[0]!.t === "float8[]" || args[0]!.t === "numeric[]") {
        const arr = castTo(ctx, args[0]!, "float4[]", { explicit: true }).v as PgArray;
        if (arr.items.length < 4) {
          throw pgError("array_subscript_error", "array of weight is too short", "2202E");
        }
        weights = arr.items.map((x) => {
          if (x === null) throw pgError("null_value_not_allowed", "array of weight must not contain nulls", "22004");
          return x as number;
        });
        i = 1;
      }
      const vec = castTo(ctx, args[i]!, "tsvector", { explicit: true }).v as string;
      const query = castTo(ctx, args[i + 1]!, "tsquery", { explicit: true }).v as string;
      const norm = args.length > i + 2 ? (castTo(ctx, args[i + 2]!, "int4", { explicit: true }).v as number) : 0;
      return tv("float4", tsRank(vec, query, weights, norm));
    }),
  );
  m.set("ts_rank_cd", m.get("ts_rank")!);
  m.set(
    "ts_headline",
    strict("text", (ctx, args) => {
      // ts_headline([config,] document, query [, options])
      let i = 0;
      let config = "english";
      const configForm = args.length === 4 || (args.length === 3 && args[2]!.t === "tsquery");
      if (configForm) {
        config = argText(ctx, args[0]!);
        i = 1;
      }
      const document = argText(ctx, args[i]!);
      const query = castTo(ctx, args[i + 1]!, "tsquery", { explicit: true }).v as string;
      const options = args.length > i + 2 ? argText(ctx, args[i + 2]!) : undefined;
      return tv("text", tsHeadline(config, document, query, options));
    }),
  );
  m.set(
    "setweight",
    strict("tsvector", (ctx, args) => {
      const vec = castTo(ctx, args[0]!, "tsvector", { explicit: true }).v as string;
      const w = argText(ctx, args[1]!);
      return tv("tsvector", tsvectorSetweight(vec, w));
    }),
  );
  m.set(
    "strip",
    strict("tsvector", (ctx, args) => {
      const vec = castTo(ctx, args[0]!, "tsvector", { explicit: true }).v as string;
      return tv("tsvector", tsvectorStrip(vec));
    }),
  );
  m.set(
    "numnode",
    strict("int4", (ctx, args) => {
      const q = castTo(ctx, args[0]!, "tsquery", { explicit: true }).v as string;
      // count lexemes + operators in canonical text
      let count = 0;
      const re = /'(?:[^']|'')*'|[&|!]|<\d+>|<->/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(q)) !== null) {
        void match;
        count++;
      }
      return tv("int4", count);
    }),
  );
  m.set(
    "ts_match_vq",
    strict("bool", (ctx, args) => {
      const vec = castTo(ctx, args[0]!, "tsvector", { explicit: true }).v as string;
      const query = castTo(ctx, args[1]!, "tsquery", { explicit: true }).v as string;
      return tv("bool", tsvectorMatches(vec, query));
    }),
  );
  m.set(
    "tsvector_in_check",
    strict("tsvector", (ctx, args) => tv("tsvector", parseTsvector(argText(ctx, args[0]!)))),
  );
  m.set(
    "tsvector_length",
    strict("int4", (ctx, args) => {
      const vec = castTo(ctx, args[0]!, "tsvector", { explicit: true }).v as string;
      return tv("int4", tsvectorLength(vec));
    }),
  );

  return m;
}
