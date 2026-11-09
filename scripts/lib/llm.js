// Groq chat completions (OpenAI-compatible REST) — the same provider the other
// Aivorah services use (aivorah-world-and-you-service, aivorah-assignments-service).
// Tries each model in GROQ_TEXT_MODELS in turn on rate limits / server errors.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODELS = 'openai/gpt-oss-120b,openai/gpt-oss-20b';

function models() {
  return (process.env.GROQ_TEXT_MODELS || DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
}

// The JSON value in a model reply: tolerates ```json fences and words around it.
function extractJSON(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(text); } catch { /* look inside */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in the AI reply');
  return JSON.parse(text.slice(start, end + 1));
}

const retryable = (status) => status === 429 || status >= 500;

async function completeJSON(messages, { fetchImpl = fetch, apiKey = process.env.GROQ_API_KEY, maxTokens = 4000 } = {}) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  let lastError;
  for (const model of models()) {
    const res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        reasoning_effort: 'low',
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      lastError = new Error(`Groq ${model} answered ${res.status}`);
      if (retryable(res.status)) continue;
      throw lastError;
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    try {
      return { model, data: extractJSON(content) };
    } catch (e) {
      lastError = e; // unusable reply — try the next model
    }
  }
  throw lastError || new Error('No Groq model configured');
}

module.exports = { completeJSON, extractJSON };
