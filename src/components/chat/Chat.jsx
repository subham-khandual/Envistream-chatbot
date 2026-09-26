import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import styles from "./chat.module.css";
import Picker from "emoji-picker-react";
import eduskillLogo from "../../assets/img/suulogo-round.png";
import chatBg from "../../assets/img/chat_bg.webp";
import { fixPhonetics } from "./phoneticFixes";
import { toEnglishLetters, toHinglish } from "./hinglishText";
import { isGroqSTTAvailable, cloudMediaSupported, startCloudRecording, stopCloudRecording, transcribeWithGroq } from "./groqStt";



const MALE_VOICE_NAMES = [
  // Hindi + Indian English
  "hemant", "madhur", "ravi", "prabhat", "kunal", "arjun",
  // en-US / en-GB / en-AU / en-CA
  "david", "mark", "guy", "eric", "steffan", "christopher", "jason", "tony",
  "andrew", "brian", "roger", "ryan", "thomas", "brandon", "jacob", "liam",
  "william", "daniel", "james", "george", "frank", "alex", "fred", "tom",
  "aaron", "arthur", "oliver", "richard", "matthew", "nathan", "adam", "bruce",
  "connor", "elliot", "ethan", "geraint", "gordon", "harry", "henry", "jack",
  "kyle", "lewis", "malcolm", "michael", "peter", "sean", "simon", "stefan",
  "stephen", "steve", "tim", "victor", "warren", "zach", "nicholas", "patrick",
  // Other locales that can show up in the list
  "diego", "jorge", "carlos", "pablo", "juan", "luca", "matteo", "henri", 
  "paul", "claude", "denis", "naayf", "asaf", "sharif", "hamed", "farid",
  "cosimo", "kangkang", "yunjian", "li-mu", "keita",
];

// Positive female markers (single words — whole-word matched).
const FEMALE_VOICE_NAMES = [
  // Hindi (Windows SAPI + Edge/Azure)
  "swara", "kalpana", "ananya", "aarohi", "dhwani",
  // Indian English (Edge/Azure + Windows SAPI)
  "neerja", "heera", "priya", "natasha", "aarushi",
  // English (Windows / Azure / Chrome / Google / Safari)
  "aria", "jenny", "michelle", "emma", "ava", "amber", "ashley", "cora",
  "elizabeth", "elena", "jane", "monica", "sara", "sonia", "libby", "clara",
  "claire", "emily", "olivia", "samantha", "victoria", "zira", "hazel",
  "helena", "katja", "laura", "linda", "maria", "martha", "sophie", "nora",
  "serena", "tessa", "yuna", "karen", "moira", "fiona", "allison",
  "joanna", "salli", "kimberly", "ivy", "ruth", "danielle", "kendra",
  // Nordic / other locales (these are female voices, not male ones)
  "suvi", "noora", "selma",
  "female", "woman", "girl",
];

// Multi-word / non-latin female markers (substring matched).
const FEMALE_VOICE_PHRASES = [
  "google हिन्दी",
  "google हिंदी",
  "google us english",
  "google uk english female",
  "google australian english",
  "google canadian english",
];

const MALE_VOICE_RE = new RegExp(
  `\\b(male|man|boy|${MALE_VOICE_NAMES.join("|")})\\b`,
  "i"
);
const FEMALE_VOICE_RE = new RegExp(
  `\\b(female|woman|girl|${FEMALE_VOICE_NAMES.join("|")})\\b`,
  "i"
);

const isMaleVoice = (voice) => {
  if (!voice) return false;
  if (voice.gender === "male") return true;
  if (voice.gender === "female") return false;
  return MALE_VOICE_RE.test((voice.name || "").toLowerCase());
};

const isFemaleVoice = (voice) => {
  if (!voice) return false;
  if (voice.gender === "female") return true;
  if (voice.gender === "male") return false;
  const n = (voice.name || "").toLowerCase();
  return FEMALE_VOICE_RE.test(n) || FEMALE_VOICE_PHRASES.some((p) => n.includes(p));
};

// Clarity / sweetness score for a voice.
// Azure "Online (Natural)" voices are noticeably clearer AND sweeter than the
// legacy Windows SAPI ones, so they get a nudge; the specific sweet voices
// Sayraa is tuned for (Swara, Neerja, Google's Hindi voice...) get a bigger one.
const rankVoice = (voice, exactLang = "") => {
  const n = (voice.name || "").toLowerCase();
  let s = 0;
  if (isFemaleVoice(voice)) s += 100;             // strongest signal
  if (exactLang && voice.lang.toLowerCase() === exactLang.toLowerCase()) s += 20;
  if (/natural|neural|online/.test(n)) s += 8;    // far clearer than legacy SAPI
  if (/google/.test(n)) s += 6;
  if (/microsoft/.test(n)) s += 2;
  if (/swara|kalpana|ananya|aarohi|dhwani|neerja|heera|priya/i.test(n)) s += 12;
  return s;
};

// ---- ONE single sweet voice for Hinglish AND English ----
// Sayraa must always sound like the SAME sweet, cute girl — whether she answers
// in Hinglish or in English. Picking a different woman per language (Hindi voice
// for Hinglish, Indian-English voice for English) made the English replies come
// out as a different, less sweet person. So the voice is chosen ONCE and reused.
//
// The ladder below prefers the sweet Hindi female voice Sayraa is known for
// (Microsoft Swara / Google हिन्दी), then an Indian-English woman, then any other
// non-male voice — and whatever wins is used for BOTH languages.
const SWEET_VOICE_LADDER = [
  // 1. Hindi female voice — Sayraa's own sweet voice
  (v) => /^hi/i.test(v.lang) && isFemaleVoice(v),
  (v) => /^hi/i.test(v.lang),
  // 2. Indian-English female (same Indian accent, still sweet)
  (v) => /^en[-_]in/i.test(v.lang) && isFemaleVoice(v),
  (v) => /^en[-_]in/i.test(v.lang),
  // 3. Any other female English voice
  (v) => /^en/i.test(v.lang) && isFemaleVoice(v),
  // 4. Anything left (male voices were already filtered out above)
  () => true,
];

let sweetVoiceCache = null;
let sweetVoiceCacheKey = "";

const getSweetVoice = (synth) => {
  const all = (synth.getVoices() || []).filter((v) => v && v.lang && v.name);
  if (!all.length) return null;

  // Reuse the exact same voice for English and Hinglish replies. The cache key
  // is the voice list itself, so it refreshes if the browser loads more voices.
  const key = all.map((v) => `${v.name}|${v.lang}`).join("~");
  if (sweetVoiceCache && sweetVoiceCacheKey === key) return sweetVoiceCache;

  // Prefer female voices first
  const nonMale = all.filter((v) => !isMaleVoice(v));
  const candidatePool = nonMale.length ? nonMale : all;

  for (const test of SWEET_VOICE_LADDER) {
    const pool = candidatePool.filter(test);
    if (pool.length) {
      const best = pool.slice().sort((a, b) => rankVoice(b) - rankVoice(a))[0];
      sweetVoiceCache = best;
      sweetVoiceCacheKey = key;
      return best;
    }
  }
  const fallback = candidatePool[0] || all[0];
  sweetVoiceCache = fallback;
  sweetVoiceCacheKey = key;
  return fallback;
};

// ---- (end of female voice selection) ----

// ---- Audio feedback tone when mic opens ----
// Plays a tiny subtle chime so the user knows the mic is listening,
// replacing the old spoken "Sun rahi hoon" which collided with the mic.
const playListenTone = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 250);
  } catch (_) {
    // AudioContext blocked or not supported — silent fail
  }
};

// Devanagari -> Roman letter transliteration + hallucination clean-up now
// live in ./hinglishText (shared by Chat.jsx and groqStt.js).

