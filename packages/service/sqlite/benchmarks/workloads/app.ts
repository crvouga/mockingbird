import type { BenchSpec } from "../harness/types.ts";
import { nowMs } from "../harness/stats.ts";
import { fillAppSchema, fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

const APP_JOIN_SQL = `
  SELECT u.name, COUNT(t.id) AS open_tasks
  FROM users u
  JOIN tasks t ON t.assignee_id = u.id
  WHERE t.completed = 0
  GROUP BY u.id, u.name
  ORDER BY open_tasks DESC
  LIMIT 20
`;

const PROJECT_TASKS_SQL =
  "SELECT t.id, t.title FROM tasks t WHERE t.project_id = ? AND t.completed = 0 ORDER BY t.id LIMIT 50";

export function appSpecs(): BenchSpec[] {
  return [
    spec({
      name: "workload-a/crud-loop/100",
      operation: "local-first CRUD loop",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      layer: "app",
      warmup: 1,
      iterations: 8,
      opsPerSample: 50,
      setup: (engine) => {
        fillUsers(engine, 100);
        return {
          ins: engine.prepare("INSERT INTO users(email, name, created_at) VALUES (?, ?, ?)"),
          get: engine.prepare("SELECT id, name FROM users WHERE id = ?"),
          upd: engine.prepare("UPDATE users SET name = ? WHERE id = ?"),
          list: engine.prepare("SELECT id, name FROM users ORDER BY id DESC LIMIT 20"),
          del: engine.prepare("DELETE FROM users WHERE email = ?"),
        };
      },
      fn: (engine, ctx) => {
        const s = ctx as {
          ins: { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } };
          get: { get: (id: unknown) => unknown };
          upd: { run: (...a: unknown[]) => unknown };
          list: { all: () => unknown };
          del: { run: (...a: unknown[]) => unknown };
        };
        for (let i = 0; i < 50; i++) {
          const email = `tmp-${i}-${Math.random()}@ex.test`;
          const inserted = s.ins.run(email, `Tmp ${i}`, 1_700_000_000);
          s.get.get(inserted.lastInsertRowid);
          s.upd.run(`Renamed ${i}`, inserted.lastInsertRowid);
          s.list.all();
          s.del.run(email);
        }
        void engine;
      },
    }),
    spec({
      name: "workload-b/sync-batch/1000",
      operation: "sync batch apply",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "app",
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        engine.exec(`CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        engine.exec("CREATE INDEX idx_items_updated ON items(updated_at)");
        const ins = engine.prepare("INSERT INTO items(id, version, payload, updated_at) VALUES (?, ?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, 1, `p${i}`, 1000 + i);
        });
        return {
          upd: engine.prepare("UPDATE items SET version = version + 1, payload = ?, updated_at = ? WHERE id = ?"),
          changed: engine.prepare("SELECT id, version FROM items WHERE updated_at > ?"),
        };
      },
      fn: (engine, ctx) => {
        const s = ctx as {
          upd: { run: (...a: unknown[]) => unknown };
          changed: { all: (t: number) => unknown };
        };
        engine.transaction(() => {
          for (let i = 1; i <= 50; i++) s.upd.run(`p${i}-x`, 10_000 + i, i);
        });
        s.changed.all(10_000);
      },
    }),
    ...appQuerySpecs(200, ["ci", "default", "full"]),
    ...appQuerySpecs(2000, ["default", "full"]),
  ];
}

function appQuerySpecs(users: number, tiers: BenchSpec["tiers"]): BenchSpec[] {
  const email = `u${Math.floor(users / 2)}@ex.test`;
  const projectId = Math.max(1, Math.floor(users / 40));
  return [
    spec({
      name: `workload-c/app-queries/${users}`,
      operation: "indexed app queries (composed)",
      datasetSize: users,
      tiers,
      layer: "app",
      warmup: 1,
      iterations: users >= 2000 ? 6 : 8,
      setup: (engine) => {
        fillAppSchema(engine, users);
        return {
          user: engine.prepare("SELECT id, name FROM users WHERE email = ?"),
          projectTasks: engine.prepare(PROJECT_TASKS_SQL),
          join: engine.prepare(APP_JOIN_SQL),
          timings: { userMs: 0, projectMs: 0, joinMs: 0 },
        };
      },
      fn: (_engine, ctx) => {
        const s = ctx as {
          user: { get: (email: string) => unknown };
          projectTasks: { all: (id: number) => unknown };
          join: { all: () => unknown };
          timings: { userMs: number; projectMs: number; joinMs: number };
        };
        let t0 = nowMs();
        s.user.get(email);
        s.timings.userMs = nowMs() - t0;
        t0 = nowMs();
        s.projectTasks.all(projectId);
        s.timings.projectMs = nowMs() - t0;
        t0 = nowMs();
        s.join.all();
        s.timings.joinMs = nowMs() - t0;
      },
      extra: (ctx) => {
        const s = ctx as { timings?: { userMs: number; projectMs: number; joinMs: number } };
        if (!s.timings) return undefined;
        return {
          userMs: s.timings.userMs,
          projectMs: s.timings.projectMs,
          joinMs: s.timings.joinMs,
        };
      },
    }),
    spec({
      name: `workload-c/app-query-user/${users}`,
      operation: "app email lookup only",
      datasetSize: users,
      tiers,
      layer: "api",
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillAppSchema(engine, users);
        return engine.prepare("SELECT id, name FROM users WHERE email = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: (e: string) => unknown }).get(email);
      },
    }),
    spec({
      name: `workload-c/app-query-join/${users}`,
      operation: "app open-tasks aggregate join",
      datasetSize: users,
      tiers,
      layer: "api",
      warmup: 1,
      iterations: users >= 2000 ? 6 : 8,
      setup: (engine) => {
        fillAppSchema(engine, users);
        return engine.prepare(APP_JOIN_SQL);
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
      },
    }),
  ];
}
