// ---- Sayraa chat backend (Groq only) ----
// Groq is an OpenAI-compatible endpoint. We use the FREE Groq models:
//   openai/gpt-oss-20b  (fast + free, primary)
//   openai/gpt-oss-120b (bigger + free, fallback)
// The client sends { contents, systemInstruction } (parts-based turn shape), so
// this handler converts that shape to OpenAI chat messages before calling Groq.

const GROQ_CHAT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

const getGroqKeys = () =>
  [
    process.env.GROQ_API_KEY,
    process.env.VITE_GROQ_API_KEY,
  ].filter((k, i, arr) => k && arr.indexOf(k) === i);

// parts-based contents -> OpenAI-style messages
const toOpenAIMessages = (contents, systemInstruction) => {
  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  for (const m of contents || []) {
    const text = (m.parts || []).map((p) => p.text || '').join('\n').trim();
    if (!text) continue;
    messages.push({ role: m.role === 'model' ? 'assistant' : 'user', content: text });
  }
  return messages;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contents, systemInstruction } = req.body || {};

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({ error: 'Invalid contents in request body.' });
  }

  const messages = toOpenAIMessages(contents, systemInstruction);
  if (!messages.length) {
    return res.status(400).json({ error: 'Empty conversation — nothing to send.' });
  }

  const groqKeys = getGroqKeys();
  if (!groqKeys.length) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError = '';

  // Try every key x every model. 429 (rate limit) / 5xx get one short retry.
  for (const apiKey of groqKeys) {
    for (const model of GROQ_CHAT_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 15000);

          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.7,
              max_completion_tokens: 512,
              // Free gpt-oss models: keep reasoning short so replies stay fast.
              // 512 (not 1024) is deliberate — with 1024 the model writes long
              // markdown essays; at 512 it stays within the 2-3 line rule.
              reasoning_effort: 'low',
            }),
          });
          clearTimeout(t);

          if (response.ok) {
            const data = await response.json();
            const text = (data.choices?.[0]?.message?.content || '').trim();
            if (text) {
              return res.status(200).json({ text, via: `groq:${model}` });
            }
            // Reasoning-only reply (ran out of tokens) — retry once, else next model
            lastError = `groq ${model}: empty reply`;
            if (attempt === 0) {
              await sleep(400);
              continue;
            }
            break;
          }

          const status = response.status;
          const errText = await response.text();
          lastError = `groq ${model}: ${status} - ${errText.slice(0, 200)}`;

          // 429 = this model's per-minute token budget is used up. A short
          // sleep cannot refill a rolling 1-minute window, so skip straight to
          // the next model (each model has its OWN 8000 TPM free budget).
          // 5xx (transient) gets one quick retry on the same model.
          if (status === 429) {
            break;
          }
          if (status >= 500 && attempt === 0) {
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

  return res.status(502).json({ error: `Groq API error: ${lastError}` });
}
