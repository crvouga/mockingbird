import { describe, expect, test } from "bun:test";
import { STANDARD_ADMIN_ROUTES } from "@crvouga/mockingbird-service";
import { createAdmin } from "../../src/admin.ts";
import { Database } from "../../src/index.ts";

const request = (path: string, init?: RequestInit): Request => new Request(`http://mock${path}`, init);

describe("postgres admin", () => {
  test("lists the shared admin routes and runs SQL", async () => {
    const db = new Database();
    db.exec("CREATE TABLE users (id serial PRIMARY KEY, name text)");
    db.exec("INSERT INTO users (name) VALUES ('Ada')");
    const admin = createAdmin({ database: db });
    const listed = (await (await admin.fetch(request("/__admin"))).json()) as { routes: string[] };
    for (const route of STANDARD_ADMIN_ROUTES) expect(listed.routes).toContain(route);
    expect(listed.routes).toContain("GET /sql/tables");
    expect(listed.routes).toContain("POST /sql/query");

    const tables = (await (await admin.fetch(request("/__admin/sql/tables"))).json()) as {
      tables: { schema: string; name: string }[];
    };
    expect(tables.tables).toContainEqual(expect.objectContaining({ schema: "public", name: "users" }));

    const opened = (await (await admin.fetch(request("/__admin/sql/tables/public/users?limit=50"))).json()) as {
      columns: string[];
      rows: { name: string }[];
      total: number;
    };
    expect(opened.columns).toContain("name");
    expect(opened.total).toBe(1);
    expect(opened.rows[0]?.name).toBe("Ada");
    expect((await admin.fetch(request("/__admin/sql/tables/public/missing"))).status).toBe(400);

    const queried = await admin.fetch(
      request("/__admin/sql/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT name FROM users" }),
      }),
    );
    expect(await queried.json()).toMatchObject({ rows: [{ name: "Ada" }] });
    const broken = await admin.fetch(
      request("/__admin/sql/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT nope FROM missing" }),
      }),
    );
    expect(broken.status).toBe(400);

    const state = (await (await admin.fetch(request("/__admin/state"))).json()) as {
      collections: { name: string; count: number }[];
    };
    expect(state.collections).toContainEqual(expect.objectContaining({ name: "public.users", count: 1 }));

    const page = (await (await admin.fetch(request("/__admin/state/public.users"))).json()) as {
      records: { value: { name: string } }[];
    };
    expect(page.records[0]?.value.name).toBe("Ada");

    const denied = await admin.fetch(
      request("/__admin/state/public.users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Grace" }),
      }),
    );
    expect(denied.status).toBe(400);

    const saved = (await (
      await admin.fetch(request("/__admin/checkpoints", { method: "POST", body: "{}" }))
    ).json()) as { id: string };
    db.exec("INSERT INTO users (name) VALUES ('Grace')");
    const restored = await admin.fetch(
      request("/__admin/branches/main/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkpoint: saved.id }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(db.query("SELECT name FROM users ORDER BY name")).toEqual([{ name: "Ada" }]);

    const shell = await admin.fetch(request("/__admin/ui"));
    expect(shell.headers.get("content-type")).toContain("text/html");
    const html = await shell.text();
    expect(html).toContain('data-admin-ui-library="antd"');
    expect(html).toContain("MockingbirdAdmin.mount(");
  });
});

test("SQL admin uses the configured prefix for health, UI and query routes", async () => {
  const admin = createAdmin({ adminPrefix: "/_control/mock", adminKey: "locked" });
  const health = await admin.fetch(request("/_control/mock/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ adminPrefix: "/_control/mock", adminUi: "/_control/mock/ui" });
  const ui = await admin.fetch(request("/_control/mock/ui"));
  expect(ui.status).toBe(200);
  expect(await ui.text()).toContain('"adminPrefix":"/_control/mock"');
  expect((await admin.fetch(request("/_control/mock/sql/tables"))).status).toBe(401);
  const query = await admin.fetch(
    request("/_control/mock/sql/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mockingbird-admin-key": "locked" },
      body: JSON.stringify({ sql: "SELECT 1 AS value" }),
    }),
  );
  expect(query.status).toBe(200);
  for (const path of ["/health", "/__admin/health", "/__admin/ui", "/__admin/sql/tables"])
    expect((await admin.fetch(request(path))).status).toBe(404);
});

