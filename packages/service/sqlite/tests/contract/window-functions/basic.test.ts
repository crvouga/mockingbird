import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE scores(team TEXT,player TEXT,score INTEGER)",
  "INSERT INTO scores VALUES ('a','amy',10),('a','ann',20),('a','ava',20),('b','bob',5),('b','ben',15)",
];

parity(
  "row_number numbers rows within partitions",
  data,
  "SELECT team,player,row_number() OVER (PARTITION BY team ORDER BY score,player) rn FROM scores ORDER BY team,rn",
);
parity(
  "rank and dense_rank handle ties",
  data,
  "SELECT player,score,rank() OVER (ORDER BY score DESC) r,dense_rank() OVER (ORDER BY score DESC) d FROM scores ORDER BY score DESC,player",
);
parity(
  "lag and lead access adjacent rows",
  data,
  "SELECT player,score,lag(score) OVER (ORDER BY score,player) prev,lead(score) OVER (ORDER BY score,player) next FROM scores ORDER BY score,player",
);
parity(
  "window aggregate computes running total",
  data,
  "SELECT player,score,sum(score) OVER (ORDER BY score,player ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) running FROM scores ORDER BY score,player",
);
parity(
  "partitioned window aggregate repeats group total",
  data,
  "SELECT team,player,sum(score) OVER (PARTITION BY team) total FROM scores ORDER BY team,player",
);
