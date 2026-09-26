// ---- Groq Whisper Speech-to-Text (AI mic) ----
// Chrome's free Web Speech recognizer cannot learn custom words, so it keeps
// mishearing the brand "Envistream EduSkill" differently on every try (fast,
// slow, odd pace...). So we record the mic audio with the modern MediaRecorder
// and send it to Groq's FREE Whisper models, which transcribe Hindi/Hinglish
// accurately and keep English brand words correct.

import { toHinglish } from "./hinglishText";

const GROQ_API_KEY =
  (typeof process !== "undefined" && process.env
    ? process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY || ""
    : import.meta.env
    ? import.meta.env.VITE_GROQ_API_KEY || import.meta.env.GROQ_API_KEY || ""
    : "");

// Free Groq Whisper models — turbo first (fast), large-v3 as accurate fallback
const WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];


const WHISPER_PROMPT =
  'Hinglish, Hindi written in Roman (English) letters. Envistream EduSkill. courses, internship, placement, training, provide, location, fees, admission.';

// Whisper invents these phrases when the audio is silence/noise — drop them.
const SILENCE_ARTIFACTS = new Set([
  "thank you", "thank you very much", "thanks", "thanks for watching",
  "thank you for watching", "please subscribe", "subscribe", "like and subscribe",
  "you", "bye", "bye bye", "okay", "ok", "hmm", "mm", "uh", "um", "so", "yeah",
  "dhanyavaad", "dhanyavad", "pura", "haan", "umm", "are",
  "धन्यवाद", "धन्यवाद।", "पूरा", "हाँ", "हाँ।", "उम्म", "अरे", "ठीक है",
]);

const isSilenceArtifact = (text) => {
  const key = (text || "")
    .toLowerCase()
    .replace(/[।.,!?;:"'`\-–—…()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return !key || SILENCE_ARTIFACTS.has(key);
};

const AUDIO_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "video/mp4": "mp4",
};

export const isGroqSTTAvailable = () => true;

// The modern mic APIs (MediaRecorder / FileReader) only exist in new browsers
export const cloudMediaSupported = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";


// ---- Recording helpers ----

// Open the mic and start recording. Returns the recorder + collected chunks.
export const startCloudRecording = async () => {
  let stream;
  try {
    // Prefer AAC (audio/mp4) — a format Whisper handles reliably, plus noise
    // suppression & AGC so every word is captured cleanly.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        automaticGainControl: true,
        codecs: ["aac"],
      },
    });
  } catch (_) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        automaticGainControl: true,
      },
    });
  }

  // Some Chrome versions don't expose track.audioFormat — fall back safely.
  const track = stream.getAudioTracks()?.[0];
  const codec = track?.audioFormat?.codec || "opus"; // "aac" | "opus" | default
  let recorder;
  try {
    recorder = new MediaRecorder(stream, codec === "aac" ? "audio/mp4;codecs=aac" : "audio/webm;codecs=opus");
  } catch (_) {
    // Constructor with a mime can fail on old versions — let Chrome pick its default.
    recorder = new MediaRecorder(stream);
  }

  const chunks = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  // Collect in frequent 200ms intervals so no words are dropped at the end
  recorder.start(200);
  return { stream, recorder, chunks };
};

// Stop recording and assemble the audio file (Blob).
export const stopCloudRecording = async ({ recorder, chunks, stream }) => {
  return new Promise((resolve) => {
    const handleStop = () => {
      try {
        stream?.getTracks()?.forEach((t) => t.stop());
      } catch (_) {}
      if (!chunks.length) {
        resolve(null);
      } else {
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      }
    };

    if (recorder.state === "inactive") {
      handleStop();
      return;
    }

    recorder.addEventListener("stop", handleStop, { once: true });
    try {
      recorder.stop();
    } catch (_) {
      handleStop();
    }
  });
};


// ---- Transcription ----

const blobToBase64 = async (blob) => {
  let buffer;
  if (typeof blob.arrayBuffer === "function") {
    buffer = await blob.arrayBuffer();
  } else {
    buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32 KB — safely under string limits
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

export const transcribeWithGroq = async (blob) => {
  const rawMime = blob.type || "audio/webm";
  // Whisper wants a clean MIME type without codec parameters
  // (e.g. 'audio/webm' instead of 'audio/webm;codecs=opus')
  const mimeType = rawMime.split(";")[0].trim() || "audio/webm";

  // 1. Try the secure server route first (API key stays server-side)
  try {
    const data = await blobToBase64(blob);
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mimeType, data }),
    });
    if (res.ok) {
      const json = await res.json();
      // Always hand back Roman-letter Hinglish (Whisper may answer in Devanagari)
      const text = toHinglish(json.text || "");
      // A reply that came back from Groq (has `via`) with no text means silence —
      // don't waste another transcription round from the browser.
      if (text) return text;
      if (json.via) return "";
    }
  } catch (_) {
    // serverless route unavailable — fall through to the direct call
  }

  // 2. Direct browser -> Groq Whisper fallback (multipart upload)
  const extension = AUDIO_EXTENSIONS[mimeType] || "webm";
  let lastStatus = 0;
  let lastBody = "";

  for (const model of WHISPER_MODELS) {
    try {
      const form = new FormData();
      form.append("file", blob, `audio.${extension}`);
      form.append("model", model);
      form.append("response_format", "json");
      form.append("temperature", "0");
      form.append("prompt", WHISPER_PROMPT);

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
      });

      if (response.ok) {
        const json = await response.json();
        const text = toHinglish(json.text || "");
        if (!text || isSilenceArtifact(text)) return "";
        return text;
      }

      lastStatus = response.status;
      lastBody = await response.text();
      console.warn(`Groq STT with model "${model}" failed (${lastStatus}) — trying next candidate...`);
    } catch (e) {
      console.warn(`Groq STT network error on "${model}":`, e);
    }
  }

  throw new Error(`Groq STT error ${lastStatus}: ${lastBody.slice(0, 300)}`);
};
