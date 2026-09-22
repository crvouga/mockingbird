import { errorParity, parity, sequenceParity } from "../helpers.ts";

const table = [
  "CREATE TABLE users(id INTEGER,email TEXT,name TEXT)",
  "INSERT INTO users VALUES (1,'a@x','A'),(2,'b@x','B')",
];

parity(
  "ordinary index does not change query results",
  [...table, "CREATE INDEX users_name_idx ON users(name)"],
  "SELECT id,name FROM users WHERE name='B'",
);
parity(
  "created index appears in sqlite_master",
  [...table, "CREATE INDEX users_name_idx ON users(name)"],
  "SELECT name,tbl_name FROM sqlite_master WHERE type='index' AND name='users_name_idx'",
);
errorParity(
  "UNIQUE index rejects duplicate values",
  [...table, "CREATE UNIQUE INDEX users_email_uq ON users(email)"],
  "INSERT INTO users VALUES (3,'a@x','C')",
  "constraint_unique",
);
sequenceParity(
  "dropping an index removes schema entry",
  [...table, "CREATE INDEX users_name_idx ON users(name)"],
  [
    { sql: "DROP INDEX users_name_idx" },
    { sql: "SELECT name FROM sqlite_master WHERE type='index' AND name='users_name_idx'", query: true },
  ],
);
