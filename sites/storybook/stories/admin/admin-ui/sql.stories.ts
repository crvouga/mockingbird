import { createAdmin } from "@crvouga/mockingbird-service-sqlite/admin"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { userEvent, within } from "storybook/test"
import { type AdminVisit, admin, choose, SHELL_SOURCES, shows } from "./admin.js"
import { control } from "./store.js"

/**
 * The SQL explorer a database engine's admin adds (`kind: "sql"` extension), on the SQLite
 * engine's admin (`createAdmin` from `@crvouga/mockingbird-service-sqlite/admin`). Its tables are
 * made through that admin's own `POST /sql/query`.
 */
export default {
  title: "Admin/Admin UI/SQL explorer",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL_SOURCES,
      "packages/admin-ui/src/sql.tsx",
      "packages/admin-ui/src/state.tsx",
      "packages/service/core/src/engine-admin.ts",
      "packages/service/sqlite/src/admin.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://sqlite.mock"

async function database(): Promise<AdminVisit> {
  const emulator = createAdmin()
  const sql = control(emulator, ORIGIN)
  const run = (statement: string) => sql("POST", "/sql/query", { sql: statement })
  await run(
    "CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, born TEXT)",
  )
  await run(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, patient_id INTEGER REFERENCES patients(id), test TEXT, status TEXT)",
  )
  await run(
    "INSERT INTO patients (name, email, born) VALUES ('Alice Liddell', 'alice@gmail.com', '1990-04-12'), ('Bob Marley', 'bob@example.com', '1985-02-06'), ('Carol Danvers', 'carol@example.com', '1979-11-30')",
  )
  await run(
    "INSERT INTO orders (patient_id, test, status) VALUES (1, 'Lipid panel', 'resulted'), (1, 'Vitamin D', 'collected'), (2, 'CBC', 'ordered')",
  )
  return { emulator, origin: ORIGIN }
}

/** The first table (`orders`), browsed, with its schema. */
export const Tables: StoryObj = admin(database, { view: "sql", ready: "Lipid panel" })

/** Another table chosen. */
export const AnotherTable: StoryObj = admin(database, { view: "sql", ready: "Lipid panel" })
AnotherTable.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Lipid panel")
  await choose(canvasElement, "Database table", "patients", "main.patients")
  await shows(canvasElement, "alice@gmail.com")
}

/** A query run, its rows below. */
export const QueryResult: StoryObj = admin(database, { view: "sql", ready: "Lipid panel" })
QueryResult.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Lipid panel")
  await userEvent.type(
    within(canvasElement).getByLabelText("SQL statement"),
    "SELECT name, count(orders.id) AS orders FROM patients LEFT JOIN orders ON orders.patient_id = patients.id GROUP BY name",
  )
  await userEvent.click(within(canvasElement).getByRole("button", { name: /Run query/ }))
  await shows(canvasElement, "3 rows")
}

/** A statement the engine refuses. */
export const QueryError: StoryObj = admin(database, { view: "sql", ready: "Lipid panel" })
QueryError.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Lipid panel")
  await userEvent.type(
    within(canvasElement).getByLabelText("SQL statement"),
    "SELECT * FROM invoices",
  )
  await userEvent.click(within(canvasElement).getByRole("button", { name: /Run query/ }))
  await shows(canvasElement, "Request failed")
}

/** An engine with no tables yet. */
export const NoTables: StoryObj = admin(() => ({ emulator: createAdmin(), origin: ORIGIN }), {
  view: "sql",
  ready: "Query runner",
})

/** State beside SQL: records are browsed, and changed through the SQL view. */
export const StateBesideSql: StoryObj = admin(database, {
  view: "state",
  ready: "use the SQL view",
})
