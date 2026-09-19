import { expect } from "bun:test";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("ORM-style prepared CRUD over a STRICT application schema", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      assignee_id INTEGER REFERENCES users(id),
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
    ) STRICT`,
    "CREATE INDEX tasks_project_open ON tasks(project_id, completed)",
  ]);

  const memInsertUser = memory.prepare("INSERT INTO users(email, name, created_at) VALUES (?, ?, ?)");
  const sqlInsertUser = sqlite.prepare("INSERT INTO users(email, name, created_at) VALUES (?, ?, ?)");
  expectParity(
    memInsertUser.run("ada@example.test", "Ada", 1_700_000_000),
    sqlInsertUser.run("ada@example.test", "Ada", 1_700_000_000),
  );
  expectParity(
    memory.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
    sqlite.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
  );

  const memInsertProject = memory.prepare("INSERT INTO projects(owner_id, name) VALUES (?, ?)");
  const sqlInsertProject = sqlite.prepare("INSERT INTO projects(owner_id, name) VALUES (?, ?)");
  expectParity(memInsertProject.run(1, "SQLite parity"), sqlInsertProject.run(1, "SQLite parity"));

  const memInsertTask = memory.prepare("INSERT INTO tasks(project_id, assignee_id, title) VALUES (?, ?, ?)");
  const sqlInsertTask = sqlite.prepare("INSERT INTO tasks(project_id, assignee_id, title) VALUES (?, ?, ?)");
  for (const title of ["Design schema", "Implement executor", "Verify contracts"]) {
    expectParity(memInsertTask.run(1, 1, title), sqlInsertTask.run(1, 1, title));
  }

  const memUpdate = memory.prepare("UPDATE tasks SET completed = ? WHERE project_id = ? AND title = ?");
  const sqlUpdate = sqlite.prepare("UPDATE tasks SET completed = ? WHERE project_id = ? AND title = ?");
  expectParity(memUpdate.run(1, 1, "Implement executor"), sqlUpdate.run(1, 1, "Implement executor"));
  expectParity(
    memory.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
    sqlite.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
  );

  const memDelete = memory.prepare("DELETE FROM tasks WHERE project_id = ? AND completed = ?");
  const sqlDelete = sqlite.prepare("DELETE FROM tasks WHERE project_id = ? AND completed = ?");
  expectParity(memDelete.run(1, 1), sqlDelete.run(1, 1));
  expectParity(
    memory.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
    sqlite.query("SELECT changes() AS changes, last_insert_rowid() AS id"),
  );

  const finalMemory = memory.query("SELECT id, project_id, assignee_id, title, completed FROM tasks ORDER BY id");
  const finalSqlite = sqlite.query("SELECT id, project_id, assignee_id, title, completed FROM tasks ORDER BY id");
  expect(finalMemory.ok).toBe(true);
  expectParity(finalMemory, finalSqlite);
});
