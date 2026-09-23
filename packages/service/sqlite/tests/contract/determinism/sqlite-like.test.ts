import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../../adapters/real-sqlite.ts";

test("os random() is integer-typed and consecutive draws usually differ", () => {
  const db = new Database({ random: "os" });
  try {
    const types = db.query<{ t: string }>("SELECT typeof(random()) AS t UNION ALL SELECT typeof(random()) AS t");
    expect(types.every((row) => row.t === "integer")).toBe(true);
    const blob = db.query<{ n: number }>("SELECT length(randomblob(8)) AS n")[0]!;
    expect(blob.n).toBe(8);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(String(db.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v));
    }
    expect(seen.size).toBeGreaterThan(1);
  } finally {
    db.close();
  }
});

test("os random() is not rewound by ROLLBACK", () => {
  const db = new Database({ random: "os" });
  try {
    db.exec("BEGIN");
    const during = String(db.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);
    db.exec("ROLLBACK");
    const after = String(db.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v);
    expect(after).not.toBe(during);
  } finally {
    db.close();
  }
});

test("system clock date('now') is today's UTC date and open with system clock stays live", () => {
  const db = new Database({ now: "system" });
  try {
    const today = new Date().toISOString().slice(0, 10);
    expect(db.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe(today);
    const snap = db.snapshot();
    const opened = snap.open({ now: "system" });
    try {
      expect(opened.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe(today);
    } finally {
      opened.close();
    }
  } finally {
    db.close();
  }
});

test("system clock date('now') matches bun:sqlite UTC date", () => {
  const memory = new InMemoryAdapter({ now: "system" });
  const sqlite = new RealSqliteAdapter();
  try {
    const mem = memory.query("SELECT date('now') AS d");
    const ora = sqlite.query("SELECT date('now') AS d");
    expect(mem.ok && ora.ok).toBe(true);
    expect(mem.rows[0]?.d).toBe(ora.rows[0]?.d);
  } finally {
    memory.close();
    sqlite.close();
  }
});

test("datetime('now') with system clock is within a few seconds of wall time", () => {
  const db = new Database({ now: "system" });
  try {
    const sqlNow = db.query<{ t: string }>("SELECT datetime('now') AS t")[0]!.t;
    const wall = new Date().toISOString().slice(0, 19).replace("T", " ");
    const sqlMs = Date.parse(`${sqlNow.replace(" ", "T")}Z`);
    const wallMs = Date.parse(`${wall.replace(" ", "T")}Z`);
    expect(Math.abs(sqlMs - wallMs)).toBeLessThan(5000);
  } finally {
    db.close();
  }
});
