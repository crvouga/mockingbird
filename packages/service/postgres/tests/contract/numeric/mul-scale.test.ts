import { parity } from "../helpers.ts";

/** Chains enough multiplies to exceed MAX_DISPLAY_SCALE when uncapped. */
parity(
  "deep numeric multiply chain stays within PG scale limits",
  [],
  `SELECT (
    1.1::numeric * 1.1::numeric * 1.1::numeric * 1.1::numeric * 1.1::numeric *
    1.1::numeric * 1.1::numeric * 1.1::numeric * 1.1::numeric * 1.1::numeric
  )::text AS t`,
);
