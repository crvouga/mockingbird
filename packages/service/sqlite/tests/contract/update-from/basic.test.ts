import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "UPDATE FROM joins source rows",
  [
    "CREATE TABLE a(id INTEGER, v TEXT)",
    "CREATE TABLE b(id INTEGER, v TEXT)",
    "INSERT INTO a VALUES (1,'old'),(2,'keep')",
    "INSERT INTO b VALUES (1,'new')",
  ],
  [{ sql: "UPDATE a SET v = b.v FROM b WHERE a.id = b.id" }, { sql: "SELECT id, v FROM a ORDER BY id", query: true }],
);

sequenceParity(
  "UPDATE FROM with multiple matching source rows uses one match",
  [
    "CREATE TABLE a(id INTEGER, v TEXT)",
    "CREATE TABLE b(id INTEGER, v TEXT)",
    "INSERT INTO a VALUES (1,'old')",
    "INSERT INTO b VALUES (1,'first'),(1,'second')",
  ],
  [{ sql: "UPDATE a SET v = b.v FROM b WHERE a.id = b.id" }, { sql: "SELECT id, v FROM a ORDER BY id", query: true }],
);

sequenceParity(
  "UPDATE FROM LEFT JOIN style keeps unmatched targets",
  [
    "CREATE TABLE dest(id INTEGER, v TEXT)",
    "CREATE TABLE src(id INTEGER, v TEXT)",
    "INSERT INTO dest VALUES (1,'a'),(2,'b')",
    "INSERT INTO src VALUES (1,'A')",
  ],
  [
    {
      sql: "UPDATE dest SET v = COALESCE(src.v, dest.v) FROM src WHERE dest.id = src.id",
    },
    { sql: "SELECT id, v FROM dest ORDER BY id", query: true },
  ],
);

sequenceParity(
  "UPDATE FROM correlated subquery in SET",
  [
    "CREATE TABLE dest(id INTEGER, total INTEGER)",
    "CREATE TABLE src(id INTEGER, amount INTEGER)",
    "INSERT INTO dest VALUES (1,0),(2,0)",
    "INSERT INTO src VALUES (1,10),(1,5),(2,3)",
  ],
  [
    {
      sql: "UPDATE dest SET total = (SELECT sum(amount) FROM src WHERE src.id = dest.id) WHERE EXISTS (SELECT 1 FROM src WHERE src.id = dest.id)",
    },
    { sql: "SELECT id, total FROM dest ORDER BY id", query: true },
  ],
);
