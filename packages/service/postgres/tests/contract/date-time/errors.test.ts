import { queryErrorParity } from "../helpers.ts";

queryErrorParity("invalid month in date", [], "SELECT '2024-13-01'::date", "data_exception");
queryErrorParity("invalid day in date", [], "SELECT '2024-02-30'::date", "data_exception");
queryErrorParity("non leap year february 29", [], "SELECT '2023-02-29'::date", "data_exception");
queryErrorParity("garbage date text", [], "SELECT 'notadate'::date", "data_exception");
queryErrorParity("empty string date", [], "SELECT ''::date", "data_exception");
queryErrorParity("invalid time value", [], "SELECT '25:00:00'::time", "data_exception");
queryErrorParity("invalid minute value", [], "SELECT '10:61:00'::time", "data_exception");
queryErrorParity("make_date invalid month", [], "SELECT make_date(2024, 13, 1)", "data_exception");
queryErrorParity("make_date invalid day", [], "SELECT make_date(2023, 2, 29)", "data_exception");
