import type { CallStmt, DropStmt, Expr, FuncCall, TypeName } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { hasScalarFunction } from "../functions/scalar.ts";
import type { DatabaseState, FunctionData } from "../storage/database-state.ts";
import { canImplicitCast, castTo } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import { type Datum, type TypedValue, typeDisplayName } from "../types/value.ts";
import { beginSubtransaction, callPlpgsqlProcedure } from "./plpgsql.ts";
import { closeStatementPortals } from "./portals.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";
import { evalScalar, runFunctionBody, withFunctionSettings } from "./select.ts";
import { txManagerFor } from "./session.ts";

/**
 * Procedures: `CALL`, the transaction control (`COMMIT` / `ROLLBACK`) PL/pgSQL procedures and `DO`
 * blocks may run, and the atomic / non-atomic execution context PostgreSQL decides it by.
 *
 * A `CALL` (or `DO`) issued at top level outside a transaction block runs non-atomically: its body
 * may commit or roll back, which ends the work done so far and starts a new transaction, and a
 * later error only takes back what came after the last COMMIT. Nested `CALL`s of a non-atomic
 * procedure stay non-atomic. Anything run from a function, a procedure with a `SET` clause, or a
 * `CALL` inside a transaction block is atomic, and COMMIT / ROLLBACK there is `2D000`.
 */

/** Ends and restarts the transaction a non-atomic CALL / DO runs in. */
export interface TxControl {
  commit(): void;
  rollback(): void;
  /** EXCEPTION blocks (subtransactions) currently running; COMMIT / ROLLBACK refuse while any is */
  subtransactions: number;
}

interface TxFrame {
  /** null: atomic */
  ctl: TxControl | null;
  /** running inside a function (statements there are mid-way through the caller's statement) */
  inFunction: boolean;
}

const frames: TxFrame[] = [];

/** The innermost execution context; undefined at top level (no routine running). */
export function currentTxFrame(): TxFrame | undefined {
  return frames[frames.length - 1];
}

function withFrame<T>(frame: TxFrame, run: () => T): T {
  frames.push(frame);
  try {
    return run();
  } finally {
    frames.pop();
  }
}

/** Run a function body: atomic, so COMMIT / ROLLBACK (also of procedures it calls) is refused. */
export function atomicFunctionContext<T>(run: () => T): T {
  return withFrame({ ctl: null, inFunction: true }, run);
}

/**
 * Statements the wire server wraps in a transaction of its own (autocommit) are still top level for
 * a CALL / DO: their COMMIT ends that transaction and starts the next one.
 */
const implicitTransactions = new WeakSet<DatabaseState>();

export function runInImplicitTransaction<T>(state: DatabaseState, run: () => T): T {
  if (implicitTransactions.has(state)) return run();
  implicitTransactions.add(state);
  try {
    return run();
  } finally {
    implicitTransactions.delete(state);
  }
}

/**
 * Run a CALL'd procedure body or a DO block in the right context. `atomicOnly` (a procedure with
 * SET clauses) forces an atomic context. At top level the whole run is statement-atomic: an error
 * takes back what it wrote since its last COMMIT.
 */
export function runRoutine<T>(env: ExecEnv, atomicOnly: boolean, run: (frame: TxFrame) => T): T {
  const parent = currentTxFrame();
  if (parent !== undefined) {
    const frame = { ctl: atomicOnly ? null : parent.ctl, inFunction: parent.inFunction };
    return withFrame(frame, () => run(frame));
  }
  const state = env.ctx.state;
  const tx = txManagerFor(state);
  const explicitBlock = tx.inTransaction && !implicitTransactions.has(state);
  if (explicitBlock || atomicOnly || !tx.inTransaction) {
    let unit = beginSubtransaction(env);
    const ctl: TxControl | null =
      explicitBlock || atomicOnly
        ? null
        : {
            subtransactions: 0,
            commit: () => {
              unit.release();
              closeStatementPortals(state);
              unit = beginSubtransaction(env);
            },
            rollback: () => {
              unit.rollback();
              closeStatementPortals(state);
              unit = beginSubtransaction(env);
            },
          };
    const frame = { ctl, inFunction: false };
    let value: T;
    try {
      value = withFrame(frame, () => run(frame));
    } catch (e) {
      unit.rollback();
      throw e;
    }
    unit.release();
    return value;
  }
  // a transaction the wire server opened for this one statement: commit it and open the next
  const ctl: TxControl = {
    subtransactions: 0,
    commit: () => {
      tx.commit();
      tx.begin();
    },
    rollback: () => {
      tx.rollback();
      tx.begin();
    },
  };
  const frame = { ctl, inFunction: false };
  return withFrame(frame, () => run(frame));
}

/** PL/pgSQL `COMMIT` / `ROLLBACK`. */
export function transactionControl(action: "commit" | "rollback"): void {
  const ctl = currentTxFrame()?.ctl ?? null;
  if (ctl === null) throw pgError("transaction_state", "invalid transaction termination", "2D000");
  if (ctl.subtransactions > 0) {
    throw pgError(
      "transaction_state",
      `cannot ${action === "commit" ? "commit" : "roll back"} while a subtransaction is active`,
      "2D000",
    );
  }
  if (action === "commit") ctl.commit();
  else ctl.rollback();
}

// ---------------------------------------------------------------------------
// CALL
// ---------------------------------------------------------------------------

function signature(name: string[], args: TypedValue[]): string {
  return `${name.join(".")}(${args.map((a) => typeDisplayName(a.t)).join(", ")})`;
}

