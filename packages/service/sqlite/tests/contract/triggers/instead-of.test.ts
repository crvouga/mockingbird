import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "INSTEAD OF triggers make a view writable",
  [
    "CREATE TABLE base(id INTEGER PRIMARY KEY, v TEXT)",
    "INSERT INTO base VALUES (1,'a'),(2,'b')",
    "CREATE VIEW visible AS SELECT id,v FROM base",
    "CREATE TRIGGER visible_i INSTEAD OF INSERT ON visible BEGIN INSERT INTO base(id,v) VALUES(NEW.id,NEW.v); END",
    "CREATE TRIGGER visible_u INSTEAD OF UPDATE OF v ON visible BEGIN UPDATE base SET v=NEW.v WHERE id=OLD.id; END",
    "CREATE TRIGGER visible_d INSTEAD OF DELETE ON visible BEGIN DELETE FROM base WHERE id=OLD.id; END",
  ],
  [
    { sql: "INSERT INTO visible VALUES (3,'c')" },
    { sql: "UPDATE visible SET v='updated' WHERE id=2" },
    { sql: "DELETE FROM visible WHERE id=1" },
    { sql: "SELECT * FROM base ORDER BY id", query: true },
  ],
);
