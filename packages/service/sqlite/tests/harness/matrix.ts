import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../adapters/real-sqlite.ts";
import type { ContractDb } from "./types.ts";

function wrapBackendError(backend: "memory" | "sqlite", error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`[${backend}] ${message}`);
  if (error instanceof Error) {
    wrapped.cause = error;
  }
  return wrapped;
}

export function matrix(name: string, fn: (db: ContractDb, backend: "memory" | "sqlite") => void | Promise<void>): void {
  describe(name, () => {
    test("memory", async () => {
      const db = new InMemoryAdapter();
      try {
        await fn(db, "memory");
      } catch (error) {
        throw wrapBackendError("memory", error);
      } finally {
        db.close();
      }
    });

    test("sqlite", async () => {
      const db = new RealSqliteAdapter();
      try {
        await fn(db, "sqlite");
      } catch (error) {
        throw wrapBackendError("sqlite", error);
      } finally {
        db.close();
      }
    });
  });
}

export function matrixBoth(name: string, fn: (memory: ContractDb, sqlite: ContractDb) => void | Promise<void>): void {
  test(name, async () => {
    const memory = new InMemoryAdapter();
    const sqlite = new RealSqliteAdapter();
    try {
      await fn(memory, sqlite);
    } finally {
      memory.close();
      sqlite.close();
    }
  });
}
