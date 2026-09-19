import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE scores(id INTEGER PRIMARY KEY, team TEXT, score INTEGER)",
  "INSERT INTO scores VALUES (1,'a',10),(2,'a',20),(3,'a',20),(4,'a',30),(5,'b',5)",
];

parity(
  "EXCLUDE NO OTHERS matches the default frame",
  data,
  "SELECT id,sum(score) OVER (ORDER BY score,id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS) running FROM scores ORDER BY id",
);

parity(
  "EXCLUDE CURRENT ROW omits the current row from the frame",
  data,
  "SELECT id,sum(score) OVER (ORDER BY score,id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) running FROM scores ORDER BY id",
);

parity(
  "EXCLUDE GROUP omits peer rows from the frame",
  data,
  "SELECT id,sum(score) OVER (ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE GROUP) running FROM scores ORDER BY id",
);

parity(
  "EXCLUDE TIES omits peers but keeps the current row",
  data,
  "SELECT id,sum(score) OVER (ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) running FROM scores ORDER BY id",
);

parity(
  "EXCLUDE CURRENT ROW with RANGE frame",
  data,
  "SELECT id,sum(score) OVER (ORDER BY score RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) running FROM scores ORDER BY id",
);
