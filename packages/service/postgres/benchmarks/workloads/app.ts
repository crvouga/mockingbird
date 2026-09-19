import { nowMs } from "../harness/stats.ts";
import type { BenchSpec, BenchStatement } from "../harness/types.ts";
import { fillAppSchema, fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

const TOP_SPENDERS_SQL = `
  SELECT u.name, SUM(i.qty * i.price_cents) AS total_cents
  FROM users u
  JOIN orders o ON o.user_id = u.id
  JOIN items i ON i.order_id = o.id
  WHERE o.status = 'paid'
  GROUP BY u.id, u.name
  ORDER BY total_cents DESC, u.name
  LIMIT 20
`;

const ORDER_ITEMS_SQL = "SELECT i.id, i.product, i.qty FROM items i WHERE i.order_id = $1 ORDER BY i.id LIMIT 50";

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
      setup: async (engine) => {
        await fillUsers(engine, 100);
        return {
          ins: engine.prepare("INSERT INTO users(email, name, created_at) VALUES ($1, $2, $3) RETURNING id"),
          get: engine.prepare("SELECT id, name FROM users WHERE id = $1"),
          upd: engine.prepare("UPDATE users SET name = $1 WHERE id = $2"),
          list: engine.prepare("SELECT id, name FROM users ORDER BY id DESC LIMIT 20"),
          del: engine.prepare("DELETE FROM users WHERE email = $1"),
        };
      },
      fn: async (_engine, ctx) => {
        const s = ctx as {
          ins: BenchStatement;
          get: BenchStatement;
          upd: BenchStatement;
          list: BenchStatement;
          del: BenchStatement;
        };
        for (let i = 0; i < 50; i++) {
          const email = `tmp-${i}-${Math.random()}@ex.test`;
          const inserted = await s.ins.get<{ id: number }>(email, `Tmp ${i}`, 1_700_000_000);
          const id = inserted?.id;
          await s.get.get(id);
          await s.upd.run(`Renamed ${i}`, id);
          await s.list.all();
          await s.del.run(email);
        }
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
      setup: async (engine) => {
        await engine.exec(`CREATE TABLE sync_items (
          id int PRIMARY KEY,
          version int NOT NULL,
          payload text NOT NULL,
          updated_at int NOT NULL
        )`);
        await engine.exec("CREATE INDEX idx_sync_items_updated ON sync_items(updated_at)");
        const ins = engine.prepare("INSERT INTO sync_items(id, version, payload, updated_at) VALUES ($1, $2, $3, $4)");
        await engine.transaction(async () => {
          for (let i = 1; i <= 1000; i++) await ins.run(i, 1, `p${i}`, 1000 + i);
        });
        return {
          upd: engine.prepare(
            "UPDATE sync_items SET version = version + 1, payload = $1, updated_at = $2 WHERE id = $3",
          ),
          changed: engine.prepare("SELECT id, version FROM sync_items WHERE updated_at > $1"),
        };
      },
      fn: async (engine, ctx) => {
        const s = ctx as { upd: BenchStatement; changed: BenchStatement };
        await engine.transaction(async () => {
          for (let i = 1; i <= 50; i++) await s.upd.run(`p${i}-x`, 10_000 + i, i);
        });
        await s.changed.all(10_000);
      },
    }),
    ...appQuerySpecs(200, ["ci", "default", "full"]),
    ...appQuerySpecs(2000, ["default", "full"]),
  ];
}

function appQuerySpecs(users: number, tiers: BenchSpec["tiers"]): BenchSpec[] {
  const email = `u${Math.floor(users / 2)}@ex.test`;
  const orderId = Math.max(1, Math.floor(users / 2));
  return [
    spec({
      name: `workload-c/app-queries/${users}`,
      operation: "indexed app queries (composed)",
      datasetSize: users,
      tiers,
      layer: "app",
      warmup: 1,
      iterations: users >= 2000 ? 6 : 8,
      setup: async (engine) => {
        await fillAppSchema(engine, users);
        return {
          user: engine.prepare("SELECT id, name FROM users WHERE email = $1"),
          orderItems: engine.prepare(ORDER_ITEMS_SQL),
          join: engine.prepare(TOP_SPENDERS_SQL),
          timings: { userMs: 0, itemsMs: 0, joinMs: 0 },
        };
      },
      fn: async (_engine, ctx) => {
        const s = ctx as {
          user: BenchStatement;
          orderItems: BenchStatement;
          join: BenchStatement;
          timings: { userMs: number; itemsMs: number; joinMs: number };
        };
        let t0 = nowMs();
        await s.user.get(email);
        s.timings.userMs = nowMs() - t0;
        t0 = nowMs();
        await s.orderItems.all(orderId);
        s.timings.itemsMs = nowMs() - t0;
        t0 = nowMs();
        await s.join.all();
        s.timings.joinMs = nowMs() - t0;
      },
      extra: (ctx) => {
        const s = ctx as { timings?: { userMs: number; itemsMs: number; joinMs: number } };
        if (!s.timings) return undefined;
        return {
          userMs: s.timings.userMs,
          itemsMs: s.timings.itemsMs,
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
      setup: async (engine) => {
        await fillAppSchema(engine, users);
        return engine.prepare("SELECT id, name FROM users WHERE email = $1");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get(email);
      },
    }),
    spec({
      name: `workload-c/app-query-join/${users}`,
      operation: "app top-spenders aggregate join",
      datasetSize: users,
      tiers,
      layer: "api",
      warmup: 1,
      iterations: users >= 2000 ? 6 : 8,
      setup: async (engine) => {
        await fillAppSchema(engine, users);
        return engine.prepare(TOP_SPENDERS_SQL);
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
  ];
}
