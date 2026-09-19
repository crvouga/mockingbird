import { parity } from "../helpers.ts";

parity("justify_hours basic", [], "SELECT justify_hours(interval '27 hours') AS v");
parity("justify_hours large", [], "SELECT justify_hours(interval '100 hours') AS v");
parity("justify_hours no-op", [], "SELECT justify_hours(interval '23 hours') AS v");
parity("justify_days basic", [], "SELECT justify_days(interval '35 days') AS v");
parity("justify_days large", [], "SELECT justify_days(interval '400 days') AS v");
parity("justify_days no-op", [], "SELECT justify_days(interval '29 days') AS v");
parity("justify_interval combines", [], "SELECT justify_interval(interval '1 month -1 hour') AS v");
parity("justify_interval hours and days", [], "SELECT justify_interval(interval '35 days 27 hours') AS v");
parity("justify_hours negative", [], "SELECT justify_hours(interval '-27 hours') AS v");
parity("justify_days negative", [], "SELECT justify_days(interval '-35 days') AS v");
parity("justify_interval mixed negative", [], "SELECT justify_interval(interval '1 month -35 days') AS v");