describe("admin catalog reads scale with the schema (#695)", () => {
  const seed = (tables: number): Database => {
    const db = new Database();
    db.exec("CREATE SCHEMA app");
    for (let i = 0; i < tables; i++) {
      db.exec(`CREATE TABLE app.t${i} (
        id serial PRIMARY KEY,
        parent_id int${i > 0 ? ` REFERENCES app.t${i - 1} (id)` : ""},
        name text NOT NULL, email text UNIQUE, created_at timestamptz DEFAULT now())`);
      db.exec(`CREATE INDEX t${i}_name ON app.t${i} (name)`);
    }
    return db;
  };

  // Counts catalog queries instead of timing them: before the fix every table cost two
  // information_schema scans, and every page re-listed every table.
  const countingCatalogReads = (db: Database): (() => number) => {
    let reads = 0;
    const query = db.query.bind(db);
    db.query = ((sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema")) reads++;
      return query(sql, params as never);
    }) as typeof db.query;
    return () => reads;
  };

  test("GET /sql/tables issues a fixed number of catalog reads, whatever the table count", async () => {
    for (const tables of [3, 40]) {
      const db = seed(tables);
      const reads = countingCatalogReads(db);
      const admin = createAdmin({ database: db });
      const body = (await (await admin.fetch(request("/__admin/sql/tables"))).json()) as {
        tables: { schema: string; name: string; columns: { name: string; type: string; primaryKey?: boolean }[] }[];
      };
      expect(body.tables.filter((table) => table.schema === "app")).toHaveLength(tables);
      expect(reads()).toBe(3);
      const t1 = body.tables.find((table) => table.schema === "app" && table.name === "t1");
      expect(t1?.columns).toEqual([
        { name: "id", type: "integer", primaryKey: true },
        { name: "parent_id", type: "integer" },
        { name: "name", type: "text" },
        { name: "email", type: "text" },
        { name: "created_at", type: "timestamp with time zone" },
      ]);
    }
  });

  test("GET /state and a single table page do not re-describe every table", async () => {
    const db = seed(40);
    const reads = countingCatalogReads(db);
    const admin = createAdmin({ database: db });
    const state = (await (await admin.fetch(request("/__admin/state"))).json()) as {
      collections: { name: string; count: number }[];
    };
    expect(state.collections.filter((collection) => collection.name.startsWith("app."))).toHaveLength(40);
    expect(reads()).toBe(3);
    const page = (await (await admin.fetch(request("/__admin/sql/tables/app/t7"))).json()) as {
      columns: string[];
      rows: unknown[];
      total: number;
    };
    // An empty table still reports its columns, from the result set rather than the catalog.
    expect(page).toMatchObject({ columns: ["id", "parent_id", "name", "email", "created_at"], rows: [], total: 0 });
    expect(reads()).toBe(3);
  });

  test("a page is served for tables and views only, never for catalog relations", async () => {
    const db = new Database();
    db.exec("CREATE TABLE items (id int PRIMARY KEY, label text)");
    db.exec("INSERT INTO items VALUES (1, 'one')");
    db.exec("CREATE VIEW item_labels AS SELECT label FROM items");
    db.exec("CREATE MATERIALIZED VIEW item_ids AS SELECT id FROM items");
    const admin = createAdmin({ database: db });
    const view = (await (await admin.fetch(request("/__admin/sql/tables/public/item_labels"))).json()) as {
      rows: unknown[];
    };
    expect(view.rows).toEqual([{ label: "one" }]);
    for (const path of ["public/missing", "public/item_ids", "pg_catalog/pg_class", "information_schema/tables"])
      expect((await admin.fetch(request(`/__admin/sql/tables/${path}`))).status).toBe(400);
  });
});
