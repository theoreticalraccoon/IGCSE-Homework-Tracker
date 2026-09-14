/**
 * Gemini client for the ingestion pipeline.
 *
 * Differs from the edge-function client in two ways that matter at ingestion
 * scale: keys are rotated round-robin across a pool (the free tier is
 * per-key, so N keys multiply throughput linearly), and 429s are treated as
 * flow control rather than errors — the pipeline slows down instead of
 * failing, because a run that dies 80% through a subject is expensive to redo.
 */

import { GEMINI_KEYS, CHAT_MODELS, EMBED_MODEL, EMBED_DIMS } from "./config.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cursor = 0;
const cooldown = new Map(); // key -> timestamp it becomes usable again

async function pickKey() {
  for (let spin = 0; spin < GEMINI_KEYS.length * 4; spin++) {
    const key = GEMINI_KEYS[cursor++ % GEMINI_KEYS.length];
    const until = cooldown.get(key) ?? 0;
    if (Date.now() >= until) return key;
  }
  // Every key is cooling down — wait for the soonest one.
  const soonest = Math.min(...GEMINI_KEYS.map((k) => cooldown.get(k) ?? 0));
  await sleep(Math.max(500, soonest - Date.now()));
  return pickKey();
}

async function call(path, body, { retries = 6 } = {}) {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const key = await pickKey();
    let res;
    try {
      res = await fetch(`${API}/${path}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      last = `network: ${e.message}`;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429) {
      // Park this key for a minute and move on; other keys keep working.
      cooldown.set(key, Date.now() + 62_000);
      last = "429 rate limit";
      continue;
    }
    if (res.status === 503 || res.status === 500) {
      last = `${res.status}`;
      await sleep(backoff(attempt));
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error(`Gemini gave up after ${retries + 1} attempts (${last}).`);
}

function backoff(n) {
  return Math.min(20000, 800 * 2 ** n) + Math.random() * 500;
}

/* ------------------------------------------------------------------ embed -- */

export async function embedBatch(texts, taskType = "RETRIEVAL_DOCUMENT") {
  if (!texts.length) return [];
  const data = await call(`models/${EMBED_MODEL}:batchEmbedContents`, {
    requests: texts.map((t) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: t.slice(0, 8000) }] },
      taskType,
      outputDimensionality: EMBED_DIMS,
    })),
  });
  return (data.embeddings ?? []).map((e) => normalise(e.values));
}

/**
 * Scale a vector to unit length.
 *
 * Only the model's native 3072 dimensions come back normalised; a truncated
 * 768-dim vector does not (measured L2 norm ≈ 0.57). Cosine distance would
 * still rank correctly, but storing un-normalised vectors makes the distances
 * themselves meaningless and would silently break anything that reads them as
 * a similarity score.
 */
export function normalise(values) {
  if (!Array.isArray(values)) return values;
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}

/* --------------------------------------------------------------- generate -- */

export async function generateJSON(prompt, schema, { system, temperature = 0, maxOutputTokens = 16384 } = {}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let lastError;
  for (const model of CHAT_MODELS) {
    let data;
    try {
      data = await call(`models/${model}:generateContent`, body);
    } catch (e) {
      lastError = e;
      continue;   // this model is out of quota or unavailable — try the next
    }

    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    // Reasoning models spend the output budget on thinking before they write.
    // Truncated JSON is the symptom; say so plainly rather than reporting a
    // parse error that looks like the model returned nonsense.
    if (candidate?.finishReason === "MAX_TOKENS") {
      lastError = new Error(`${model} hit the output limit before finishing the JSON — raise maxOutputTokens or send a smaller batch.`);
      continue;
    }
    if (!text) {
      lastError = new Error(`${model} returned no text (${candidate?.finishReason ?? "unknown"}).`);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      const a = text.indexOf("{");
      const b = text.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(text.slice(a, b + 1));
        } catch { /* fall through to the next model */ }
      }
      lastError = new Error(`${model} returned malformed JSON.`);
    }
  }
  throw lastError ?? new Error("No Gemini model produced a usable response.");
}

/**
 * OCR a page image. Cambridge papers from before ~2015 are scans, and diagram
 * pages never have a usable text layer, so this is the fallback whenever text
 * extraction comes back thin.
 */
export async function ocrPage(pngBuffer, hint = "") {
  const body = {
    contents: [{
      role: "user",
      parts: [
        {
          text:
            "Transcribe this exam page exactly. Preserve question numbers, part " +
            "labels ((a), (b)(ii)), and the mark allocations in square brackets. " +
            "Describe any diagram in one bracketed line, e.g. [Diagram: a ray of " +
            "light entering a glass block]. Output plain text only." +
            (hint ? `\nContext: ${hint}` : ""),
        },
        { inlineData: { mimeType: "image/png", data: pngBuffer.toString("base64") } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  };
  let lastError;
  for (const model of CHAT_MODELS) {
    try {
      const data = await call(`models/${model}:generateContent`, body);
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (text) return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("OCR produced no text.");
}