const HINGLISH_WORDS =
  "kya|kyaa|kyun|kyu|kyuu|kyoo|kyunki|kyuki|kaiko|" +
  "kaise|kese|kaisi|kaisa|kayse|" +
  "kaun|kaunsa|kaunsi|koun|kounsa|kounsi|kon|konsa|konsi|consa|konsae|kone|konse|" +
  "kiske|kiska|kiski|kisko|kisne|kisse|kisi|kisise|kinhe|kinho|" +
  "kab|kabse|kabtak|kahan|kahaan|kaha|kahape|kahanpe|kidhar|kidhr|" +
  "kitna|kitni|kitne|kitney|" +
  "koi|kuch|kuchh|kuchbhi|sab|sabhi|" +
  "batao|btao|bataiye|bataye|batayein|batayen|batana|bata|bta|btaye|bolo|boliye|bolna|bol|" +
  "chahiye|chahie|chaiye|chahta|chahti|chahte|chaho|chahoge|" +
  "hai|hain|hoge|hoga|hogi|honge|hona|hote|hota|hoti|ho|hoon|hun|tha|thi|the|" +
  "tum|tu|tumhara|tumhari|tumhare|tumhe|tujhe|aap|aapka|aapki|aapke|aapko|" +
  "hum|hume|humein|humko|hamara|hamari|hamare|mera|meri|mere|mujhe|mujhko|mjhe|tera|teri|tere|" +
  "apna|apni|apne|uska|uski|uske|usse|usko|unka|unki|unke|unhe|unko|iska|iski|iske|isse|isko|inka|inki|inke|inhe|inko|" +
  "ka|ki|ke|ko|kisko|kiske|kiska|kiski|kisne|kise|jise|jisne|" +
  "likho|likh|likhna|likhe|likhiye|likha|likhi|likhkar|" +
  "banao|banaye|banayein|banaoge|banaungi|" +
  "bhejo|bhejiye|bhej|bhejna|bataye|batayein|batao|bataiye|" +
  "nahi|nahin|nhi|nh|na|mat|haan|han|hanji|" +
  "karo|kro|karna|krna|karun|karu|karoon|kare|karein|karen|karega|karegi|karenge|karte|karta|karti|kar|karne|karni|karunga|karungi|kariye|" +
  "seekhna|sikhna|seekho|sikho|sikha|sikhao|sikhaye|sikhate|sikhati|sikhenge|" +
  "padhna|padhai|padhao|padhate|padhati|" +
  "dena|denge|dunga|dungi|dete|deta|deti|diya|diye|dijiye|" +
  "lena|lenge|lunga|lungi|lete|leta|leti|liya|liye|lijiye|" +
  "milti|milta|milte|milega|milegi|milenge|" +
  "sakta|sakti|sakte|sakenge|paunga|paungi|paenge|" +
  "lagta|lagti|lagte|lagega|lagegi|" +
  "jaana|jaunga|jaungi|jayenge|jate|jata|jati|gaya|gayi|gaye|" +
  "aana|aunga|aungi|aayenge|aate|aata|aati|aaya|aayi|aaye|" +
  "liye|mein|aur|ye|yeh|wo|woh|bhai|yaar|yar|dost|" +
  "accha|achha|acha|achhe|theek|thik|badiya|badhiya|mast|" +
  "matlab|mtlb|lekin|magar|abhi|phir|fir|bahut|bohot|thoda|thodi|zyada|jyada|sirf|khali|" +
  "pata|pta|malum|maalum|naam|nam|kaam|baare|bare|baat|bat|" +
  "poochh|puchh|puchho|puch|pucho|puchiye|puchna|" +
  "samajh|samjh|samjhao|samjha|samjhe|" +
  "chalo|sahi|galat|raha|rahi|rahe|" +
  "pasand|zabardast|behtar|bhi|bhee|toh|" +
  "waala|waali|waale|wala|wali|wale|banaya|banaye|banayi|yahan|wahan|vahan|idhar|udhar|paas|dur|pehle|baad";
const HINGLISH_WORD_RE = new RegExp(`\\b(${HINGLISH_WORDS})\\b`, "i");
const HINGLISH_WORD_RE_G = new RegExp(`\\b(${HINGLISH_WORDS})\\b`, "gi");

// End copula: "kon hey", "kya he", "fees kitni hey", "admission open hey"
const HINGLISH_COPULA_END_RE = /(?:\b\w+\s+)+(he|hey)[?!.]*$/i;

// Hinglish phrases with hey/he: "kya hey", "kon hey", "kaisa he", etc.
const HINGLISH_PHRASE_RE = /\b(kon|kaun|koun|kya|kaisa|kaisi|kaise|kitna|kitni|kitne|kahan|kaha|kab|kiske|kisko|kuch)\s+(he|hey)\b/i;

