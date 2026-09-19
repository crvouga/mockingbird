import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import type { ContractDb } from "./types.ts";
import { createOracleAdapter } from "./oracle.ts";

export type Backend = "memory" | "postgres";

function wrapBackendError(backend: Backend, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`[${backend}] ${message}`);
  if (error instanceof Error) wrapped.cause = error;
  return wrapped;
}

export function matrix(name: string, fn: (db: ContractDb, backend: Backend) => void | Promise<void>): void {
  describe(name, () => {
    test("memory", async () => {
      const db = new InMemoryAdapter();
      try {
        await fn(db, "memory");
      } catch (error) {
        throw wrapBackendError("memory", error);
      } finally {
        await db.close();
      }
    });

    test("postgres", async () => {
      const db = createOracleAdapter();
      try {
        await fn(db, "postgres");
      } catch (error) {
        throw wrapBackendError("postgres", error);
      } finally {
        await db.close();
      }
    });
  });
}

export function matrixBoth(name: string, fn: (memory: ContractDb, postgres: ContractDb) => void | Promise<void>): void {
  test(name, async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      await fn(memory, postgres);
    } finally {
      await memory.close();
      await postgres.close();
    }
  });
}
