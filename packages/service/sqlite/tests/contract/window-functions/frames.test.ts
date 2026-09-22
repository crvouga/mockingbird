import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE scores(team TEXT, player TEXT, score INTEGER)",
  "INSERT INTO scores VALUES ('a','amy',10),('a','ann',20),('a','ava',30),('b','bob',5),('b','ben',15)",
];

parity(
  "value window functions honor their frames",
  data,
  "SELECT team,player,first_value(score) OVER (PARTITION BY team ORDER BY score) first_score,last_value(score) OVER (PARTITION BY team ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) last_score,nth_value(score,2) OVER (PARTITION BY team ORDER BY score) second_score FROM scores ORDER BY team,score",
);

parity(
  "ROWS frame includes preceding and following rows",
  data,
  "SELECT player,score,sum(score) OVER (ORDER BY score ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) nearby FROM scores ORDER BY score",
);

parity(
  "named WINDOW clause resolves partition and order",
  data,
  "SELECT team,player,row_number() OVER w rn,sum(score) OVER w running FROM scores WINDOW w AS (PARTITION BY team ORDER BY score) ORDER BY team,rn",
);

parity(
  "ordered aggregate window uses SQLite default peer frame",
  ["CREATE TABLE values_table(id INTEGER, value INTEGER)", "INSERT INTO values_table VALUES (1,10),(2,10),(3,20)"],
  "SELECT id,value,sum(value) OVER (ORDER BY value) running FROM values_table ORDER BY id",
);
