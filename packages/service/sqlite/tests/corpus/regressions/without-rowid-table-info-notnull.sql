-- WITHOUT ROWID PK columns report notnull=1 in PRAGMA table_info.
CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT) WITHOUT ROWID;
SELECT cid, name, type, "notnull", pk FROM pragma_table_info('t') ORDER BY cid;
