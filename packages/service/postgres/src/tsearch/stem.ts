/**
 * Porter2 (Snowball English) stemmer — the algorithm behind PostgreSQL's
 * `english` text search dictionary.
 */

const VOWELS = "aeiouy";

function isVowel(c: string): boolean {
  return VOWELS.includes(c);
}

function prelude(word: string): string {
  let w = word.replace(/^'/, "").replace(/'$/, "").replace(/'s$/, "").replace(/'$/, "");
  if (w.startsWith("y")) w = `Y${w.slice(1)}`;
  w = w.replace(/([aeiouy])y/g, "$1Y");
  return w;
}

function markRegions(w: string): { r1: number; r2: number } {
  let r1 = w.length;
  let r2 = w.length;
  // exceptional forms
  for (const prefix of ["gener", "commun", "arsen"]) {
    if (w.startsWith(prefix)) {
      r1 = prefix.length;
      break;
    }
  }
  if (r1 === w.length) {
    for (let i = 1; i < w.length; i++) {
      if (!isVowel(w[i]!) && isVowel(w[i - 1]!)) {
        r1 = i + 1;
        break;
      }
    }
  }
  for (let i = r1 + 1; i < w.length; i++) {
    if (!isVowel(w[i]!) && isVowel(w[i - 1]!)) {
      r2 = i + 1;
      break;
    }
  }
  return { r1, r2 };
}

function isShortSyllable(w: string, i: number): boolean {
  if (i === 0) {
    return w.length >= 2 && isVowel(w[0]!) && !isVowel(w[1]!);
  }
  return (
    isVowel(w[i]!) &&
    i + 1 < w.length &&
    !isVowel(w[i + 1]!) &&
    w[i + 1] !== "w" &&
    w[i + 1] !== "x" &&
    w[i + 1] !== "Y" &&
    i - 1 >= 0 &&
    !isVowel(w[i - 1]!)
  );
}

function isShortWord(w: string, r1: number): boolean {
  return r1 >= w.length && isShortSyllable(w, w.length - 2);
}

const EXCEPTIONS1: Record<string, string> = {
  skis: "ski",
  skies: "sky",
  dying: "die",
  lying: "lie",
  tying: "tie",
  idly: "idl",
  gently: "gentl",
  ugly: "ugli",
  early: "earli",
  only: "onli",
  singly: "singl",
  sky: "sky",
  news: "news",
  howe: "howe",
  atlas: "atlas",
  cosmos: "cosmos",
  bias: "bias",
  andes: "andes",
};

const EXCEPTIONS2 = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"]);

const DOUBLES = ["bb", "dd", "ff", "gg", "mm", "nn", "pp", "rr", "tt"];

function endsWithDouble(w: string): boolean {
  return DOUBLES.some((d) => w.endsWith(d));
}

const VALID_LI = "cdeghkmnrt";

export function stemEnglish(input: string): string {
  let w = input.toLowerCase();
  if (w.length <= 2) return w;
  if (EXCEPTIONS1[w] !== undefined) return EXCEPTIONS1[w]!;
  w = prelude(w);
  const { r1, r2 } = markRegions(w);

  // Step 0: strip 's / ' / 's'
  if (w.endsWith("'s'")) w = w.slice(0, -3);
  else if (w.endsWith("'s")) w = w.slice(0, -2);
  else if (w.endsWith("'")) w = w.slice(0, -1);

  // Step 1a
  if (w.endsWith("sses")) w = `${w.slice(0, -4)}ss`;
  else if (w.endsWith("ied") || w.endsWith("ies")) {
    w = w.slice(0, -3) + (w.length - 3 > 1 ? "i" : "ie");
  } else if (w.endsWith("ss") || w.endsWith("us")) {
    // no-op
  } else if (w.endsWith("s")) {
    const stem = w.slice(0, -1);
    if ([...stem.slice(0, -1)].some(isVowel)) w = stem;
  }

  if (EXCEPTIONS2.has(w)) return w;

  // Step 1b
  const step1bDone = ((): boolean => {
    if (w.endsWith("eedly")) {
      if (w.length - 5 >= r1) w = `${w.slice(0, -5)}ee`;
      return true;
    }
    if (w.endsWith("eed")) {
      if (w.length - 3 >= r1) w = `${w.slice(0, -3)}ee`;
      return true;
    }
    return false;
  })();
  if (!step1bDone) {
    for (const suffix of ["ingly", "edly", "ing", "ed"]) {
      if (w.endsWith(suffix)) {
        const stem = w.slice(0, -suffix.length);
        if ([...stem].some(isVowel)) {
          w = stem;
          if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
          else if (endsWithDouble(w)) w = w.slice(0, -1);
          else if (isShortWord(w, r1)) w += "e";
        }
        break;
      }
    }
  }

  // Step 1c
  if (w.length > 2 && (w.endsWith("y") || w.endsWith("Y")) && !isVowel(w[w.length - 2]!)) {
    w = `${w.slice(0, -1)}i`;
  }

  // Step 2
  const step2: Array<[string, string]> = [
    ["ization", "ize"],
    ["ational", "ate"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["iveness", "ive"],
    ["tional", "tion"],
    ["biliti", "ble"],
    ["lessli", "less"],
    ["entli", "ent"],
    ["ation", "ate"],
    ["alism", "al"],
    ["aliti", "al"],
    ["ousli", "ous"],
    ["iviti", "ive"],
    ["fulli", "ful"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["abli", "able"],
    ["izer", "ize"],
    ["ator", "ate"],
    ["alli", "al"],
    ["bli", "ble"],
  ];
  for (const [suffix, repl] of step2) {
    if (w.endsWith(suffix)) {
      if (w.length - suffix.length >= r1) w = w.slice(0, -suffix.length) + repl;
      break;
    }
  }
  if (w.endsWith("ogi") && w.length - 3 >= r1 && w[w.length - 4] === "l") {
    w = `${w.slice(0, -3)}og`;
  } else if (w.endsWith("li") && w.length - 2 >= r1 && VALID_LI.includes(w[w.length - 3] ?? "")) {
    if (!step2.some(([s]) => w.endsWith(s))) w = w.slice(0, -2);
  }

  // Step 3
  const step3: Array<[string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["alize", "al"],
    ["icate", "ic"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ness", ""],
    ["ful", ""],
  ];
  for (const [suffix, repl] of step3) {
    if (w.endsWith(suffix)) {
      if (w.length - suffix.length >= r1) w = w.slice(0, -suffix.length) + repl;
      break;
    }
  }
  if (w.endsWith("ative") && w.length - 5 >= r2) {
    w = w.slice(0, -5);
  }

  // Step 4
  const step4 = [
    "ement",
    "ance",
    "ence",
    "able",
    "ible",
    "ment",
    "ant",
    "ent",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
    "al",
    "er",
    "ic",
  ];
  for (const suffix of step4) {
    if (w.endsWith(suffix)) {
      if (w.length - suffix.length >= r2) w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.endsWith("ion") && w.length - 3 >= r2 && (w[w.length - 4] === "s" || w[w.length - 4] === "t")) {
    w = w.slice(0, -3);
  }

  // Step 5
  if (w.endsWith("e")) {
    if (w.length - 1 >= r2) w = w.slice(0, -1);
    else if (w.length - 1 >= r1 && !isShortSyllable(w, w.length - 3)) w = w.slice(0, -1);
  } else if (w.endsWith("ll") && w.length - 1 >= r2) {
    w = w.slice(0, -1);
  }

  return w.toLowerCase();
}
