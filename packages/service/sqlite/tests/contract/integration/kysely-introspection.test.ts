import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "Kysely-style schema introspection through pragma TVFs and sqlite_master",
  [],
  [
    {
      sql: `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL
        );
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          slug TEXT NOT NULL
        );
        CREATE UNIQUE INDEX projects_owner_slug ON projects(owner_id, slug);
      `,
      neutralizeCounters: true,
    },
    {
      sql: `
        SELECT name, type, "notnull", dflt_value, pk
        FROM pragma_table_info('projects')
        ORDER BY cid
      `,
      query: true,
    },
    {
      sql: `
        SELECT name, "unique", origin, partial
        FROM pragma_index_list('projects')
        ORDER BY seq
      `,
      query: true,
    },
    {
      sql: `
        SELECT m.name AS table_name, p.name AS column_name, p.type, p.pk
        FROM sqlite_master AS m, pragma_table_info(m.name) AS p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, p.cid
      `,
      query: true,
    },
    {
      sql: `
        SELECT m.name AS table_name, p.name AS index_name, p."unique", p.origin
        FROM sqlite_master AS m
        JOIN pragma_index_list(m.name) AS p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, p.seq
      `,
      query: true,
    },
    {
      sql: `
        SELECT type, name, tbl_name
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `,
      query: true,
    },
  ],
);
