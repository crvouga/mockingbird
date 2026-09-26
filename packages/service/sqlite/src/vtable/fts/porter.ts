/** Classic Porter stemming algorithm (English). */
export function porterStem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 2) return w;

  // Step 1a
  if (w.endsWith("sses")) w = `${w.slice(0, -2)}`;
  else if (w.endsWith("ies")) w = `${w.slice(0, -2)}`;
  else if (w.endsWith("ss")) {
    /* keep */
  } else if (w.endsWith("s") && w.length > 3) w = w.slice(0, -1);

  // Step 1b
  let step1bStar = false;
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -3);
    if (measure(stem) > 0) w = `${stem}ee`;
  } else {
    let stem: string | null = null;
    if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) stem = w.slice(0, -2);
    else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) stem = w.slice(0, -3);
    if (stem !== null) {
      w = stem;
      step1bStar = true;
    }
  }
  if (step1bStar) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w = `${w}e`;
    else if (doubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w = `${w}e`;
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  // Step 2
  for (const [suf, rep] of STEP2) {
    if (w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length);
      if (measure(stem) > 0) {
        w = stem + rep;
        break;
      }
    }
  }

  // Step 3
  for (const [suf, rep] of STEP3) {
    if (w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length);
      if (measure(stem) > 0) {
        w = stem + rep;
        break;
      }
    }
  }

  // Step 4
  for (const suf of STEP4) {
    if (w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length);
      if (measure(stem) > 1) {
        w = stem;
        break;
      }
    }
  }
  if (w.endsWith("ion")) {
    const stem = w.slice(0, -3);
    if (measure(stem) > 1 && /[st]$/.test(stem)) w = stem;
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) w = stem;
  }

  // Step 5b
  if (measure(w) > 1 && doubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);

  return w;
}

const STEP2: Array<[string, string]> = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
];

const STEP3: Array<[string, string]> = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];

const STEP4 = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
];

function isConsonant(word: string, i: number): boolean {
  const c = word[i]!;
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

function measure(word: string): number {
  let m = 0;
  let i = 0;
  const n = word.length;
  while (i < n && isConsonant(word, i)) i++;
  while (i < n) {
    while (i < n && !isConsonant(word, i)) i++;
    while (i < n && isConsonant(word, i)) i++;
    m++;
  }
  return m;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (!isConsonant(word, i)) return true;
  return false;
}

function doubleConsonant(word: string): boolean {
  const n = word.length;
  if (n < 2) return false;
  return word[n - 1] === word[n - 2] && isConsonant(word, n - 1);
}

function cvc(word: string): boolean {
  const n = word.length;
  if (n < 3) return false;
  if (!isConsonant(word, n - 1) || isConsonant(word, n - 2) || !isConsonant(word, n - 3)) return false;
  const last = word[n - 1]!;
  return last !== "w" && last !== "x" && last !== "y";
}
