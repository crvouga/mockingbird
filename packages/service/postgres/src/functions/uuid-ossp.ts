/**
 * contrib/uuid-ossp, installed by `CREATE EXTENSION "uuid-ossp"`. Name-based UUIDs (v3 / v5) and
 * the namespace constants are exact; random and time-based ones draw on the engine PRNG and clock,
 * so they are deterministic per seed like gen_random_uuid().
 */
import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { type TypedValue, type TypeId, tv } from "../types/value.ts";
import { digestBytes, randomBytes } from "./pgcrypto.ts";

/** Marks functions installed by `CREATE EXTENSION "uuid-ossp"` (survives PGMM). */
export const UUID_OSSP_BODY = "uuid-ossp";

const NAMESPACES: Record<string, string> = {
  uuid_ns_dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  uuid_ns_url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  uuid_ns_oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  uuid_ns_x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
};

const FUNCTIONS: ReadonlyArray<{ name: string; args: TypeId[]; volatility?: "immutable" }> = [
  { name: "uuid_nil", args: [], volatility: "immutable" },
  { name: "uuid_ns_dns", args: [], volatility: "immutable" },
  { name: "uuid_ns_url", args: [], volatility: "immutable" },
  { name: "uuid_ns_oid", args: [], volatility: "immutable" },
  { name: "uuid_ns_x500", args: [], volatility: "immutable" },
  { name: "uuid_generate_v1", args: [] },
  { name: "uuid_generate_v1mc", args: [] },
  { name: "uuid_generate_v3", args: ["uuid", "text"], volatility: "immutable" },
  { name: "uuid_generate_v4", args: [] },
  { name: "uuid_generate_v5", args: ["uuid", "text"], volatility: "immutable" },
];

export function installUuidOssp(state: DatabaseState, schemaName: string): void {
  const schema = state.getSchema(schemaName);
  for (const spec of FUNCTIONS) {
    const fn: FunctionData = {
      name: spec.name,
      schema: schema.name,
      argNames: spec.args.length === 0 ? [] : ["namespace", "name"],
      argTypes: [...spec.args],
      argDefaults: spec.args.map(() => null),
      returns: "uuid",
      returnsSet: false,
      returnsTable: null,
      language: "internal",
      body: null,
      rawBody: UUID_OSSP_BODY,
      strict: true,
      oid: state.nextOid(),
      ...(spec.volatility ? { volatility: spec.volatility } : {}),
    };
    schema.functions.set(spec.name, [...(schema.functions.get(spec.name) ?? []), fn]);
  }
}

export function uninstallUuidOssp(state: DatabaseState): void {
  for (const schema of state.schemas.values()) {
    for (const [name, fns] of [...schema.functions.entries()]) {
      const keep = fns.filter((fn) => fn.language !== "internal" || fn.rawBody !== UUID_OSSP_BODY);
      if (keep.length === fns.length) continue;
      if (keep.length === 0) schema.functions.delete(name);
      else schema.functions.set(name, keep);
    }
  }
}

function uuidBytes(text: string): Uint8Array {
  const hex = text.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uuidText(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stamp the version nibble and the RFC 4122 variant bits. */
function stamp(bytes: Uint8Array, version: number): string {
  bytes[6] = (bytes[6]! & 0x0f) | (version << 4);
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return uuidText(bytes);
}

/** 100-nanosecond intervals since 1582-10-15 (the Gregorian reform), from the engine clock. */
const GREGORIAN_OFFSET_100NS = 0x01b21dd213814000n;

function timeBased(ctx: EngineCtx): string {
  const unixMicros = ctx.clockNow() - UNIX_EPOCH_MICROS_FROM_PG;
  const ts = unixMicros * 10n + GREGORIAN_OFFSET_100NS;
  const random = randomBytes(ctx, 8);
  const bytes = new Uint8Array(16);
  const timeLow = Number(ts & 0xffffffffn);
  const timeMid = Number((ts >> 32n) & 0xffffn);
  const timeHi = Number((ts >> 48n) & 0x0fffn);
  bytes[0] = timeLow >>> 24;
  bytes[1] = (timeLow >>> 16) & 0xff;
  bytes[2] = (timeLow >>> 8) & 0xff;
  bytes[3] = timeLow & 0xff;
  bytes[4] = timeMid >>> 8;
  bytes[5] = timeMid & 0xff;
  bytes[6] = timeHi >>> 8;
  bytes[7] = timeHi & 0xff;
  // clock sequence and node: random, the node with the multicast bit set (RFC 4122 4.5) since
  // the engine has no network card to read a MAC address from
  bytes.set(random, 8);
  bytes[10] = bytes[10]! | 0x01;
  return stamp(bytes, 1);
}

export function evalUuidOsspFunction(ctx: EngineCtx, fn: FunctionData, args: TypedValue[]): TypedValue {
  if (fn.strict && args.some((arg) => arg.v === null)) return tv("uuid", null);
  const namespace = NAMESPACES[fn.name];
  if (namespace) return tv("uuid", namespace);
  switch (fn.name) {
    case "uuid_nil":
      return tv("uuid", "00000000-0000-0000-0000-000000000000");
    case "uuid_generate_v1":
    case "uuid_generate_v1mc":
      return tv("uuid", timeBased(ctx));
    case "uuid_generate_v4":
      return tv("uuid", ctx.state.prng.nextUuid4());
    case "uuid_generate_v3":
    case "uuid_generate_v5": {
      const ns = uuidBytes(castTo(ctx, args[0]!, "uuid", {}).v as string);
      const name = new TextEncoder().encode(castTo(ctx, args[1]!, "text", {}).v as string);
      const data = new Uint8Array(16 + name.length);
      data.set(ns);
      data.set(name, 16);
      const v5 = fn.name === "uuid_generate_v5";
      return tv("uuid", stamp(digestBytes(data, v5 ? "sha1" : "md5").slice(0, 16), v5 ? 5 : 3));
    }
    default:
      throw pgError("undefined_function", `function ${fn.schema}.${fn.name} is not implemented`, "42883");
  }
}
