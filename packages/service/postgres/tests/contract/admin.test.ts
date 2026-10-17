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
