-- Generated columns are omitted from PRAGMA table_info (visible in table_xinfo).
CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, g INT GENERATED ALWAYS AS (a + 1) STORED);
SELECT name FROM pragma_table_info('t') ORDER BY cid;
SELECT name, hidden FROM pragma_table_xinfo('t') WHERE name = 'g';
