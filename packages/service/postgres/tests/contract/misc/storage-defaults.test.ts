import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "pg_dump storage defaults and session controls (#430)",
  [],
  [
    { sql: "SET default_tablespace = ''" },
    { sql: "SET default_table_access_method = heap" },
    { sql: "SHOW default_tablespace", query: true },
    { sql: "SHOW default_table_access_method", query: true },
    { sql: "CREATE TABLE dump_rows (id int)" },
    { sql: "BEGIN" },
    { sql: "SELECT set_config('default_tablespace', 'pg_default', true)", query: true },
    { sql: "SELECT current_setting('default_tablespace')", query: true },
    { sql: "ROLLBACK" },
    { sql: "SHOW default_tablespace", query: true },
    { sql: "SET default_tablespace = pg_default" },
    { sql: "RESET default_tablespace" },
    { sql: "RESET default_table_access_method" },
    { sql: "SHOW default_tablespace", query: true },
    { sql: "SHOW default_table_access_method", query: true },
  ],
);
errorParity("unknown access methods fail (#430)", [], "SET default_table_access_method = imaginary");
errorParity("unknown tablespaces fail (#430)", [], "SET default_tablespace = imaginary");
errorParity("unknown GUCs still fail (#430)", [], "SET imaginary_setting = heap");
errorParity(
  "set_config validates storage settings (#430)",
  [],
  "SELECT set_config('default_table_access_method', 'imaginary', false)",
);
