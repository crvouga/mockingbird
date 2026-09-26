-- Regression: ROLLBACK must not rewind total_changes (SQLite keeps the counter).
CREATE TABLE t(id INTEGER PRIMARY KEY, a INT);
INSERT INTO t VALUES (1, 1);
BEGIN;
INSERT INTO t VALUES (2, 2);
ROLLBACK;
INSERT INTO t VALUES (3, 3);
SELECT total_changes() AS t, last_insert_rowid() AS r, id, a FROM t ORDER BY id;
