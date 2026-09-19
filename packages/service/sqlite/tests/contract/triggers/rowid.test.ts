import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "AFTER INSERT trigger observes outer last_insert_rowid",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)",
    "CREATE TABLE audit(id INTEGER PRIMARY KEY, observed INTEGER)",
    "INSERT INTO audit(id,observed) VALUES (100,0)",
    "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO audit(observed) VALUES(last_insert_rowid()); END",
  ],
  [{ sql: "INSERT INTO t(v) VALUES ('outer')" }, { sql: "SELECT observed FROM audit WHERE id=101", query: true }],
);
