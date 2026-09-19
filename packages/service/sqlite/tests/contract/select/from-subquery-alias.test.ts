import { parity } from "../helpers.ts";

/** Oracle accepts FROM (SELECT …) without an alias; sqlite-mem currently requires one. */
parity("subquery in FROM with explicit alias", [], "SELECT v FROM (SELECT 1 AS v) AS q");
