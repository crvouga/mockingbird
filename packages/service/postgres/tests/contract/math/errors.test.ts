import { queryErrorParity } from "../helpers.ts";

queryErrorParity("integer division by zero", [], "SELECT 1 / 0", "division_by_zero");
queryErrorParity("int8 division by zero", [], "SELECT 1::int8 / 0", "division_by_zero");
queryErrorParity("float division by zero", [], "SELECT 1::float8 / 0", "division_by_zero");
queryErrorParity("modulo by zero", [], "SELECT 1 % 0", "division_by_zero");
queryErrorParity("mod function by zero", [], "SELECT mod(1, 0)", "division_by_zero");
queryErrorParity("sqrt of negative float", [], "SELECT sqrt(-1::float8)", "data_exception");
queryErrorParity("ln of zero", [], "SELECT ln(0::float8)", "data_exception");
queryErrorParity("ln of negative", [], "SELECT ln(-1::float8)", "data_exception");
queryErrorParity("acos out of domain", [], "SELECT acos(2::float8)", "numeric_out_of_range");
queryErrorParity("asin out of domain", [], "SELECT asin(-2::float8)", "numeric_out_of_range");
