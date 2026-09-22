/**
 * SQLite 3.51 REAL → text formatting (`%!.15g`), ported from sqlite3FpDecode + etGENERIC.
 */
// biome-ignore-all lint/correctness/noPrecisionLoss: Dekker constants match SQLite C double literals

import { dekkerMul2 } from "./sqlite-atof.ts";

const ZBUF_SIZE = 32;

interface FpDecode {
  iDP: number;
  n: number;
  z: string[];
  sign: "-" | "+";
  isSpecial: number;
}

function doubleToU64(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.trunc(value));
}

/** Port of sqlite3FpDecode (sqlite3.c ~36884). */
function fpDecode(r: number, iRound: number, mxRound: number): FpDecode {
  const zBuf = new Array<string>(ZBUF_SIZE).fill("0");
  let sign: "-" | "+" = "+";
  let isSpecial = 0;

  if (r < 0) {
    sign = "-";
    r = -r;
  } else if (r === 0) {
    return { sign: "+", isSpecial: 0, iDP: 1, n: 1, z: ["0"] };
  }

  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, r, true);
  const bits = view.getBigUint64(0, true);
  const e = Number(bits >> 52n);
  if ((e & 0x7ff) === 0x7ff) {
    isSpecial = bits === 0x7ff0000000000000n ? 1 : 2;
    return { sign, isSpecial, iDP: 0, n: 0, z: [] };
  }

  const rr: [number, number] = [r, 0];
  let exp = 0;

  if (rr[0] > 9.223372036854774784e18) {
    while (rr[0] > 9.223372036854774784e118) {
      exp += 100;
      dekkerMul2(rr, 1.0e-100, -1.99918998026028836196e-117);
    }
    while (rr[0] > 9.223372036854774784e28) {
      exp += 10;
      dekkerMul2(rr, 1.0e-10, -3.6432197315497741579e-27);
    }
    while (rr[0] > 9.223372036854774784e18) {
      exp += 1;
      dekkerMul2(rr, 1.0e-1, -5.5511151231257827021e-18);
    }
  } else {
    while (rr[0] < 9.223372036854774784e-83) {
      exp -= 100;
      dekkerMul2(rr, 1.0e100, -1.5902891109759918046e83);
    }
    while (rr[0] < 9.223372036854774784e7) {
      exp -= 10;
      dekkerMul2(rr, 1.0e10, 0.0);
    }
    while (rr[0] < 9.22337203685477478e17) {
      exp -= 1;
      dekkerMul2(rr, 1.0e1, 0.0);
    }
  }

  let v = rr[1] < 0 ? doubleToU64(rr[0]) - doubleToU64(-rr[1]) : doubleToU64(rr[0]) + doubleToU64(rr[1]);

  let i = ZBUF_SIZE - 1;
  while (v > 0n) {
    zBuf[i--] = String(Number(v % 10n));
    v /= 10n;
  }

  let n = ZBUF_SIZE - 1 - i;
  let iDP = n + exp;

  let roundAt = iRound;
  if (roundAt <= 0) {
    roundAt = iDP - roundAt;
    if (roundAt === 0 && zBuf[i + 1]! >= "5") {
      roundAt = 1;
      zBuf[i--] = "0";
      n++;
      iDP++;
    }
  }

  if (roundAt > 0 && (roundAt < n || n > mxRound)) {
    const zStart = i + 1;
    if (roundAt > mxRound) roundAt = mxRound;
    n = roundAt;
    if (zBuf[zStart + roundAt]! >= "5") {
      let j = roundAt - 1;
      while (true) {
        const ch = zBuf[zStart + j]!;
        if (ch < "9") {
          zBuf[zStart + j] = String.fromCharCode(ch.charCodeAt(0) + 1);
          break;
        }
        zBuf[zStart + j] = "0";
        if (j === 0) {
          zBuf[i--] = "1";
          n++;
          iDP++;
          break;
        }
        j--;
      }
    }
  }

  while (n > 0 && zBuf[i + n] === "0") n--;

  return { sign, isSpecial, iDP, n, z: zBuf.slice(i + 1, i + 1 + n) };
}

function appendDigits(parts: string[], s: FpDecode, j: number, count: number): number {
  for (let k = 0; k < count; k++) {
    parts.push(j < s.n ? s.z[j++]! : "0");
  }
  return j;
}

/** `%!.15g` for REAL→TEXT (etGENERIC + flag_altform2). */
export function formatRealAsTextSqlite(value: number): string {
  if (Object.is(value, -0)) return "0.0";
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "Inf" : "-Inf";
  }
  if (value === 0) return "0.0";

  const s = fpDecode(value, 15, 26);
  if (s.isSpecial === 2) return "NaN";
  if (s.isSpecial === 1) return s.sign === "-" ? "-Inf" : "Inf";

  let precision = 15;
  const exp = s.iDP - 1;
  precision--;

  let useExp: boolean;
  if (exp < -4 || exp > precision) {
    useExp = true;
  } else {
    precision -= exp;
    useExp = false;
  }

  const parts: string[] = [];
  if (s.sign === "-") parts.push("-");

  const e2 = useExp ? 0 : s.iDP - 1;
  let j = 0;
  if (e2 < 0) {
    parts.push("0");
  } else {
    for (let e = e2; e >= 0; e--) {
      parts.push(j < s.n ? s.z[j++]! : "0");
    }
  }

  parts.push(".");

  let e = e2 + 1;
  let prec = precision;
  while (e < 0 && prec > 0) {
    parts.push("0");
    prec--;
    e++;
  }
  j = appendDigits(parts, s, j, prec);

  let end = parts.length;
  while (end > 0 && parts[end - 1] === "0") end--;
  if (end > 0 && parts[end - 1] === ".") {
    parts.splice(end, 0, "0");
    end++;
  }

  let out = parts.slice(0, end).join("");

  if (useExp) {
    out += "e";
    if (exp < 0) {
      out += "-";
      let absExp = -exp;
      if (absExp >= 100) {
        out += String(Math.floor(absExp / 100));
        absExp %= 100;
      }
      out += String(Math.floor(absExp / 10));
      out += String(absExp % 10);
    } else {
      out += "+";
      let absExp = exp;
      if (absExp >= 100) {
        out += String(Math.floor(absExp / 100));
        absExp %= 100;
      }
      out += String(Math.floor(absExp / 10));
      out += String(absExp % 10);
    }
  }

  return out;
}
