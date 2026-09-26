// ---- Hinglish transcript text (Roman-script) ----
// Both mic paths can return Hindi in Devanagari script:
//   * Groq Whisper writes Hindi audio as Devanagari
//     ("इस्ट्रिम EduSkill का location कहां पर है।")
//   * Chrome's hi-IN recognizer does the same
// Sayraa must always SHOW and SEND Hinglish in Roman/English letters, so this
// module: 1) transliterates Devanagari -> Roman, 2) removes the repeated filler
// words Whisper hallucinated on noisy/silent audio ("आच्छे आच्छे आच्छे").
// Used by Chat.jsx and groqStt.js.

const INDIC_CONSONANTS = {
  // Devanagari (Hindi)
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "ळ": "l", "़": "",
};
const INDIC_VOWELS = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
  "ऑ": "o", "ऍ": "e",
};
const INDIC_MATRAS = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ॉ": "o", "ॅ": "e",
};
const INDIC_VIRAMAS = ["्"];
const INDIC_ANUSVARAS = ["ं", "ँ"];

// Devanagari letters -> Roman letters, e.g. "इस्ट्रिम" -> "istrim"
export const toEnglishLetters = (text) => {
  if (!text) return text;
  // Normalise nukta clusters first (ज़→ज, ड़→ड, ...) so they map cleanly
  const src = text
    .replace(/क़/g, "क").replace(/ख़/g, "ख").replace(/ग़/g, "ग")
    .replace(/ज़/g, "ज").replace(/ड़/g, "ड").replace(/ढ़/g, "ढ")
    .replace(/फ़/g, "फ").replace(/य़/g, "य");

  let out = "";
  let inherentAIndex = -1; // position of the implicit "a" after a consonant

  const dropInherentA = () => {
    if (inherentAIndex === out.length - 1) out = out.slice(0, -1);
    inherentAIndex = -1;
  };

  for (const ch of src) {
    if (INDIC_CONSONANTS[ch] !== undefined) {
      out += INDIC_CONSONANTS[ch] + "a";
      inherentAIndex = out.length - 1;
    } else if (INDIC_VIRAMAS.includes(ch)) {
      // Halant kills the implicit "a" (क् = "k" not "ka")
      dropInherentA();
    } else if (INDIC_MATRAS[ch]) {
      // Vowel sign replaces the implicit "a" (का = "ka" not "kaa"... etc.)
      dropInherentA();
      out += INDIC_MATRAS[ch];
    } else if (INDIC_VOWELS[ch]) {
      out += INDIC_VOWELS[ch];
      inherentAIndex = -1;
    } else if (INDIC_ANUSVARAS.includes(ch)) {
      out += "n";
      inherentAIndex = -1;
    } else if (ch === "ः") {
      out += "h";
      inherentAIndex = -1;
    } else if (ch === "।" || ch === "॥") {
      dropInherentA();
      out += ".";
    } else {
      // Spaces, punctuation, Latin letters etc. end the current word
      dropInherentA();
      out += ch;
    }
  }
  dropInherentA(); // word ends at end of string
  return out;
};

// Filler / hallucination words. Whisper invents these on quiet audio and the
// browser recognizer repeats them ("आच्छे आच्छे आच्छे" -> "aachchhe aachchhe
// aachchhe"). A word counts as filler when its SQUASHED form — letters only,
// every run of a repeated letter collapsed to one — is in this set. Squashing
// means every spelling of the same sound matches: achhe / acchhe / achchhe /
// aachchhe all squash to "ache" or "achche".
const squashWord = (word) =>
  (word || "")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "")
    .replace(/(.)\1+/g, "$1");

const FILLER_WORDS = new Set(
  [
    // "achha / achhe" family (the classic Whisper hallucination on silence)
    "acha", "achcha", "ache", "achche", "achchi", "acchi", "achha", "achho",
    // acknowledgement / filler
    "theek", "thik", "ok", "okay", "hmm", "hm", "um", "uh", "han", "hanji",
    "ji", "jee",
    // greetings
    "hello", "hlo", "hi", "hey", "namaste", "namaskar",
    // discourse markers
    "so", "yeah", "yah", "ya", "are", "arre", "oye",
    // thanks / sign-off
    "dhanyavaad", "dhanyavad", "shukriya", "thanks", "thank", "thankyou",
    "bye", "byebye",
  ].map(squashWord)
);

// A token is filler when its squashed form is a known filler word.
// Devanagari is transliterated first, so "आच्छे" is recognised exactly like
// "achhe"/"aachchhe" (callers may pass either script).
export const isFillerToken = (token) => {
  const squashed = squashWord(toEnglishLetters(token || ""));
  return !!squashed && FILLER_WORDS.has(squashed);
};

const tokenCore = (token) =>
  (token || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// Clean a mic transcript: collapse repeated words, drop leading/trailing filler.
export const cleanTranscript = (text) => {
  if (!text) return "";

  const starts = String(text).replace(/\s+/g, " ").trim();
  if (!starts) return "";

  // 1) Collapse consecutive repeats ("achhe achhe achhe" -> "achhe").
  //    Filler words never repeat; other words are allowed to repeat twice
  //    ("bahut bahut dhanyavaad" is real Hinglish).
  const collapsed = [];
  let runCount = 0;
  for (const token of starts.split(" ")) {
    if (!token) continue;
    const core = tokenCore(token);
    const prevCore = collapsed.length
      ? tokenCore(collapsed[collapsed.length - 1])
      : "";
    if (core && core === prevCore) {
      runCount += 1;
      const allowed = isFillerToken(token) ? 1 : 2;
      if (runCount > allowed) continue; // drop the extra hallucinated copy
      collapsed.push(token);
      continue;
    }
    runCount = 1;
    collapsed.push(token);
  }

  // 2) Strip leading/trailing filler while real words remain
  //    ("aachhe aachhe aachhe Envistream ... hai" -> "Envistream ... hai").
  while (collapsed.length > 2 && isFillerToken(collapsed[0])) {
    collapsed.shift();
  }
  while (collapsed.length > 2 && isFillerToken(collapsed[collapsed.length - 1])) {
    collapsed.pop();
  }

  // 3) Nothing but filler/noise left -> treat as silence
  if (!collapsed.some((t) => !isFillerToken(t))) return "";

  return collapsed
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
};

// Full pipeline for a mic transcript: Roman letters + no hallucination repeats.
export const toHinglish = (text) => cleanTranscript(toEnglishLetters(text));
