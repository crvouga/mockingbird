import { errorParity, parity, sequenceParity } from "../helpers.ts";

const schema = [
  "PRAGMA foreign_keys=ON",
  "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
  "CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id))",
  "INSERT INTO parent VALUES (1)",
];

parity("foreign key accepts existing parent", [...schema, "INSERT INTO child VALUES (10,1)"], "SELECT * FROM child");
errorParity("foreign key rejects missing parent", schema, "INSERT INTO child VALUES (10,99)", "constraint_foreign");
parity(
  "foreign key permits NULL child key",
  [...schema, "INSERT INTO child VALUES (10,NULL)"],
  "SELECT id,parent_id FROM child",
);
errorParity(
  "parent delete is restricted",
  [...schema, "INSERT INTO child VALUES (10,1)"],
  "DELETE FROM parent WHERE id=1",
  "constraint_foreign",
);
sequenceParity(
  "ON DELETE CASCADE removes child rows",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER,parent_id INTEGER REFERENCES p(id) ON DELETE CASCADE)",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (2,1)",
  ],
  [{ sql: "DELETE FROM p WHERE id=1" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "ON DELETE SET NULL clears child key",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER,parent_id INTEGER REFERENCES p(id) ON DELETE SET NULL)",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (2,1)",
  ],
  [{ sql: "DELETE FROM p WHERE id=1" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "ON DELETE SET DEFAULT applies child default",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER,parent_id INTEGER DEFAULT 0 REFERENCES p(id) ON DELETE SET DEFAULT)",
    "INSERT INTO p VALUES (0),(1)",
    "INSERT INTO c VALUES (2,1)",
  ],
  [{ sql: "DELETE FROM p WHERE id=1" }, { sql: "SELECT * FROM c", query: true }],
);

errorParity(
  "ON DELETE SET DEFAULT rejects when default is the deleted parent",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER,parent_id INTEGER DEFAULT 1 REFERENCES p(id) ON DELETE SET DEFAULT)",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (2,1)",
  ],
  "DELETE FROM p WHERE id=1",
  "constraint_foreign",
);

errorParity(
  "ON DELETE RESTRICT rejects referenced parent",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(parent_id INTEGER REFERENCES p(id) ON DELETE RESTRICT)",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (1)",
  ],
  "DELETE FROM p WHERE id=1",
  "constraint_foreign",
);

sequenceParity(
  "ON UPDATE CASCADE updates child key",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id TEXT PRIMARY KEY)",
    "CREATE TABLE c(parent_id TEXT REFERENCES p(id) ON UPDATE CASCADE)",
    "INSERT INTO p VALUES ('old')",
    "INSERT INTO c VALUES ('old')",
  ],
  [{ sql: "UPDATE p SET id='new' WHERE id='old'" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "ON UPDATE CASCADE updates integer primary key",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(parent_id INTEGER REFERENCES p(id) ON UPDATE CASCADE)",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (1)",
  ],
  [{ sql: "UPDATE p SET id=2 WHERE id=1" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "ON UPDATE SET NULL clears child key",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id TEXT PRIMARY KEY)",
    "CREATE TABLE c(parent_id TEXT REFERENCES p(id) ON UPDATE SET NULL)",
    "INSERT INTO p VALUES ('old')",
    "INSERT INTO c VALUES ('old')",
  ],
  [{ sql: "UPDATE p SET id='new' WHERE id='old'" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "ON UPDATE SET DEFAULT applies child default",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id TEXT PRIMARY KEY)",
    "CREATE TABLE c(parent_id TEXT DEFAULT 'fallback' REFERENCES p(id) ON UPDATE SET DEFAULT)",
    "INSERT INTO p VALUES ('fallback'),('old')",
    "INSERT INTO c VALUES ('old')",
  ],
  [{ sql: "UPDATE p SET id='new' WHERE id='old'" }, { sql: "SELECT * FROM c", query: true }],
);

errorParity(
  "ON UPDATE RESTRICT rejects referenced key change",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id TEXT PRIMARY KEY)",
    "CREATE TABLE c(parent_id TEXT REFERENCES p(id) ON UPDATE RESTRICT)",
    "INSERT INTO p VALUES ('old')",
    "INSERT INTO c VALUES ('old')",
  ],
  "UPDATE p SET id='new' WHERE id='old'",
  "constraint_foreign",
);

sequenceParity(
  "composite foreign key cascades updates",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(a TEXT,b TEXT,PRIMARY KEY(a,b))",
    "CREATE TABLE c(a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES p(a,b) ON UPDATE CASCADE)",
    "INSERT INTO p VALUES ('x','y')",
    "INSERT INTO c VALUES ('x','y')",
  ],
  [{ sql: "UPDATE p SET a='z',b='w' WHERE a='x' AND b='y'" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "foreign_keys OFF allows orphan rows",
  [
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(parent_id INTEGER REFERENCES p(id))",
    "PRAGMA foreign_keys=OFF",
  ],
  [{ sql: "INSERT INTO c VALUES (99)" }, { sql: "SELECT * FROM c", query: true }],
);

sequenceParity(
  "AFTER DELETE trigger runs under foreign key CASCADE",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES p(id) ON DELETE CASCADE)",
    "CREATE TABLE audit(msg TEXT)",
    "CREATE TRIGGER c_del AFTER DELETE ON c BEGIN INSERT INTO audit VALUES ('child '||OLD.id); END",
    "INSERT INTO p VALUES (1)",
    "INSERT INTO c VALUES (10,1)",
  ],
  [
    { sql: "DELETE FROM p WHERE id=1" },
    { sql: "SELECT msg FROM audit ORDER BY msg", query: true },
    { sql: "SELECT count(*) AS n FROM c", query: true },
  ],
);
