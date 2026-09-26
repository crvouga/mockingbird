import { sequenceParity } from "../helpers.ts";

const base = ["PRAGMA foreign_keys=ON", "CREATE TABLE parent(id INTEGER PRIMARY KEY)", "INSERT INTO parent VALUES (1)"];

sequenceParity(
  "deferred NO ACTION waits until COMMIT",
  [
    ...base,
    "CREATE TABLE child(pid INTEGER REFERENCES parent(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED)",
    "INSERT INTO child VALUES (1)",
  ],
  [{ sql: "BEGIN" }, { sql: "DELETE FROM parent WHERE id=1" }, { sql: "COMMIT" }],
);

sequenceParity(
  "deferred RESTRICT still fails at DELETE",
  [
    ...base,
    "CREATE TABLE child(pid INTEGER REFERENCES parent(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)",
    "INSERT INTO child VALUES (1)",
  ],
  [{ sql: "BEGIN" }, { sql: "DELETE FROM parent WHERE id=1" }, { sql: "ROLLBACK" }],
);
