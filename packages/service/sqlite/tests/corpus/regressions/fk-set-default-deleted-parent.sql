-- Regression: ON DELETE SET DEFAULT must fail when the default key is the parent row being deleted.
PRAGMA foreign_keys=ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY);
CREATE TABLE child(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER DEFAULT 1,
  FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE SET DEFAULT MATCH FULL
);
INSERT INTO parent(id) VALUES (1);
INSERT INTO child(id, parent_id) VALUES (10, 1);
DELETE FROM parent WHERE id = 1;
SELECT id, parent_id FROM child ORDER BY id;
