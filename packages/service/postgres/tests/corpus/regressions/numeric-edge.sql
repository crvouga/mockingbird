-- numeric(p,s): arithmetic scale propagation, rounding, casts, aggregates.
CREATE TABLE nums (id int PRIMARY KEY, x numeric(12,4) NOT NULL, y numeric(12,4) NOT NULL);
INSERT INTO nums VALUES (1, 1.5, 2.25);
INSERT INTO nums VALUES (2, -3.1000, 0.0001);
INSERT INTO nums VALUES (3, 12345678.9999, 1.0000);
INSERT INTO nums VALUES (4, 0.0000, -0.5000);
SELECT id, x + y AS s, x - y AS d, x * y AS p FROM nums ORDER BY id;
SELECT id, round(x, 2) AS r2, trunc(x, 1) AS t1, abs(x) AS ax FROM nums ORDER BY id;
SELECT id, x::int AS xi, x::text AS xt FROM nums ORDER BY id;
SELECT id, x % 2 AS xm FROM nums WHERE id < 3 ORDER BY id;
SELECT sum(x) AS total, min(x) AS lo, max(x) AS hi, count(*) AS n FROM nums;
SELECT 12345.6789::numeric(8,2) AS narrowed;
SELECT (-2.5)::numeric(4,0) AS away_from_zero, 2.5::numeric(4,0) AS also_away;
