-- Recursive CTEs: numeric sequence and a hierarchy walk with depth tracking.
CREATE TABLE org (id int PRIMARY KEY, parent_id int, name text NOT NULL);
INSERT INTO org VALUES (1, NULL, 'root');
INSERT INTO org VALUES (2, 1, 'eng');
INSERT INTO org VALUES (3, 1, 'sales');
INSERT INTO org VALUES (4, 2, 'platform');
INSERT INTO org VALUES (5, 2, 'product');
INSERT INTO org VALUES (6, 4, 'infra');
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 10) SELECT n, n * n AS sq FROM seq ORDER BY n;
WITH RECURSIVE tree(id, name, depth) AS (SELECT id, name, 0 FROM org WHERE parent_id IS NULL UNION ALL SELECT o.id, o.name, t.depth + 1 FROM org o JOIN tree t ON o.parent_id = t.id) SELECT id, name, depth FROM tree ORDER BY id;
WITH RECURSIVE up(id, name, parent_id) AS (SELECT id, name, parent_id FROM org WHERE id = 6 UNION ALL SELECT o.id, o.name, o.parent_id FROM org o JOIN up u ON o.id = u.parent_id) SELECT id, name FROM up ORDER BY id;
