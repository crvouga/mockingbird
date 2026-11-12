/** The built-in range types, by name: a dependency-free leaf so `value.ts` can build its tables from it. */
export const RANGE_SUBTYPES: Readonly<Record<string, string>> = {
  int4range: "int4",
  int8range: "int8",
  numrange: "numeric",
  daterange: "date",
  tsrange: "timestamp",
  tstzrange: "timestamptz",
};

/** pg_type oids of the range types and of their array types. */
export const RANGE_TYPE_OIDS: Readonly<Record<string, number>> = {
  int4range: 3904,
  numrange: 3906,
  tsrange: 3908,
  tstzrange: 3910,
  daterange: 3912,
  int8range: 3926,
};
export const RANGE_ARRAY_OIDS: Readonly<Record<string, number>> = {
  int4range: 3905,
  numrange: 3907,
  tsrange: 3909,
  tstzrange: 3911,
  daterange: 3913,
  int8range: 3927,
};

export function isRangeType(t: string): boolean {
  return RANGE_SUBTYPES[t] !== undefined;
}
