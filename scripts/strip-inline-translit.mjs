// One-off helper: drop the copy of the Devanagari->Roman transliteration that
// used to live inside Chat.jsx. It now lives in ./hinglishText and is imported.
import { readFileSync, writeFileSync } from "fs";

const FILE = "src/components/chat/Chat.jsx";
const src = readFileSync(FILE, "utf8");

const START = "// ---- Devanagari → English letters (Hinglish) transliteration ----";
const END = "// ---- End transliteration ----";

const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error("Markers not found — nothing changed.");
  process.exit(1);
}

const before = src.slice(0, startIdx);
const after = src.slice(endIdx + END.length);

const replacement =
  "// Devanagari -> Roman letter transliteration + hallucination clean-up now\n" +
  "// live in ./hinglishText (shared by Chat.jsx and groqStt.js).";

const out = before + replacement + after;
writeFileSync(FILE, out, "utf8");

const removedLines = src.slice(startIdx, endIdx + END.length).split("\n").length;
console.log(`Removed ${removedLines} lines from ${FILE}.`);
