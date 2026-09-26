/** SQLite 3.51 `sqlite3AtoF` (decimal text → IEEE754 double). */
// biome-ignore-all lint/correctness/noPrecisionLoss: Dekker constants match SQLite C double literals

const U64_MASK = (1n << 64n) - 1n;
const LARGEST_UINT64 = U64_MASK;

export function dekkerMul2(rr: [number, number], y: number, yy: number): void {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, rr[0], true);
  let m = view.getBigUint64(0, true) & 0xfffffffffc000000n;
  view.setBigUint64(0, m, true);
  const hx = view.getFloat64(0, true);
  const tx = rr[0] - hx;

  view.setFloat64(0, y, true);
  m = view.getBigUint64(0, true) & 0xfffffffffc000000n;
  view.setBigUint64(0, m, true);
  const hy = view.getFloat64(0, true);
  const ty = y - hy;

  const p = hx * hy;
  const q = hx * ty + tx * hy;
  const c = p + q;
  let cc = p - c + q + tx * ty;
  cc = rr[0] * yy + rr[1] * y + cc;
  rr[0] = c + cc;
  rr[1] = c - rr[0];
  rr[1] += cc;
}

function isDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** Parse a decimal float text literal the way SQLite 3.51 does. */
export function sqliteAtoF(zIn: string): number {
  const zEnd = zIn.length;
  let z = 0;

  let sign = 1;
  let s = 0n;
  let d = 0;
  let esign = 1;
  let e = 0;

  while (z < zEnd && isSpace(zIn[z])) z++;
  if (z >= zEnd) return 0;

  if (zIn[z] === "-") {
    sign = -1;
    z++;
  } else if (zIn[z] === "+") {
    z++;
  }

  while (z < zEnd && isDigit(zIn[z])) {
    s = s * 10n + BigInt(zIn.charCodeAt(z) - 48);
    z++;
    if (s >= (LARGEST_UINT64 - 9n) / 10n) {
      while (z < zEnd && isDigit(zIn[z])) {
        z++;
        d++;
      }
      break;
    }
  }
  if (z >= zEnd) return finishAtoF(sign, s, e, d, esign);

  if (zIn[z] === ".") {
    z++;
    while (z < zEnd && isDigit(zIn[z])) {
      if (s < (LARGEST_UINT64 - 9n) / 10n) {
        s = s * 10n + BigInt(zIn.charCodeAt(z) - 48);
        d--;
      }
      z++;
    }
  }
  if (z >= zEnd) return finishAtoF(sign, s, e, d, esign);

  if (zIn[z] === "e" || zIn[z] === "E") {
    z++;
    if (z >= zEnd) return finishAtoF(sign, s, e, d, esign);

    if (zIn[z] === "-") {
      esign = -1;
      z++;
    } else if (zIn[z] === "+") {
      z++;
    }

    while (z < zEnd && isDigit(zIn[z])) {
      e = e < 10000 ? e * 10 + (zIn.charCodeAt(z) - 48) : 10000;
      z++;
    }
  }

  while (z < zEnd && isSpace(zIn[z])) z++;
  return finishAtoF(sign, s, e, d, esign);
}

function finishAtoF(sign: number, s: bigint, e: number, d: number, esign: number): number {
  if (s === 0n) return sign < 0 ? -0 : 0;

  e = esign * e + d;

  while (e > 0 && s < (LARGEST_UINT64 - 0x7ffn) / 10n) {
    s *= 10n;
    e--;
  }
  while (e < 0 && s % 10n === 0n) {
    s /= 10n;
    e++;
  }

  const rr: [number, number] = [Number(s), 0];
  const maxSafeU64Double = 18446744073709549568.0;
  if (rr[0] <= maxSafeU64Double) {
    const s2 = BigInt(Math.trunc(rr[0]));
    rr[1] = s >= s2 ? Number(s - s2) : -Number(s2 - s);
  } else {
    rr[1] = 0;
  }

  if (e > 0) {
    while (e >= 100) {
      e -= 100;
      dekkerMul2(rr, 1.0e100, -1.5902891109759918046e83);
    }
    while (e >= 10) {
      e -= 10;
      dekkerMul2(rr, 1.0e10, 0.0);
    }
    while (e >= 1) {
      e -= 1;
      dekkerMul2(rr, 1.0e1, 0.0);
    }
  } else {
    while (e <= -100) {
      e += 100;
      dekkerMul2(rr, 1.0e-100, -1.99918998026028836196e-117);
    }
    while (e <= -10) {
      e += 10;
      dekkerMul2(rr, 1.0e-10, -3.6432197315497741579e-27);
    }
    while (e <= -1) {
      e += 1;
      dekkerMul2(rr, 1.0e-1, -5.5511151231257827021e-18);
    }
  }

  let result = rr[0] + rr[1];
  if (Number.isNaN(result)) result = 1e300 * 1e300;
  return sign < 0 ? -result : result;
}
