// Verifies the FULL mic pipeline: Devanagari -> Roman Hinglish -> phonetic brand fix
import { toHinglish, toEnglishLetters, cleanTranscript, isFillerToken } from '../src/components/chat/hinglishText.js';
import { fixPhonetics } from '../src/components/chat/phoneticFixes.js';

const pipeline = (t) => fixPhonetics(toHinglish(t));

const cases = [
  'आच्छे आच्छे आच्छे इस्ट्रिम EduSkill का location कहां पर है।',
  'इस्ट्रिम EduSkill का location कहां पर है।',
  'एनविस्ट्रीम एडुस्किल का location कहां पर है',
  'इनविस्ट्रीम एडुस्किल का लोकेशन कहाँ है',
  'कोर्सेज क्या प्रोवाइड करते हो',
  'इंटर्नशिप के बारे में बताओ',
  'इंटर्नशिप क्या प्रोवाइड करते हो',
  'courses kya provide karte ho',
  // The exact bug report: filler + Devanagari brand + English mix
  'आच्छे आच्छे आच्छे इस्ट्रिम EduSkill का location कहां पर है।',
  'इस्ट्रिम एडुस्किल कहां पर है',
];

// Real English/Hinglish words that must NOT be mangled by the fuzzy brand regexes
const regressions = [
  'investment',
  'investigate',
  'instrument',
  'internal',
  'internet',
  'international',
  'training',
  'traning',
  'location',
  'courses',
];

let failures = 0;
console.log('--- full pipeline: raw Whisper output -> what Sayraa receives ---');
for (const input of cases) {
  const roman = toEnglishLetters(input);
  const final = pipeline(input);
  console.log('IN   :', JSON.stringify(input));
  console.log('ROMAN:', JSON.stringify(roman));
  console.log('FINAL:', JSON.stringify(final));
  if (/[\u0900-\u097F]/.test(final)) {
    console.log('  ✗ FAIL: Devanagari leaked through');
    failures++;
  } else {
    console.log('  ✓ no Devanagari');
  }
  console.log('');
}

console.log('--- filler detection (bug: Devanagari input) ---');
for (const w of ['आच्छे', 'aachchhe', 'achhe', 'achchhe', 'theek', 'courses', 'kahan']) {
  console.log(`${w.padEnd(12)} filler=${isFillerToken(w)}`);
}

console.log('\n--- cleanTranscript repeats ---');
console.log(JSON.stringify(cleanTranscript('achhe achhe achhe Envistream EduSkill ka location kahan hai')));
console.log(JSON.stringify(cleanTranscript('kya haal hai bhai')));

console.log('\n--- regression: real words must survive fixPhonetics untouched ---');
for (const w of regressions) {
  const out = pipeline(w);
  const ok = out === w;
  console.log(`${w.padEnd(16)} -> ${JSON.stringify(out)}${ok ? '' : '   ✗ CHANGED'}`);
  if (!ok) failures++;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

