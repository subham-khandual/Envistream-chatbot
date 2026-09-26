
import { readFileSync } from "fs";

const src = readFileSync("src/components/chat/Chat.jsx", "utf8");

const startMarker = "// ---- Female voice selection";
const endMarker = "// ---- (end of female voice selection) ----";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start === -1 || end === -1) {
  console.error("Could not locate the voice-selection block in Chat.jsx");
  process.exit(1);
}
const block = src.slice(start, end + endMarker.length);

const factory = new Function(
  `${block}
   return { getSweetVoice, isMaleVoice, isFemaleVoice };`
);
const { getSweetVoice, isMaleVoice } = factory();

const v = (name, lang) => ({ name, lang, gender: undefined });
const mkSynth = (voices) => ({ getVoices: () => voices });

// --- Real-world voice lists ---------------------------------------------
const LISTS = {
  "Edge / Windows 11 (full Azure set)": [
    v("Microsoft Swara Online (Natural) - Hindi (India)", "hi-IN"),
    v("Microsoft Madhur Online (Natural) - Hindi (India)", "hi-IN"),
    v("Microsoft Neerja Online (Natural) - English (India)", "en-IN"),
    v("Microsoft Prabhat Online (Natural) - English (India)", "en-IN"),
    v("Microsoft Aria Online (Natural) - English (United States)", "en-US"),
    v("Microsoft Guy Online (Natural) - English (United States)", "en-US"),
    v("Microsoft Hemant - Hindi (India)", "hi-IN"),
    v("Microsoft David - English (United States)", "en-US"),
    v("Microsoft Zira - English (United States)", "en-US"),
  ],
  "Windows 10 + Chrome (limited set)": [
    v("Google हिन्दी", "hi-IN"),
    v("Microsoft Hemant - Hindi (India)", "hi-IN"),
    v("Google US English", "en-US"),
    v("Google UK English Male", "en-GB"),
    v("Google UK English Female", "en-GB"),
    v("Microsoft David - English (United States)", "en-US"),
  ],
  "Only male Hindi + female English installed": [
    v("Microsoft Hemant - Hindi (India)", "hi-IN"),
    v("Microsoft David - English (United States)", "en-US"),
    v("Microsoft Zira - English (United States)", "en-US"),
  ],
  "Only male voices installed": [
    v("Microsoft Hemant - Hindi (India)", "hi-IN"),
    v("Microsoft David - English (United States)", "en-US"),
  ],
  "Single-language Windows (male Hindi only)": [
    v("Microsoft Hemant - Hindi (India)", "hi-IN"),
  ],
  "Empty list (voices not loaded yet)": [],
};

const MALE_PATTERN = /hemant|madhur|david|guy|ravi|prabhat|\bmale\b/i;

let failures = 0;
const check = (label, actual, { expectName, expectNull, mustNotBeMale }) => {
  let ok = true;
  if (expectNull) {
    ok = actual === null;
  } else if (expectName) {
    ok = actual && actual.name === expectName;
  }
  if (ok && mustNotBeMale && actual && MALE_PATTERN.test(actual.name)) ok = false;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n      -> ${actual ? `${actual.name} (${actual.lang})` : "null (pitch-boosted fallback)"}`
  );
};

for (const [listName, voices] of Object.entries(LISTS)) {
  const synth = mkSynth(voices);
  console.log(`\n=== ${listName} ===`);
  const voice = getSweetVoice(synth);

  if (!voices.length) {
    check("No voices loaded yet -> null", voice, { expectNull: true });
    continue;
  }
  check("One voice for both languages, never male", voice, { mustNotBeMale: true });
  // The SAME voice object must come back on every call (voice list unchanged),
  // i.e. Hinglish and English replies can never switch to a different speaker.
  check("Second call returns the same speaker", getSweetVoice(synth), {
    expectName: voice ? voice.name : undefined,
    expectNull: !voice,
  });
}

// --- Targeted expectations ----------------------------------------------
console.log("\n=== Expected winners (ONE voice for both languages) ===");
const edge = mkSynth(LISTS["Edge / Windows 11 (full Azure set)"]);
check("Edge -> Swara (used for Hinglish AND English)", getSweetVoice(edge), {
  expectName: "Microsoft Swara Online (Natural) - Hindi (India)",
});

const chrome = mkSynth(LISTS["Windows 10 + Chrome (limited set)"]);
check("Chrome -> Google हिन्दी", getSweetVoice(chrome), {
  expectName: "Google हिन्दी",
});
// In this list Google हिन्दी wins; the male voices (Hemant/David/UK Male)
// must NEVER be chosen.
check("Chrome never picks a male voice", getSweetVoice(chrome), {
  mustNotBeMale: true,
});

const noHindiFemale = mkSynth(LISTS["Only male Hindi + female English installed"]);
check("No Hindi female -> borrows female English voice", getSweetVoice(noHindiFemale), {
  expectName: "Microsoft Zira - English (United States)",
});

// The exact reported bug: only a MALE Hindi voice is installed. Sayraa must
// NOT use Hemant — she falls back to a pitch-lifted voice instead.
const maleOnly = mkSynth(LISTS["Single-language Windows (male Hindi only)"]);
check("Only male Hindi voice -> never Hemant", getSweetVoice(maleOnly), {
  expectNull: true,
});

// --- speakText uses ONE sweet voice + sweet pitch for both languages ------
console.log("\n=== speakText configuration ===");
const speakStart = src.indexOf("const speakText = useCallback");
const speakEnd = src.indexOf("}, []);", speakStart);
const speakBlock = src.slice(speakStart, speakEnd);
const speakChecks = [
  ["uses getSweetVoice (single voice)", /getSweetVoice\(synth\)/.test(speakBlock)],
  ["sweet pitch 1.2 for female voices", /pitch = isFemaleVoice\(voice\) \? 1\.2/.test(speakBlock)],
  ["chosen voice's own language is used (not forced per language)", /utterance\.lang = voice\.lang/.test(speakBlock)],
];
for (const [label, ok] of speakChecks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// --- isMaleVoice unit checks -------------------------------------------
console.log("\n=== isMaleVoice classification ===");
const cases = [
  ["Microsoft Samantha - English (United States)", false],
  ["Google UK English Female", false],
  ["Google UK English Male", true],
  ["Microsoft Hemant - Hindi (India)", true],
  ["Microsoft Swara Online (Natural) - Hindi (India)", false],
  ["Microsoft Neerja Online (Natural) - English (India)", false],
  ["Microsoft Madhur Online (Natural) - Hindi (India)", true],
  ["Google हिन्दी", false],
  // Regression guards: these were wrongly listed as male in an earlier version
  // (Suvi is a Finnish FEMALE voice) — they must stay female.
  ["Microsoft Suvi - Finnish (Finland)", false],
  ["Microsoft Noora Online (Natural) - Finnish (Finland)", false],
  // Female markers that merely CONTAIN a male-looking substring must not match
  ["Microsoft Paulina - Spanish (Mexico)", false],
  ["Microsoft Yating - Chinese (Taiwan)", false],
];
for (const [name, expectedMale] of cases) {
  const actual = isMaleVoice(v(name, "xx-XX"));
  const ok = actual === expectedMale;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} -> male=${actual} (expected ${expectedMale})`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
