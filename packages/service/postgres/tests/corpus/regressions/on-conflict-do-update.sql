-- ON CONFLICT DO UPDATE / DO NOTHING with EXCLUDED references and a conditional update.
CREATE TABLE kv (k int PRIMARY KEY, v text NOT NULL, hits int NOT NULL DEFAULT 1);
INSERT INTO kv (k, v) VALUES (1, 'one');
INSERT INTO kv (k, v) VALUES (2, 'two');
INSERT INTO kv (k, v) VALUES (1, 'uno') ON CONFLICT (k) DO UPDATE SET v = excluded.v, hits = kv.hits + 1;
INSERT INTO kv (k, v) VALUES (3, 'three') ON CONFLICT (k) DO UPDATE SET v = excluded.v, hits = kv.hits + 1;
INSERT INTO kv (k, v) VALUES (2, 'dos') ON CONFLICT (k) DO NOTHING;
INSERT INTO kv (k, v) VALUES (1, 'ein') ON CONFLICT (k) DO UPDATE SET v = excluded.v || excluded.v, hits = kv.hits + 1 WHERE kv.hits < 5;
INSERT INTO kv (k, v) VALUES (3, 'tres') ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE kv.v = 'nope';
SELECT k, v, hits FROM kv ORDER BY k;
