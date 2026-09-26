// ---- Sayraa speech-to-text backend (Groq Whisper only) ----
// The browser records the mic with MediaRecorder and posts base64 audio here.
// We forward it to Groq's FREE Whisper models and return the transcript.
//   whisper-large-v3-turbo (fast + free, primary)
//   whisper-large-v3       (accurate + free, fallback)

const WHISPER_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];

// Short vocabulary hint (NOT an instruction) so brand/domain words come out right.
const WHISPER_PROMPT =
  'Envistream EduSkill. courses, internship, placement, training, provide, location, fees, admission.';

// Whisper is known to invent these phrases when the audio is silence/noise.
// They are dropped so the user never sees a phantom message.
const SILENCE_ARTIFACTS = new Set([
  'thank you', 'thank you very much', 'thanks', 'thanks for watching',
  'thank you for watching', 'please subscribe', 'subscribe', 'like and subscribe',
  'you', 'bye', 'bye bye', 'okay', 'ok', 'hmm', 'mm', 'uh', 'um', 'so', 'yeah',
  'dhanyavaad', 'dhanyavad', 'pura', 'haan', 'umm', 'are',
  'धन्यवाद', 'धन्यवाद।', 'पूरा', 'हाँ', 'हाँ।', 'उम्म', 'अरे', 'ठीक है',
]);

const normalizeForArtifactCheck = (text) =>
  text
    .toLowerCase()
    .replace(/[।.,!?;:"'`\-–—…()\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const isSilenceArtifact = (text) => {
  const key = normalizeForArtifactCheck(text);
  return !key || SILENCE_ARTIFACTS.has(key);
};

const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
};

const getGroqKeys = () =>
  [
    process.env.GROQ_API_KEY,
    process.env.VITE_GROQ_API_KEY,
  ].filter((k, i, arr) => k && arr.indexOf(k) === i);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mimeType = 'audio/webm', data } = req.body || {};

  if (!data) {
    return res.status(400).json({ error: 'Missing audio data' });
  }

  const groqKeys = getGroqKeys();
  if (!groqKeys.length) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const extension = AUDIO_EXTENSIONS[cleanMime] || 'webm';

  let audioBytes;
  try {
    audioBytes = Buffer.from(data, 'base64');
  } catch (_) {
    return res.status(400).json({ error: 'Audio data is not valid base64.' });
  }

  if (!audioBytes.length) {
    return res.status(400).json({ error: 'Audio data is empty.' });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError = '';

  for (const apiKey of groqKeys) {
    for (const model of WHISPER_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const form = new FormData();
          form.append('file', new Blob([audioBytes], { type: cleanMime }), `audio.${extension}`);
          form.append('model', model);
          form.append('response_format', 'json');
          form.append('temperature', '0');
          form.append('prompt', WHISPER_PROMPT);

          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 20000);

          const response = await fetch(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
              body: form,
            }
          );
          clearTimeout(t);

          if (response.ok) {
            const json = await response.json();
            const rawText = (json.text || '').replace(/\s+/g, ' ').trim();

            if (!rawText || isSilenceArtifact(rawText)) {
              return res.status(200).json({ text: '' });
            }
            return res.status(200).json({ text: rawText, via: `groq:${model}` });
          }

          const status = response.status;
          const errText = await response.text();
          lastError = `groq ${model}: ${status} - ${errText.slice(0, 200)}`;

          if ((status === 429 || status >= 500) && attempt === 0) {
            await sleep(1200);
            continue;
          }
          break;
        } catch (e) {
          lastError = `groq ${model}: ${e?.message || String(e)}`;
          break;
        }
      }
    }
  }

  return res.status(502).json({ error: `Groq STT error: ${lastError}` });
}