/** Lay `args` out over `fn`'s parameters (positional, named or mixed); null when they do not fit. */
function bindArgs(
  env: ExecEnv,
  fn: FunctionData,
  args: TypedValue[],
  argNames: readonly (string | null)[] | undefined,
): { values: TypedValue[]; sources: number[] } | null {
  const n = fn.argTypes.length;
  if (args.length > n) return null;
  const slots: Array<number | undefined> = new Array(n).fill(undefined);
  for (let i = 0; i < args.length; i++) {
    const name = argNames?.[i] ?? null;
    const idx = name === null ? i : fn.argNames.indexOf(name);
    if (idx < 0 || slots[idx] !== undefined || !canImplicitCast(args[i]!.t, fn.argTypes[idx]!)) return null;
    slots[idx] = i;
  }
  if (slots.some((s, i) => s === undefined && !fn.argDefaults[i])) return null;
  const values = slots.map((s, i) =>
    castTo(env.ctx, s === undefined ? evalScalar(env, null, fn.argDefaults[i]!) : args[s]!, fn.argTypes[i]!, {}),
  );
  return { values, sources: slots.map((s) => s ?? -1) };
}

/** A procedure resolved for a CALL: its bound arguments and which call argument fed each parameter (-1: a default). */
export interface BoundCall {
  fn: FunctionData;
  args: TypedValue[];
  sources: number[];
}

export function bindCall(env: ExecEnv, call: FuncCall): BoundCall {
  const args = call.args.map((a) => evalScalar(env, env.outer, a));
  const candidates = env.ctx.state.findFunctions(call.name);
  for (const fn of candidates) {
    if (fn.kind !== "p") continue;
    const bound = bindArgs(env, fn, args, call.argNames);
    if (bound) return { fn, args: bound.values, sources: bound.sources };
  }
  const isFunction =
    candidates.some((fn) => fn.kind !== "p" && bindArgs(env, fn, args, call.argNames) !== null) ||
    (call.name.length === 1 || call.name[0] === "pg_catalog"
      ? hasScalarFunction(call.name[call.name.length - 1]!)
      : false);
  if (isFunction) {
    throw pgError("wrong_object_type", `${signature(call.name, args)} is not a procedure`, "42809");
  }
  throw pgError("undefined_function", `procedure ${signature(call.name, args)} does not exist`, "42883");
}

/** The OUT / INOUT parameters' values after running `bound`; null when the procedure has none. */
export function invokeProcedure(env: ExecEnv, bound: BoundCall): Datum[] | null {
  const { fn, args } = bound;
  const atomicOnly = Object.keys(fn.settings ?? {}).length > 0;
  return withFunctionSettings(env, fn, () =>
    runRoutine(env, atomicOnly, (frame) => {
      if (fn.language === "plpgsql") return callPlpgsqlProcedure(env, fn, args, !frame.inFunction);
      if (fn.body?.some((s) => s.type === "transaction")) {
        const action = fn.body.find((s) => s.type === "transaction") as { action: string };
        throw pgError(
          "feature_not_supported",
          `${action.action === "rollback" ? "ROLLBACK" : action.action.toUpperCase()} is not allowed in an SQL function`,
          "0A000",
        );
      }
      const last = runFunctionBody(env, fn, args);
      const outs = fn.outArgs ?? [];
      if (outs.length === 0) return null;
      const row = last?.rows[0];
      return outs.map((c, i) => {
        const raw = row?.[i] ?? null;
        if (raw === null) return null;
        return castTo(env.ctx, { t: last!.columns[i]?.type ?? c.type, v: raw }, c.type, { assignment: true }).v;
      });
    }),
  );
}

export function executeCall(env: ExecEnv, stmt: CallStmt): ExecResult {
  const bound = bindCall(env, stmt.call);
  const out = invokeProcedure(env, bound);
  // what the body's INSERT / UPDATE / DELETE changed is not the CALL's row count
  env.ctx.state.changes = 0;
  const outs = bound.fn.outArgs ?? [];
  if (out === null || outs.length === 0) return commandResult("CALL", 0);
  return { columns: outs.map((c) => ({ name: c.name, type: c.type })), rows: [out], command: "CALL", rowCount: 0 };
}

/** A procedure argument PL/pgSQL can write an OUT / INOUT result back to: a variable (or record field). */
export function writableTarget(expr: Expr | undefined): string[] | null {
  if (expr?.type === "colref") return [...(expr as { parts: string[] }).parts];
  return null;
}

// ---------------------------------------------------------------------------
// DROP FUNCTION / PROCEDURE / ROUTINE
// ---------------------------------------------------------------------------

/** The routine a DROP names, or null when there is none (IF EXISTS). */
export function findRoutineToDrop(
  state: DatabaseState,
  kind: DropStmt["kind"],
  parts: string[],
  args: TypeName[] | undefined,
): FunctionData | null {
  const all = state.findFunctions(parts);
  const types = args && args.length > 0 ? args.map((a) => resolveTypeName(state, a).column.id) : null;
  const matches = (f: FunctionData) =>
    types === null ? true : f.argTypes.length === types.length && f.argTypes.every((t, i) => t === types[i]);
  const candidates = all.filter(matches);
  const wanted = candidates.filter((f) =>
    kind === "procedure" ? f.kind === "p" : kind === "function" ? f.kind !== "p" : true,
  );
  if (wanted.length > 0) return wanted[0]!;
  const other = candidates[0];
  if (other !== undefined && types !== null && kind !== "routine") {
    const label = `${other.name}(${other.argTypes.map(typeDisplayName).join(", ")})`;
    throw pgError("wrong_object_type", `${label} is not a ${kind === "procedure" ? "procedure" : "function"}`, "42809");
  }
  return null;
}