const isCodeWritingRequest = (text) => {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();

  // If asking about course details, admission, syllabus, fees, duration, don't block unless they explicitly ask to write/give code
  const isCourseInquiry = /(course|syllabus|fees|duration|admission|timing|offer|provide|sikhate|padhate|seekhna)/i.test(t);
  const hasCodeAction = /(write|likho|likh|banao|bana\s*do|bana\s*de|generate|dijiye|do|chahiye|solve)/i.test(t);
  if (isCourseInquiry && !hasCodeAction) {
    return false;
  }

  // Common phrases:
  // "write a code", "write code in python", "write python code", "write a program", "write script"
  if (/(write|generate|create|provide|give)\s+(me\s+)?(a\s+|an\s+|the\s+)?([a-z0-9#+]+\s+)?(code|program|script)/i.test(t)) return true;
  // "code likho", "program likho", "script likho", "code banao", "code do", "code chahiye"
  if (/(code|program|script)\s+(likho|likh|likh\s*do|likh\s*de|banao|bana\s*do|bana\s*de|dijiye|do|chahiye|de\s*do)/i.test(t)) return true;
  // "python me code", "python me program"
  if (/(me|mein)\s+(code|program|script)/i.test(t)) return true;
  // "code for ...", "program for ...", "script for ..."
  if (/(code|program|script)\s+(for|to)\s+/i.test(t)) return true;
  // "write a python script", "write a python function"
  if (/write\s+(a\s+|an\s+)?([a-z0-9#+]+\s+)?(script|function|algorithm)/i.test(t)) return true;
  // "python code do", "java code do"
  if (/([a-z0-9#+]+\s+)?(code|program)\s*(do|dijiye|bhejo)/i.test(t)) return true;
  // "can you write code", "code write karo"
  if (/write\s+code/i.test(t)) return true;
  // "even odd ka code", "fibonacci ka code", "calculator ka code"
  if (/(ka|ki|ke)\s+(code|program)/i.test(t)) return true;

  return false;
};

const isIdentityRequest = (text) => {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim().replace(/[?!.,]/g, "");
  if (/^(who is sayraa|who are you|what is sayraa|what are you)$/i.test(t)) return true;
  if (/^(sayraa|sayra|sairaa|saira)\s+(kon|kaun|koun)\s+(hai|hey|he)$/i.test(t)) return true;
  if (/^(tum|aap)\s+(kon|kaun|koun)\s+(ho|hai|hain|hey|he)$/i.test(t)) return true;
  if (/^(apne\s+baare\s+mein\s+batao|apne\s+bare\s+me\s+batao|tell\s+me\s+about\s+yourself|introduce\s+yourself)$/i.test(t)) return true;
  return false;
};

const detectUserLanguage = (text) => {
  if (!text) return "ENGLISH";
  if (/[ऀ-ॿ]/.test(text)) return "HINGLISH";
  const trimmed = text.trim();
  if (HINGLISH_WORD_RE.test(trimmed) || HINGLISH_COPULA_END_RE.test(trimmed) || HINGLISH_PHRASE_RE.test(trimmed)) {
    return "HINGLISH";
  }
  return "ENGLISH";
};

const replyIsWrongLanguage = (text, expectedLang) => {
  if (!text) return false;
  const hasDevanagari = /[ऀ-ॿ]/.test(text);
  const markerHits = (text.match(HINGLISH_WORD_RE_G) || []).length;
  const looksHinglish = hasDevanagari || markerHits > 0;
  return expectedLang === "ENGLISH" ? looksHinglish : !looksHinglish;
};

// Clean text for display in chat bubble: removes asterisks/hashes but KEEPS code snippets intact
const formatDisplayText = (s) =>
  String(s || "")
    .replace(/```(?:python|javascript|js|java|html|css|cpp|c|sql)?\s*([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();

// Strip raw code blocks and markdown so TTS speaks naturally without reading code symbols
const stripForSpeech = (s) =>
  String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Split a reply into ~200-char pieces on sentence boundaries. Browsers
// (especially Chrome) CUT OFF a single long utterance after ~15 s — i.e. after
// the first couple of lines — which is exactly the "she speaks only 2 lines"
// bug. Queueing short chunks end-to-end plays the WHOLE reply.
const splitForSpeech = (s) => {
  const MAX = 200;
  const pieces = String(s).match(/[^.!?।]+[.!?।]*/g) || [String(s)];
  const chunks = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  const addWords = (sentence) => {
    let line = "";
    for (const w of sentence.split(/\s+/)) {
      if ((line + " " + w).trim().length > MAX) {
        if (line) chunks.push(line.trim());
        line = w;
      } else {
        line = (line + " " + w).trim();
      }
    }
    if (line) chunks.push(line);
  };
  for (const raw of pieces) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > MAX) {
      push();
      addWords(sentence);
      continue;
    }
    if ((cur + " " + sentence).trim().length > MAX) {
      push();
      cur = sentence;
    } else {
      cur = (cur + " " + sentence).trim();
    }
  }
  push();
  return chunks.length ? chunks : [String(s)];
};

const buildLanguageInstruction = (lang) =>
  `CRITICAL LANGUAGE RULE — reply ENTIRELY in ${lang}.
- The user's latest message has been DETECTED AS ${lang}. Use exactly that language for your WHOLE reply — first word to last sentence, including follow-up questions, closing lines, off-topic acknowledgements, scope boundaries, and redirects.
- ENGLISH means pure English only — zero Hindi/Hinglish words anywhere (never "Hamare yahan...", "aapko", "kya", "hai", "Iske baare mein aur jaanna hai?").
- HINGLISH means Hindi written in Roman letters only, never Devanagari (e.g. "kya haal hai", "courses kya provide karte ho").
- NEVER MIX LANGUAGES WITHIN A SINGLE REPLY.
- Match ONLY the latest user message's language — even if earlier replies in the conversation used the other language.`;

// Chat/STT error bubble, written in the SAME language the user wrote in.
const buildChatErrorMessage = (lang, details = "") => {
  const keyProblem = /401|403|invalid[_ -]?api[_ -]?key|no api key/i.test(details);
  const rateLimited = /429|rate limit|too many/i.test(details);
  if (lang === "ENGLISH") {
    if (keyProblem) return "The AI service key has a problem. Please check the GROQ_API_KEY setting. 🔑";
    if (rateLimited) return "Please wait a moment — the free AI limit is temporarily full. Please try again in a minute. ⏳";
    return "Oops! I couldn't reach the AI service just now. Please try again in a moment. 😅";
  }
  if (keyProblem) return "Groq API key problem hai! .env mein GROQ_API_KEY check karo. 🔑";
  if (rateLimited) return "Thodi der ruko! Groq free limit full ho gayi, 1 min baad try karo. ⏳";
  return "Oops! Main samajh nahi payi, ek baar fir se bolo na... 😅";
};

const buildNoSpeechMessage = (lang) =>
  lang === "ENGLISH"
    ? "I couldn't hear anything... come a bit closer to the mic and speak clearly! 🎙️"
    : "Kuch sunai nahi diya... mic ke paas aake thoda aur clearly bolo na! 🎙️";

// ---- Conversation memory budget ----
// Groq's free tier allows 8000 tokens per minute per model and the system
// prompt alone is already ~1500 tokens, so an unbounded history would blow the
// limit (429) after a few turns. Keep only the most recent exchanges and cap
// the total text size — the model still has full context of the live topic.
const MAX_HISTORY_TURNS = 6;      // 6 exchanges = 12 messages
const MAX_HISTORY_CHARS = 6000;   // ~1500 tokens of history at most

const trimHistory = (history) => {
  if (!Array.isArray(history) || !history.length) return [];
  const recent = history.slice(-MAX_HISTORY_TURNS * 2);
  // Walk backwards, keeping whole messages until the char budget is spent,
  // so the transcript always starts on a "user" turn.
  const kept = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const text = (recent[i].parts || []).map((p) => p.text || "").join(" ");
    if (used + text.length > MAX_HISTORY_CHARS && kept.length) break;
    used += text.length;
    kept.unshift(recent[i]);
  }
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
};

const Chat = () => {
  const [userInput, setUserInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [interimText, setInterimText] = useState("");

  const chatEndRef = useRef(null);
  const navigate = useNavigate();
  const isListeningRef = useRef(false);

  const stopEarlyRef = useRef(null);
  // Ensures the welcome message is spoken only once even in StrictMode dev
  const welcomeSpokenRef = useRef(false);
  // Incremented on every speakText() call so a slow voice lookup from an older
  // message can never speak over a newer one.
  const speakSeqRef = useRef(0);
  // Cloud (Groq Whisper) mic session + silence-watch interval
  const cloudRecRef = useRef(null);
  const sensingTimerRef = useRef(null);
  // Keep live references to utterances so Chrome V8 Garbage Collector cannot prematurely destroy them
  const activeUtterancesRef = useRef([]);

  // Speak a reply with Sayraa's ONE sweet female voice — the SAME voice for
  // BOTH languages. She must never switch to a different woman (or a man) just
  // because an English answer came back.
  const speakText = useCallback((text, lang = "HINGLISH") => {
    if (typeof window === 'undefined') return;

    const synth = window.speechSynthesis;
    if (!synth) {
      console.warn("Speech synthesis not available.");
      return;
    }

    // Keep emojis on screen, but NEVER read them aloud ("smiling face" etc.).
    // Code blocks and raw markdown are stripped for natural voice speech.
    const spokenText = stripForSpeech(text)
      .replace(/Sayraa/gi, "Sigh-raa")
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu,
        ""
      )
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!spokenText) return;

    const isEnglish = String(lang).toUpperCase().startsWith("EN");
    const seq = ++speakSeqRef.current;
    // Split into short sentence-chunks. A single long utterance gets cut off by
    // Chrome after ~15 s (about 2 lines) — queueing chunks plays the WHOLE reply.
    const chunks = splitForSpeech(spokenText);

    // Cancel any previous speech and unpause engine if needed
    try {
      synth.cancel();
      if (synth.paused) {
        synth.resume();
      }
    } catch (_) {}

    const speakNow = () => {
      // A newer message took over while we were waiting for the voice list.
      if (seq !== speakSeqRef.current) return;

      const voice = getSweetVoice(synth);
      if (voice) {
        console.log(`Sayraa voice: ${voice.name} (${voice.lang})`);
      } else {
        console.warn("No specific female voice found; using browser default.");
      }

      // Small delay (60ms) after synth.cancel() allows the browser audio renderer
      // to cleanly flush cancellation IPC before accepting new speak() calls in Chrome.
      setTimeout(() => {
        if (seq !== speakSeqRef.current) return;
        try {
          if (synth.paused) synth.resume();
        } catch (_) {}

        const speakChunk = (i) => {
          // Stop the chain if a newer message starts speaking.
          if (seq !== speakSeqRef.current) return;
          if (i >= chunks.length) {
            activeUtterancesRef.current = [];
            return;
          }

          const utterance = new SpeechSynthesisUtterance(chunks[i]);
          utterance.rate = 1.0;

          if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang || (isEnglish ? "en-US" : "hi-IN");
            // Windows SAPI Desktop voices (e.g. Microsoft Zira Desktop) fail on pitch changes != 1.0
            const isDesktopSapi = /desktop/i.test(voice.name || "");
            utterance.pitch = isDesktopSapi ? 1.0 : (isFemaleVoice(voice) ? 1.15 : 1.0);
          } else {
            // Default to en-US or en-IN so systems without Hindi language packs can speak Roman Hinglish
            utterance.lang = isEnglish ? "en-IN" : "en-US";
            utterance.pitch = 1.0;
          }

          utterance.onend = () => {
            activeUtterancesRef.current = activeUtterancesRef.current.filter((u) => u !== utterance);
            speakChunk(i + 1);
          };

          utterance.onerror = (e) => {
            console.warn("Speech synthesis error on chunk", i, e?.error || e);
            activeUtterancesRef.current = activeUtterancesRef.current.filter((u) => u !== utterance);
            speakChunk(i + 1);
          };

          // Protect from V8 garbage collection
          activeUtterancesRef.current.push(utterance);
          window._sayraaActiveUtterance = utterance;

          try {
            if (synth.paused) synth.resume();
          } catch (_) {}
          synth.speak(utterance);
        };

        speakChunk(0);
      }, 60);
    };

    // Voices already cached -> speak straight away.
    if ((synth.getVoices() || []).length) {
      speakNow();
      return;
    }

    // Otherwise wait for the browser to populate them (with a safety timeout so
    // a reply is never swallowed if "voiceschanged" never fires).
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      speakNow();
    };
    const timer = setTimeout(onReady, 800);
    try {
      synth.addEventListener("voiceschanged", onReady, { once: true });
    } catch (_) {
      synth.onvoiceschanged = onReady;
    }
  }, []);

  // Load messages from localStorage on mount
  useEffect(() => {
    const savedMessages = localStorage.getItem("sayraaMessages");
    if (savedMessages) {
      setMessages(JSON.parse(savedMessages));
    }

    const synth = window.speechSynthesis;
    if (synth) {
     
      const logVoices = () => {
        const voices = synth.getVoices() || [];
        if (voices.length) console.log(`Voices loaded (${voices.length}):`, voices);
      };
      synth.getVoices();
      try {
        synth.addEventListener("voiceschanged", logVoices);
      } catch (_) {
        // Very old engines only expose the property form.
        synth.onvoiceschanged = logVoices;
      }
      try {
        const warmup = new SpeechSynthesisUtterance("");
        warmup.volume = 0; // silent — only here to trigger the voice load
        synth.speak(warmup);
      } catch (_) {
        // Speech synthesis unavailable — the reply still shows as text.
      }
    }

  }, []);

  const medConfig = {
    identity: {
      name: "Sayraa",
      creator: "Envistream EduSkill",
      gender: "female",
      language: "Hinglish",
      age: 20,
      location: "Bhubaneswar, India",
      traits: ["knowledgeable", "friendly", "professional", "helpful", "playful"],
      capabilities: [
        "Course & training information 📚",
        "Internship program guidance 💼",
        "Enrollment help ✍️",
        "Placement & career support 🎯",
        "Project guidance 🛠️",
        "Contact & location info 📍",
      ],
    },
    systemMessage: `Act as Sayraa, a smart and friendly AI learning guide at Envistream EduSkill (an IT training and internship institute in Bhubaneswar, Odisha).

      CORE BEHAVIOR RULES:
      1. LANGUAGE (MIRROR THE USER — HIGHEST PRIORITY):
         - Detect the language of the user's LATEST message and reply in EXACTLY that language.
         - If the user writes/speaks in ENGLISH -> reply in PURE ENGLISH only (no Hindi words at all).
         - If the user writes/speaks in HINDI or HINGLISH -> reply in natural HINGLISH (Hindi written in Roman/English alphabet). Never use Devanagari script.
         - Never mix the two languages inside one reply, and never switch language on your own.
      2. BRANDING & NO SALES CTAs (CRITICAL):
         - In the FIRST reply/interaction of the chat, mention "Envistream EduSkill" naturally (e.g., "Envistream EduSkill mein...").
         - In SUBSEQUENT chat messages, it is NOT necessary to repeat "Envistream EduSkill" in every chat! Speak naturally using "hum", "hamare yahan", or answer directly without repeating the brand name every time.
         - NEVER add call-to-action (CTA) slogans like "detail ke liye Enquire Now dabayein! 🚀", "Enroll Now pe click karein", "Apply Now dabayein", etc. Do NOT tell the user to click buttons or enquire.
         - DO NOT append phone numbers (+91 7873489364), website links (www.envistream.org), or sales pitches ("call karein...", "visit karein...") to everyday answers. Mention phone numbers or website ONLY when the user explicitly asks for contact info, calling, registration, or admission.
      3. EXPLAINING TECH CONCEPTS ("X kya hai", "What is X", "Do you offer X"):
         - When the user asks what a technology is (e.g. PHP, Python, Software Testing, React, DevOps, AWS, Docker):
           * IF OFFERED by Envistream EduSkill (Web Dev, Full-Stack Node & React, Software Testing, Cypress Automation, SAP/ERP, Python, Java, AI / Generative AI, Digital Marketing): Explain simply in 1-2 lines and mention that practical training and live project internship is available.
           * IF NOT OFFERED by Envistream EduSkill (e.g. DevOps, CI/CD, AWS, Cloud computing, Docker, Kubernetes, Cyber Security, Blockchain): STRICTLY ANSWER IN ONLY 2 LINES:
             - Line 1: Explain simply in 1 sentence what the technology is.
             - Line 2: Explicitly state that Envistream EduSkill does not offer this course:
               * In English: "However, Envistream EduSkill does not offer this course — we offer training in Web Development, Full-Stack, Software Testing, SAP/ERP, and AI/Python! 😊"
               * In Hinglish: "Lekin Envistream EduSkill ye course offer nahi karta — hamare yahan Web Development, Full-Stack, Software Testing, SAP/ERP aur AI/Python jaise courses available hain! 😊"
      4. KEEP ANSWERS SHORT (for normal conversation): 2-3 short lines maximum (~40-60 words).
      5. DO NOT WRITE CODE (STRICT RULE — NEVER WRITE OR GENERATE ANY CODE):
         - NEVER write, generate, or provide code scripts, programs, or functions in any language (Python, Java, JavaScript, C, HTML/CSS, etc.).
         - When the user asks to write code, provide a script, or write a program (e.g. "write a code in python", "python me code likho", "write program for even odd", "code likh do", "code bana do"):
           * EXPLICITLY REFUSE TO WRITE CODE:
             - In ENGLISH: "I cannot help you with writing code because I am Sayraa, the Envistream EduSkill AI assistant, and I guide about courses, training, and internships! If you want to learn programming, we offer courses in Python, Web Development, Full-Stack, and Java! 😊"
             - In HINGLISH: "Main code likhne mein help nahi kar sakti kyunki main Sayraa hoon, Envistream EduSkill ki AI assistant — main courses, training aur internships ke baare mein guide karti hoon! Agar aap coding seekhna chahte hain, toh hamare yahan Python, Web Development aur Java ke courses available hain! 😊"
         - FOR GENERAL CHAT (non-code answers): keep plain flowing sentences without raw markdown asterisks or line-by-line lists.
      6. COMPARISON QUESTIONS ("X vs Y", "which is better", "Gen AI vs AWS", "DevOps vs AI", "konsa achha hai"):
         - Step 1 (Clear direct comparison in 1-2 lines): Explain simply what each technology does and how they relate. E.g. for "Gen AI vs AWS": Generative AI focuses on creating new content like text, images, or code using models like GPT; AWS provides the cloud infrastructure, storage, and compute to host and scale those models. So Generative AI is the technology; AWS is the platform that runs it.
         - Step 2 (EXPLICITLY STATE WHICH COURSE IS PROVIDED BY EDUSKILL OR NOT): Clearly tell the user which of the compared technologies is offered by Envistream EduSkill and which is not.
           * Provided by Envistream EduSkill: Artificial Intelligence / Generative AI (Python), Web Development, Full-Stack (Node & React), Software Testing, Cypress Automation, SAP/ERP, Python, Java, Digital Marketing.
           * NOT provided as standalone courses: AWS / Cloud infrastructure (AWS/Azure/GCP), DevOps, Docker, Kubernetes, etc.
           * Example (English): "Generative AI focuses on creating new content—text, images, code—using models like GPT or Stable Diffusion, while AWS provides cloud infrastructure, storage, and compute to host and scale those models. Envistream EduSkill provides practical training and live project internships in Artificial Intelligence and Generative AI, but does not currently offer a standalone AWS cloud course. 😊"
           * Example (Hinglish): "Gen AI naya content create karta hai jaise text, image ya code, jabki AWS cloud infrastructure provide karta jo in models ko host aur run karta hai. Envistream EduSkill mein Artificial Intelligence aur GenAI ka practical training live project internship ke sath available hai, lekin abhi AWS ka standalone course available nahi hai. 😊"
           * Gen AI vs LLM vs RAG (CRITICAL DISTINCTION & COURSE MAPPING):
             - Generative AI (Gen AI) is a broad field that creates new content—text, images, code—using advanced models.
             - A Large Language Model (LLM) is a specific type of Gen AI that processes and generates natural-language text based on patterns learned from massive datasets.
             - Retrieval-Augmented Generation (RAG) is a technique that combines an LLM with an external knowledge base; it retrieves relevant documents and then generates responses that incorporate that retrieved information.
             - COURSE SCOPE: Envistream EduSkill offers training in Artificial Intelligence / Generative AI (AI / ML / Gen AI), and both LLM and RAG are covered under this AI/ML & Gen AI course with practical training and live project internship! We do not provide courses focused solely on LLM development or RAG techniques, but they are fully included under our AI/ML and Generative AI course.
             - Example (English): "Generative AI is a broad field that creates new content using advanced models, LLMs process and generate natural-language text, and RAG combines LLMs with external knowledge bases to incorporate retrieved information. Envistream EduSkill offers training in Artificial Intelligence / Generative AI where LLM and RAG are covered under the course, though we do not provide standalone courses focused solely on LLM or RAG. 😊"
             - Example (Hinglish): "Gen AI ek broad field hai jo naya content create karta hai, LLM natural-language text generate karta hai, aur RAG external knowledge base ko LLM ke sath combine karta hai. Envistream EduSkill mein Artificial Intelligence aur Generative AI (AI/ML) course ke under LLM aur RAG dono sikhaye jaate hain, lekin inka koi alag standalone course nahi hai. 😊"
      7. For "courses kya hai" type questions, reply with just the course names in 1-2 lines (comma separated). Give full details ONLY when the user asks about ONE specific course.
      8. For location questions, reply ONLY with the address in 1-2 lines. Do NOT include phone number or call instructions unless specifically asked for contact/calling details.
      9. VOICE INPUT: user messages often come from a speech recognizer and contain PHONETIC spelling mistakes (e.g. 'korsej kya provaaid karte ho' = 'Courses kya provide karte ho'; 'lokeshan kahan hai' = 'Location kahan hai'). Silently understand the intended meaning and answer normally.
      10. OFF-TOPIC HANDLING (ANALYZE AND STATE SPECIFIC CATEGORY):
          - When the user asks any off-topic question, ANALYZE the query and identify the specific topic category. NEVER write a combined list like 'political/sports/general knowledge'. Use ONLY the single specific identified category name:
            * Sports/Cricket/Players (e.g. Rohit Sharma, match, football) -> category is 'sports'
            * Politics/Leaders/Government (e.g. Modi, election, PM) -> category is 'political'
            * General Knowledge/World facts/Space (e.g. capital of France, ocean, space) -> category is 'general knowledge'
            * Entertainment/Movies/Actors/Jokes (e.g. movie story, actor, jokes) -> category is 'entertainment'
            * Food/Cooking/Recipes (e.g. pizza recipe, dinner) -> category is 'food/cooking'
            * Weather/News (e.g. weather, rain, news) -> category is 'weather/news'
            * Personal questions (e.g. shaadi, feelings, real person) -> category is 'personal'
          - EXACT RESPONSE FORMAT:
            * In HINGLISH: "Ye [specific category: sports / political / general knowledge / entertainment / food/cooking / weather/news / personal] related question hai jo mere topic aur courses se bahar hai. Main Sayraa hoon, Envistream EduSkill ki AI assistant — main IT software courses aur internships guide karti hoon! 😊"
            * In ENGLISH: "This is a [specific category: sports / political / general knowledge / entertainment / food/cooking / weather/news / personal] related question which is outside my topic and courses. I'm Sayraa, the AI assistant of Envistream EduSkill — I guide on IT software courses and internships! 😊"
       11. IDENTITY & CREATOR QUESTIONS:
           - When asked "sayraa kon hey", "sayraa kon hai", "who is sayraa", "tum kon ho", "who are you", "aap kaun ho":
             * Explicitly state that you are an AI assistant!
             * In HINGLISH: "Main Sayraa hoon, Envistream EduSkill ki AI assistant! Main students ko IT courses, training aur internships ke baare mein guide karti hoon. Main aapki kya help kar sakti hoon? 😊"
             * In ENGLISH: "I am Sayraa, the AI assistant of Envistream EduSkill! I guide students about IT courses, training, and internships. How can I help you today? 😊"
           - When asked "tumhe kon banaya hai", "tumhe kisne banaya", "who made you": respond in Hinglish ("Mujhe Envistream EduSkill ki team ne banaya hai 🧑‍💻") or English ("I was created by the Envistream EduSkill team 🧑‍💻") matching user language.

      KNOWLEDGE BASE:
      - IT Training / CSE Programs OFFERED: Software Testing (manual + automation testing for QA), Cypress Automation (web automation with Cypress and JavaScript), ERP/SAP Training, SAP Testing, Web Development (HTML, CSS, JavaScript, jQuery, Bootstrap), Node.js & React.js (full-stack web apps), Digital Marketing (AI SEO, SEM, social media), Artificial Intelligence / Generative AI (covers Python for AI, Machine Learning, Prompt Engineering, LLM and RAG techniques; LLM and RAG are covered under this course, not as standalone courses), PHP (with Laravel), Python, Java.
      - BBA/MBA Programs OFFERED: Digital Marketing, SEO Training, Social Media Marketing, Market Research, Business Development, Lead Generation.
      - COURSES NOT OFFERED (STRICT): DevOps (CI/CD, Docker, Kubernetes, Jenkins), AWS / Cloud Infrastructure (Azure, GCP), Cyber Security, Ethical Hacking, Blockchain. Always explicitly state we do not offer these courses if asked.
      - Projects offered: PHP projects (e.g., Chatbot for Students, College Admission Prediction System), Web Development projects (e.g., One-Page Layout, Product Landing Page), Python projects (e.g., Games, Automation apps), Java projects (e.g., Airline Reservation System, Course Management System).
      - Benefits: Technical workshops, 24x7 lab facility, experienced trainers from top MNCs, live project experience, placement assistance, mock interviews.
      - Location: Plot-N6/454, 2nd floor, Saffire Building, Opposite- Crown Hotel, IRC Village, Nayapalli, Bhubaneswar, Odisha.
      - Contact (give ONLY when asked): Phone: +91 7873489364 / +91 9078419012. Email: training@envistream.org. Website: www.envistream.org

      Examples:
       User: "sayraa kon hey"
       Response: "Main Sayraa hoon, Envistream EduSkill ki AI assistant! Main students ko IT courses, training aur internships ke baare mein guide karti hoon. Main aapki kya help kar sakti hoon? 😊"

       User: "who is sayraa"
       Response: "I am Sayraa, the AI assistant of Envistream EduSkill! I guide students about IT courses, training, and internships. How can I help you today? 😊"

      User: "write a code in python"
      Response: "I cannot help you with writing code because I am Sayraa, the Envistream EduSkill AI assistant, and I guide about courses, training, and internships! If you want to learn programming, we offer courses in Python, Web Development, Full-Stack, and Java! 😊"

      User: "python me code likho"
      Response: "Main code likhne mein help nahi kar sakti kyunki main Sayraa hoon, Envistream EduSkill ki AI assistant — main courses, training aur internships ke baare mein guide karti hoon! Agar aap coding seekhna chahte hain, toh hamare yahan Python, Web Development aur Java ke courses available hain! 😊"

      User: "rohit sharma kon hey"
      Response: "Ye sports related question hai jo mere topic aur courses se bahar hai. Main Sayraa hoon, Envistream EduSkill ki AI assistant — main IT software courses aur internships guide karti hoon! 😊"

      User: "narendra modi kon hai"
      Response: "Ye political related question hai jo mere topic aur courses se bahar hai. Main Sayraa hoon, Envistream EduSkill ki AI assistant — main IT software courses aur internships guide karti hoon! 😊"

      User: "Gen AI vs LLM vs RAG"
      Response: "Generative AI is a broad field that creates new content using advanced models, LLMs generate natural-language text from massive datasets, and RAG combines LLMs with external knowledge bases. Envistream EduSkill offers training in Artificial Intelligence / Generative AI where LLM and RAG are covered under the course, though we do not provide courses focused solely on LLM development or RAG techniques. 😊"

      User: "LLM aur RAG sikhate ho kya?"
      Response: "Haan! LLM aur RAG hamare Artificial Intelligence aur Generative AI (AI/ML) training program ke under cover hote hain. Inka koi alag standalone course nahi hai, balki ye complete AI & Gen AI course ka part hain! 😊"

      User: "DevOps kya hai?"
      Response: "DevOps software development aur IT operations ko combine karta hai taaki software fast aur reliably deliver ho sake. Lekin Envistream EduSkill ye course offer nahi karta — hamare yahan Web Development, Full-Stack, Software Testing, SAP/ERP aur AI/Python jaise courses available hain! 😊"

      User: "Do you offer DevOps training?"
      Response: "DevOps is a set of practices that combines software development and IT operations to deliver applications faster and more reliably. However, Envistream EduSkill does not offer this course — we offer training in Web Development, Full-Stack, Software Testing, SAP/ERP, and AI/Python! 😊"

      User (First chat): "PHP kya hai?"
      Response: "PHP ek popular server-side scripting language hai jo dynamic websites aur web applications banane ke liye use hoti hai. Envistream EduSkill mein iska Laravel ke sath live project training aur internship available hai. Iske baare mein aur jaanna hai? 😊"

      User: "Courses kya hai?"
      Response: "Software Testing, Cypress Automation, Web Development, PHP (Laravel), Python, Java, Node.js & React.js, Digital Marketing & AI, aur ERP/SAP. Kisi ek course ki detail chahiye? 😊"

      User: "Location kya hai?"
      Response: "Plot-N6/454, 2nd floor, Saffire Building, Opposite- Crown Hotel, IRC Village, Nayapalli, Bhubaneswar, Odisha. 😊"

      User: "Internship kaise paun?"
      Response: "Aap humari website www.envistream.org par enroll kar sakte hain ya call karein +91 7873489364 pe! 😊"`,
  };

  useEffect(() => {
    const welcomeText = "Hello! I'm Sayraa, the chatbot of Envistream EduSkill. Ask me about courses, training and internships! 😊";
    const initialMessages = [{
      text: welcomeText,
      sender: "ai",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }];
    setMessages(initialMessages);

    const initialHistory = [
      {
        role: "model",
        parts: [{ text: welcomeText }],
      },
    ];
    setConversationHistory(initialHistory);

    const englishWelcome = "Hello! I'm Sigh-raa, the chatbot of Envistream EduSkill. Ask me about courses, training and internships!";
    // Speak the welcome only ONCE — React.StrictMode runs effects twice in
    // dev, which would otherwise speak it twice
    if (!welcomeSpokenRef.current) {
      welcomeSpokenRef.current = true;
      speakText(englishWelcome, "ENGLISH");
    }
  }, [speakText]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem("sayraaMessages", JSON.stringify(messages));
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);


  const releaseCloudListen = () => {
    isListeningRef.current = false;
    setIsListening(false);
    setInterimText("");
  };

  const finalizeCloud = async () => {
    const session = cloudRecRef.current;
    if (!session) return;
    cloudRecRef.current = null;

    if (sensingTimerRef.current) {
      clearInterval(sensingTimerRef.current);
      sensingTimerRef.current = null;
    }
    stopEarlyRef.current = null;

    // Keep the listening state ON so the "mein samajh rahi hoon..." bubble shows
    setInterimText(" mein samajh rahi hoon... 🤖");

    let blob;
    try {
      blob = await stopCloudRecording(session);
    } catch (_) {
      releaseCloudListen();
      return;
    }

    if (!blob || blob.size < 1000) {
      releaseCloudListen();
      setMessages((prev) => [
        ...prev,
        { text: "Kuch sunai nahi diya... mic ke paas aake thoda aur clearly bolo na! 🎙️", sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);
      return;
    }

    let transcript = "";
    try {
      transcript = await transcribeWithGroq(blob);
    } catch (err) {
      console.error("Groq STT error:", err);
      releaseCloudListen();
      let errorText = "AI mic me problem aayi! Dobara try karo ya message likh do. ⌨️😊";
      const details = String(err?.message || "");
      if (/401|403|400/.test(details)) {
        errorText = "Groq API key problem hai! .env mein GROQ_API_KEY check karo. 🔑";
      } else if (/429/.test(details)) {
        errorText = "Thodi der ruko! Groq free limit full ho gayi, 1 min baad try karo. ⏳";
      }
      setMessages((prev) => [
        ...prev,
        { text: errorText, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);
      return;
    }

    releaseCloudListen();

    // Same phonetic safety net as the browser mic, in case Whisper slips
    const text = fixPhonetics(transcript);
    if (text && text.trim()) sendMessage(text.trim());
  };

  const beginCloudRecognition = async () => {
    isListeningRef.current = true;
    setIsListening(true);
    setInterimText("");

    let session;
    try {
      session = await startCloudRecording();
    } catch (err) {
      console.error("Cloud mic error:", err);
      isListeningRef.current = false;
      setIsListening(false);
      setInterimText("");
      setMessages((prev) => [
        ...prev,
        { text: "Mic start nahi ho paya! Browser mic permission do aur fir se try karo. 🎙️", sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);
      return;
    }

    cloudRecRef.current = session;
    playListenTone();
    stopEarlyRef.current = finalizeCloud;

    // Fast Voice Activity Detection (VAD) with standard Web Audio API
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("AudioContext not supported");

      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(session.stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let lastSound = Date.now();
      let hasSpoken = false;

      sensingTimerRef.current = setInterval(() => {
        if (!cloudRecRef.current) {
          if (sensingTimerRef.current) clearInterval(sensingTimerRef.current);
          try { audioCtx.close(); } catch (_) {}
          return;
        }

        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;

        // Human voice detection threshold (sensitive to soft speech and end of words)
        if (avg > 10) {
          hasSpoken = true;
          lastSound = Date.now();
        }

        // Full sentence pause threshold: 2.0s silence after speaking, or 6s before first word
        const silenceThreshold = hasSpoken ? 2000 : 6000;
        if (Date.now() - lastSound > silenceThreshold) {
          if (sensingTimerRef.current) clearInterval(sensingTimerRef.current);
          try { audioCtx.close(); } catch (_) {}
          finalizeCloud();
        }
      }, 100);

      // Max recording cap for long queries: 25 seconds
      setTimeout(() => {
        if (cloudRecRef.current) finalizeCloud();
      }, 25000);
    } catch (_) {
      // Fallback timer if AudioContext blocked: 8 seconds
      setTimeout(() => {
        if (cloudRecRef.current) finalizeCloud();
      }, 8000);
    }
  };

  const startListening = () => {
    // Pressing the mic AGAIN while listening stops early & sends what was heard
    if (isListeningRef.current) {
      if (stopEarlyRef.current) stopEarlyRef.current();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    // IMPORTANT: Stop any ongoing speech BEFORE opening the mic,
    // otherwise the bot's own voice gets picked up by recognition
    // and it fails to understand the user.
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // ---- AI (Groq Whisper) batch transcription — the accurate path ----
    // When an API key is configured and the modern mic APIs exist, we record
    // the audio and let Groq Whisper transcribe it. This keeps the "Envistream
    // EduSkill" brand name and other English words correct no matter how fast
    // or slow the user speaks.
    if (isGroqSTTAvailable() && cloudMediaSupported()) {
      beginCloudRecognition();
      return;
    }

    if (!SpeechRecognition) {
      setMessages((prev) => [
        ...prev,
        { text: "Is browser me speech recognition supported nahi hai! Chrome ya Edge browser use karo. 🎙️", sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);
      return;
    }

    isListeningRef.current = true;
    setIsListening(true);
    setInterimText("");

    // Single-pass Hinglish recognition with the Hindi (hi-IN) engine.
    const beginRecognition = (isRetry = false) => {
      // Create a FRESH instance every time — reusing an old instance after
      // it has ended is unreliable in Chrome (mic stops recognizing words).
      const recognition = new SpeechRecognition();
      // continuous = true keeps the mic open for the WHOLE sentence.
      // With continuous = false Chrome finalised the FIRST word at the first
      // small pause and the bot answered immediately — that was the bug.
      recognition.continuous = true;
      recognition.interimResults = true; // live transcription while speaking
      recognition.lang = "hi-IN";
      // Ask for alternatives so we can keep the MOST CONFIDENT transcription
      // of each chunk — noticeably better accuracy for Hinglish words.
      recognition.maxAlternatives = 3;

      let gotResult = false;
      let hadError = false;
      let audioStarted = false;
      let finalTranscript = ""; // everything recognised so far (whole sentence)
      let silenceTimer = null;
      let sent = false;

      // Finalise: stop the mic and send the complete sentence
      const sendTranscript = () => {
        if (sent) return;
        sent = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        stopEarlyRef.current = null;
        isListeningRef.current = false;
        setIsListening(false);
        setInterimText("");
        try { recognition.stop(); } catch (_) { /* already stopped */ }
        // Devanagari -> Roman letters + drop hallucinated filler repeats
        // (e.g. "आच्छे आच्छे आच्छे इस्ट्रिम ..." -> "istrim ..."), then fix
        // common phonetic mishearings ("inglish medisin" -> "Envistream
        // EduSkill") before sending.
        const raw = toHinglish(finalTranscript.replace(/\s+/g, " ").trim());
        const text = fixPhonetics(raw);
        if (text) sendMessage(text);
      };

      // Keep listening while you talk; wait ~2 seconds of silence
      // before auto-sending so the speaker is never cut off mid-thought.
      // (The user can also tap the mic icon again to send immediately.)
      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(sendTranscript, 2000);
      };
      stopEarlyRef.current = sendTranscript;

      recognition.onaudiostart = () => {
        audioStarted = true;
      };

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            gotResult = true;
            // Among the alternatives, keep the one Chrome is MOST confident
            // about (falls back to the first when no confidence is given).
            let best = result[0];
            for (let j = 1; j < result.length; j++) {
              if ((result[j].confidence || 0) > (best.confidence || 0)) {
                best = result[j];
              }
            }
            // Accumulate — do NOT send yet, the sentence may continue
            finalTranscript += best.transcript + " ";
          } else {
            interim += result[0].transcript;
          }
        }
        // Show live transcription (in English letters) of everything heard so far
        const liveText = toEnglishLetters(
          (finalTranscript + " " + interim).replace(/\s+/g, " ").trim()
        );
        if (liveText) setInterimText(liveText);
        // Still hearing speech → keep waiting for the rest of the sentence
        resetSilenceTimer();
      };

      recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        hadError = true;
        sent = true; // don't auto-send after an error
        if (silenceTimer) clearTimeout(silenceTimer);
        stopEarlyRef.current = null;

        isListeningRef.current = false;
        setIsListening(false);
        setInterimText("");

        // Ignore 'aborted' — it happens when we cancel recognition ourselves
        if (event.error === "aborted") return;

        let errorText = "Oops! Speech samajh nahi aaya, fir se bolo na...";
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          errorText = "Mic permission blocked hai! Address bar ke 🔒 icon pe click karke microphone ALLOW karo, page reload karo. 🎙️";
        } else if (event.error === "no-speech") {
          errorText = "Kuch sunai nahi diya... mic ke paas aake thoda aur clearly bolo na! 🎙️";
        } else if (event.error === "network") {
          errorText = "Network problem hai! Speech recognition ke liye internet chahiye. 📶";
        } else if (event.error === "audio-capture") {
          errorText = "Mic detect nahi hua! Microphone connect karo aur fir se try karo. 🎙️";
        } else if (event.error === "language-not-supported") {
          errorText = "Ye browser ye language recognize nahi kar pa raha! Chrome ka naya version try karo. 🎙️";
        }

        setMessages((prev) => [
          ...prev,
          { text: errorText, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
        ]);
      };

      recognition.onend = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        // Chrome sometimes ends the session by itself (silence cut-off) —
        // send whatever full sentence we managed to hear
        if (!sent && gotResult && finalTranscript.trim()) {
          sendTranscript();
          return;
        }
        stopEarlyRef.current = null;
        isListeningRef.current = false;
        setIsListening(false);
        setInterimText("");

        if (gotResult || hadError) return;

        if (!audioStarted) {
          // Recognition ended BEFORE the mic even opened. This happens when
          // the bot's text-to-speech was still holding the audio channel.
          // Retry once silently instead of showing an error to the user.
          if (!isRetry) {
            console.warn("Recognition ended before audio start — retrying...");
            isListeningRef.current = true; // block new presses while retrying
            setTimeout(() => beginRecognition(true), 400);
          } else {
            setMessages((prev) => [
              ...prev,
              { text: "Mic start nahi ho paya! Ek baar fir se 🎤 dabao.", sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
            ]);
          }
        }
        // Heard silence → stay quiet, no message
      };

      recognition.start();
      isListeningRef.current = true;
      setIsListening(true);
      playListenTone();
    };

    // Open the mic immediately with a gentle chime tone.
    // We NO LONGER speak "Sun rahi hoon! Bol na" first because:
    //  1. The bot speaking delayed the mic, making users talk too early
    //     (their first words were cut off or not recorded).
    //  2. Chrome's TTS audio channel collided with the mic recognizer,
    //     causing missed words and distorted transcripts.
    //  3. A quick chime tone provides instant feedback that the mic is ON.
    beginRecognition();
  };

  const onEmojiClick = (emojiObject) => {
    setUserInput((prev) => prev + emojiObject.emoji);
    setShowEmojiPicker(false);
  };

  const deleteAllMessages = () => {
    if (window.confirm("Kya aap sach mein saare messages delete karna chahte ho?")) {
      setMessages([]);
      setConversationHistory([]);
      localStorage.removeItem("sayraaMessages");
      const clearMessage = `Saare messages delete ho gaye! Main nayi shuruaat ke liye taiyaar hoon! 😊`;
      setMessages([{ text: clearMessage, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
      speakText(clearMessage, "HINGLISH");
    }
  };

  const handleQuickReply = (query) => {
    setUserInput(query);
    sendMessage(query);
  };

  const sendMessage = async (input = userInput) => {
    if (!input.trim()) return;

    // Wake up and unpause speech synthesis on user interaction
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (_) {}
    }

    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const newMessages = [...messages, { text: input, sender: "user", timestamp }];
    setMessages(newMessages);
    setUserInput("");
    setIsTyping(true);

    try {

    
      const replyLang = detectUserLanguage(input);

      if (isIdentityRequest(input)) {
        const identityText =
          replyLang === "ENGLISH"
            ? "I am Sayraa, the AI assistant of Envistream EduSkill! I guide students about IT courses, training, and internships. How can I help you today? 😊"
            : "Main Sayraa hoon, Envistream EduSkill ki AI assistant! Main students ko IT courses, training aur internships ke baare mein guide karti hoon. Main aapki kya help kar sakti hoon? 😊";

        setConversationHistory((prev) =>
          trimHistory([
            ...prev,
            { role: "user", parts: [{ text: input }] },
            { role: "model", parts: [{ text: identityText }] },
          ])
        );

        setMessages((prev) => [
          ...prev,
          { text: identityText, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
        ]);

        speakText(identityText, replyLang);
        setIsTyping(false);
        return;
      }

      if (isCodeWritingRequest(input)) {
        const refusalText =
          replyLang === "ENGLISH"
            ? "I cannot help you with writing code because I am Sayraa, the Envistream EduSkill AI assistant, and I guide about courses, training, and internships! If you want to learn programming, we offer courses in Python, Web Development, Full-Stack, and Java! 😊"
            : "Main code likhne mein help nahi kar sakti kyunki main Sayraa hoon, Envistream EduSkill ki AI assistant — main courses, training aur internships ke baare mein guide karti hoon! Agar aap coding seekhna chahte hain, toh hamare yahan Python, Web Development aur Java ke courses available hain! 😊";

        setConversationHistory((prev) =>
          trimHistory([
            ...prev,
            { role: "user", parts: [{ text: input }] },
            { role: "model", parts: [{ text: refusalText }] },
          ])
        );

        setMessages((prev) => [
          ...prev,
          { text: refusalText, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
        ]);

        speakText(refusalText, replyLang);
        setIsTyping(false);
        return;
      }
      const languageInstruction = buildLanguageInstruction(replyLang);
      const languageTag =
        replyLang === "ENGLISH"
          ? "\n[LANGUAGE DETECTED: ENGLISH — reply in PURE ENGLISH ONLY. Zero Hindi/Hinglish words anywhere in the reply.]"
          : "\n[LANGUAGE DETECTED: HINGLISH — reply in HINGLISH ONLY (Hindi in Roman letters). No Devanagari, no pure-English sentences.]";
      const fullSystemInstruction = `${languageInstruction}\n\n${medConfig.systemMessage}\n\n${languageInstruction}`;

      // Build the contents array for the chat backend.
      // The language tag rides along with the outgoing turn ONLY — it is never
      // saved into conversationHistory, so it can't pile up across messages.
      // History is trimmed so the request stays inside Groq's free token budget.
      const chatContents = [
        ...trimHistory(conversationHistory),
        {
          role: "user",
          parts: [{ text: `${input}${languageTag}` }],
        },
      ];

      let aiText = "";
      let lastChatError = "";
      let serverError = "";
      const deadlineStart = Date.now();
      const timeLeft = () => 30000 - (Date.now() - deadlineStart); // global cap: nothing waits longer than 30s total

      // Groq-only: the server (api/chat.js) tries the free Groq models
      // (openai/gpt-oss-20b -> openai/gpt-oss-120b). There is no browser-side
      // fallback — it would only duplicate the request.
      const askServer = async (systemInstruction, contents, budgetMs) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(2000, budgetMs));
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ systemInstruction, contents }),
          });
          if (response.ok) {
            const data = await response.json();
            return { text: (data.text || "").trim() };
          }
          const errData = await response.json().catch(() => ({}));
          return {
            text: "",
            error: errData.error || `${response.status} - ${response.statusText}`,
          };
        } catch (e) {
          return { text: "", error: e?.message || String(e) };
        } finally {
          clearTimeout(timeout);
        }
      };

      const serverPromise = (async () => {
        const first = await askServer(
          fullSystemInstruction,
          chatContents,
          Math.min(12000, timeLeft())
        );

        if (first.text && !replyIsWrongLanguage(first.text, replyLang)) return first.text;

        if (first.text) {
          // Reply came back in the WRONG language — re-ask ONCE with a
          // reinforced directive, then accept whatever we get.
          if (timeLeft() > 1500) {
            const retryInstruction =
              `${languageInstruction}\n\n${medConfig.systemMessage}\n\n${languageInstruction}` +
              `\n\nREMINDER: your previous reply used the WRONG language. Rewrite it with EVERY word in ${replyLang} only.`;
            const retry = await askServer(
              retryInstruction,
              chatContents,
              Math.min(12000, timeLeft())
            );
            if (retry.text && !replyIsWrongLanguage(retry.text, replyLang)) return retry.text;
            if (retry.text) return retry.text;
          }
          // If expected Hinglish but got English off-topic refusal, convert to Hinglish
          if (replyLang === "HINGLISH" && /only provide information about courses|only help with courses|apologize|feel free to ask/i.test(first.text)) {
            return "Ye question mere topic aur courses se bahar hai. Main Sayraa hoon, Envistream EduSkill ki AI assistant — main IT software courses aur internships guide karti hoon! 😊";
          }
          return first.text;
        }

        serverError = first.error || "unknown error";
        return "";
      })();

      aiText = await serverPromise;

      // Safety net: If user wrote in Hinglish and AI returned an off-topic English refusal
      if (replyLang === "HINGLISH" && /only provide information about courses|only help with courses|apologize|feel free to ask/i.test(aiText)) {
        aiText = "Ye question mere topic aur courses se bahar hai. Main Sayraa hoon, Envistream EduSkill ki AI assistant — main IT software courses aur internships guide karti hoon! 😊";
      }

      if (!aiText) {
        lastChatError = `server(${serverError})`;
      }

      if (!aiText) throw new Error(`Groq API Error: ${lastChatError}`);

      // Safety net: Sayraa NEVER outputs code blocks or programming snippets
      if (/\`\`\`|def\s+\w+\(|console\.log|#include|public\s+class|System\.out\.println/i.test(aiText)) {
        aiText =
          replyLang === "ENGLISH"
            ? "I cannot help you with writing code because I am Sayraa, the Envistream EduSkill AI assistant, and I guide about courses, training, and internships! If you want to learn programming, we offer courses in Python, Web Development, Full-Stack, and Java! 😊"
            : "Main code likhne mein help nahi kar sakti kyunki main Sayraa hoon, Envistream EduSkill ki AI assistant — main courses, training aur internships ke baare mein guide karti hoon! Agar aap coding seekhna chahte hain, toh hamare yahan Python, Web Development aur Java ke courses available hain! 😊";
      }

      // Format display text keeping code blocks intact
      const displayText = formatDisplayText(aiText) || aiText;

      setConversationHistory((prev) =>
        trimHistory([
          ...prev,
          { role: "user", parts: [{ text: input }] },
          { role: "model", parts: [{ text: displayText }] },
        ])
      );

      setMessages((prev) => [
        ...prev,
        { text: displayText, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);

      // Speak the reply with a voice matching its language (English reply ->
      // English voice, Hinglish reply -> Hindi voice); speakText also strips
      // emojis & fixes the brand pronunciation.
      speakText(aiText, replyLang);
    } catch (error) {
      console.error("API Error:", error);
      // Error text must match the user's language too — an English question
      // should never get a Hinglish error bubble.
      const errorLang = detectUserLanguage(input);
      const errorMessage = buildChatErrorMessage(errorLang, error?.message || "");
      setMessages((prev) => [
        ...prev,
        { text: errorMessage, sender: "ai", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      ]);
      speakText(errorMessage, errorLang);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className={styles.chatContainer}>
      <div className={styles.header}>
        <img src={eduskillLogo} alt="Envistream EduSkill" className={styles.avatar} />
        <div className={styles.headerInfo} onClick={() => navigate('/')} style={{ cursor: 'pointer', flex: 1 }}>
          <span className={styles.headerTitle}>Sayraa</span>
          <span className={styles.headerSubtitle}>Your AI Guide to Learning, Internships & Careers</span>
        </div>
        <button onClick={deleteAllMessages} className={styles.deleteButton} title="Clear Chat">
          🗑️
        </button>
      </div>
      <div 
        id="chatBox" 
        className={styles.chatBox}
        style={{
          backgroundImage: `linear-gradient(rgba(15, 23, 42, 0.85), rgba(30, 27, 75, 0.85)), url(${chatBg})`
        }}
      >
        {messages.map((msg, index) => (
          <div
            key={index}
            className={styles[`${msg.sender}-message`]}
            data-timestamp={msg.timestamp}
          >
            {msg.text}
            <span className={styles.timestamp}>{msg.timestamp}</span>
          </div>
        ))}
        {isTyping && <div className={styles.typing}>Typing...</div>}
        {isListening && <div className={styles.typing}>🎙️ {interimText || "sun rahi hoon, bolte jao..."}</div>}
        <div ref={chatEndRef} />
      </div>

      <div className={styles.footer}>
        <div className={styles.inputWrapper}>
          <span
            className={styles.smileyIcon}
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
          >
            😊
          </span>
          {showEmojiPicker && (
            <div className={styles.emojiPicker}>
              <Picker onEmojiClick={onEmojiClick} />
            </div>
          )}
          <input
            id="userInput"
            type="text"
            placeholder="Apna message likho..."
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && sendMessage()}
            className={styles.inputField}
          />
          {userInput.trim() ? (
            <button
              id="sendButton"
              onClick={() => sendMessage()}
              className={styles.sendButton}
            >
              <span role="img" aria-label="send">➡️</span>
            </button>
          ) : (
            <button
              id="micButton"
              onClick={startListening}
              className={`${styles.micButton} ${isListening ? styles.micButtonListening : ""}`}
              title={isListening ? "Sun rahi hoon! Click karke turant send karo 🎙️" : "Voice input ke liye click karo 🎤"}
            >
              {isListening ? "🎙️" : "🎤"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Chat;