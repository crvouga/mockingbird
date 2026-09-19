import { errorParity, execParity, parity, sequenceParity } from "../helpers.ts";

const attachOther = "ATTACH ':memory:' AS other";

sequenceParity(
  "attach create insert select detach lifecycle",
  [],
  [
    { sql: attachOther },
    { sql: "CREATE TABLE other.t(id INTEGER, name TEXT)" },
    { sql: "INSERT INTO other.t VALUES (1, 'alpha')" },
    { sql: "SELECT id, name FROM other.t ORDER BY id", query: true },
    { sql: "PRAGMA database_list", query: true },
    { sql: "DETACH other" },
    { sql: "PRAGMA database_list", query: true },
  ],
);

parity(
  "select from attached table",
  [attachOther, "CREATE TABLE other.items(x INTEGER)", "INSERT INTO other.items VALUES (42)"],
  "SELECT x FROM other.items",
);

execParity("create table in attached schema", [attachOther], "CREATE TABLE other.meta(k TEXT)");

errorParity("attach rejects main schema name", [], "ATTACH ':memory:' AS main");
errorParity("attach rejects duplicate schema name", [attachOther], attachOther);
errorParity("detach unknown schema fails", [], "DETACH ghost");
