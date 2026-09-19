import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "migration runner executes transactional multi-statement scripts",
  [],
  [
    {
      sql: `
        BEGIN;
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL
        );
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL
        );
        INSERT INTO users(email, name) VALUES ('ada@example.test', 'Ada');
        INSERT INTO projects(owner_id, name) VALUES (1, 'Initial project');
        COMMIT;
      `,
      neutralizeCounters: true,
    },
    {
      sql: `
        BEGIN;
        ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX projects_owner_archived ON projects(owner_id, archived);
        UPDATE projects SET name = 'Migrated project' WHERE id = 1;
        COMMIT;
      `,
      neutralizeCounters: true,
    },
    {
      sql: "SELECT p.id, p.name, p.archived, u.email FROM projects AS p JOIN users AS u ON u.id = p.owner_id",
      query: true,
    },
  ],
  { compareFinalState: true },
);
