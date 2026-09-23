import { parity, parityTyped } from "../helpers.ts";

parity("current_database", [], "SELECT current_database() AS v");
parity("current_schema", [], "SELECT current_schema() AS v");
parity("current_user", [], "SELECT current_user AS v");
parity("session_user", [], "SELECT session_user AS v");
parity("user keyword", [], "SELECT user AS v");
parity("current_catalog", [], "SELECT current_catalog AS v");
parityTyped("current_schema type", [], "SELECT current_schema() AS v");
parity("current_schemas", [], "SELECT current_schemas(false) AS v");
parity("version reports postgres major", [], "SELECT version() LIKE 'PostgreSQL 18%' AS v");
parity("current_setting server_version_num major", [], "SELECT left(current_setting('server_version_num'), 2) AS v");
