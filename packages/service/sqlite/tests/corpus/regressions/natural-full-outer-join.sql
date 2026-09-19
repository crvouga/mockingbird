-- Regression: NATURAL FULL OUTER JOIN unmatched right rows keep right-side USING values.
CREATE TABLE l(a INT, b INT);
CREATE TABLE r(a INT, b INT);
INSERT INTO l VALUES (1, 10);
INSERT INTO r VALUES (1, 10), (2, 20);
SELECT * FROM l NATURAL FULL OUTER JOIN r ORDER BY a, b;
