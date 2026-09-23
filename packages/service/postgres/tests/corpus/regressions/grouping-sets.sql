-- GROUPING SETS / ROLLUP / CUBE with GROUPING() disambiguation.
CREATE TABLE sales (id int PRIMARY KEY, region text NOT NULL, product text NOT NULL, amount int NOT NULL);
INSERT INTO sales VALUES (1, 'east', 'ax', 10);
INSERT INTO sales VALUES (2, 'east', 'bx', 20);
INSERT INTO sales VALUES (3, 'west', 'ax', 30);
INSERT INTO sales VALUES (4, 'west', 'bx', 40);
INSERT INTO sales VALUES (5, 'west', 'ax', 5);
SELECT region, product, sum(amount) AS total FROM sales GROUP BY GROUPING SETS ((region, product), (region), ()) ORDER BY GROUPING(region, product), region, product;
SELECT region, product, sum(amount) AS total, GROUPING(region, product) AS gid FROM sales GROUP BY ROLLUP (region, product) ORDER BY gid, region, product;
SELECT region, product, count(*) AS n FROM sales GROUP BY CUBE (region, product) ORDER BY GROUPING(region, product), region, product;
SELECT region, sum(amount) AS total FROM sales GROUP BY ROLLUP (region) HAVING sum(amount) > 20 ORDER BY GROUPING(region), region;
