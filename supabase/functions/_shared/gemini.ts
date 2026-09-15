/**
 * Gemini client tuned for the free tier.
 *
 * Three things matter at this tier and are handled here rather than at each
 * call site:
 *
 *  1. Rate limits are per-key and low. GEMINI_API_KEYS may hold several
 *     comma-separated keys; requests round-robin across them and a 429 rotates
 *     to the next key before backing off.
 *  2. Free-tier 429/503 are routine, not exceptional. Every call retries with
 *     jittered exponential backoff.
 *  3. Embedding is the expensive half of ingestion, so batchEmbedContents is
 *     used and the task type is set correctly (RETRIEVAL_QUERY for questions
 *     the student types, RETRIEVAL_DOCUMENT for corpus text).
 */

const API = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Generation models, tried in order.
 *
 * Free-tier quota is per model as well as per key, and the flagship flash
 * model is the most contended. A student asking a question at a busy moment
 * gets a 429 from it and a perfectly good answer from the next one down. The
 * better model leads here (unlike ingestion) because this text is read by a
 * student and marking quality matters more than throughput.
 */
export const CHAT_MODELS = (Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CHAT_MODEL = CHAT_MODELS[0];
export const EMBED_MODEL = Deno.env.get("GEMINI_EMBED_MODEL") ?? "gemini-embedding-001";

/**
 * Must match the ingestion pipeline and the `vector(768)` column exactly. A
 * query embedded at a different width cannot be compared with the corpus.
 */
export const EMBED_DIMS = 768;

const KEYS = (Deno.env.get("GEMINI_API_KEYS") ?? Deno.env.get("GEMINI_API_KEY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (KEYS.length === 0) {
  console.warn("GEMINI_API_KEY / GEMINI_API_KEYS is not set: AI routes will fail.");
}

let keyCursor = 0;
function nextKey(): string {
  if (KEYS.length === 0) throw new Error("No Gemini API key configured.");
  const k = KEYS[keyCursor % KEYS.length];
  keyCursor++;
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This model has no quota left today. The caller should try the next one. */
class QuotaExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhausted";
  }
}

async function callGemini(
  path: string,
  body: unknown,
  { retries = 4, stream = false }: { retries?: number; stream?: boolean } = {},
): Promise<Response> {
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const key = nextKey();
    const url = `${API}/${path}${stream ? "?alt=sse&" : "?"}key=${key}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = `network: ${e instanceof Error ? e.message : String(e)}`;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res;

    // 429 means this model's quota is spent: for the day, not for the next
    // few seconds. Backing off cannot fix it and only delays the fallback to a
    // model that would have answered immediately, so give up on this one at
    // once. 503/500 are genuine transients and do deserve a retry.
    if (res.status === 429) {
      throw new QuotaExhausted(`${path.split("/")[1]?.split(":")[0] ?? "model"} is out of quota.`);
    }
    if (res.status === 503 || res.status === 500) {
      lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      await sleep(backoff(attempt));
      continue;
    }

    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 400)}`);
  }
  throw new Error(`Gemini unavailable after ${retries + 1} attempts. Last: ${lastErr}`);
}

function backoff(attempt: number): number {
  return Math.min(16000, 700 * 2 ** attempt) + Math.random() * 400;
}

/* ------------------------------------------------------------------ embed -- */

export type EmbedTask = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";

/** Embed one string. Used for search queries. */
export async function embedOne(text: string, taskType: EmbedTask = "RETRIEVAL_QUERY"): Promise<number[]> {
  const [v] = await embedBatch([text], taskType);
  return v;
}

/** Embed up to 100 strings in one request (the API's batch ceiling). */
export async function embedBatch(
  texts: string[],
  taskType: EmbedTask = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const slice = texts.slice(i, i + 100);
    const res = await callGemini(`models/${EMBED_MODEL}:batchEmbedContents`, {
      requests: slice.map((t) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: truncate(t, 8000) }] },
        taskType,
        outputDimensionality: EMBED_DIMS,
      })),
    });
    const data = await res.json();
    for (const e of data.embeddings ?? []) out.push(normalise(e.values as number[]));
  }
  return out;
}

/**
 * Scale to unit length. Vectors truncated below the model's native width come
 * back un-normalised, and the ingestion pipeline normalises before storing
 * queries must be treated identically or the two live in different spaces.
 */
export function normalise(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}

/* --------------------------------------------------------------- generate -- */

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Force a JSON response shaped by this schema (Gemini structured output). */
  jsonSchema?: Record<string, unknown>;
  /** Prior turns, oldest first. */
  history?: { role: "user" | "model"; text: string }[];
}

function buildBody(prompt: string, o: GenerateOptions) {
  const contents = [
    ...(o.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: prompt }] },
  ];
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: o.temperature ?? 0.2,
      maxOutputTokens: o.maxOutputTokens ?? 4096,
      ...(o.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: o.jsonSchema }
        : {}),
    },
    // The corpus contains exam questions about biology, history and war. The
    // default filters trip on legitimate syllabus content, so they are relaxed
    // to the lowest non-off setting the API allows.
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  return body;
}

export async function generate(prompt: string, o: GenerateOptions = {}): Promise<string> {
  const body = buildBody(prompt, o);
  let lastError: Error | null = null;

  for (const model of CHAT_MODELS) {
    let data;
    try {
      const res = await callGemini(`models/${model}:generateContent`, body);
      data = await res.json();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;   // out of quota or unavailable: fall through to the next
    }
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
    if (text) return text;

    const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason;
    lastError = new Error(`${model} returned no text (${reason ?? "unknown"}).`);
  }
  throw lastError ?? new Error("No Gemini model produced a response.");
}

/** generate() with a schema, parsed. Falls back to brace-extraction if needed. */
export async function generateJSON<T>(
  prompt: string,
  schema: Record<string, unknown>,
  o: Omit<GenerateOptions, "jsonSchema"> = {},
): Promise<T> {
  const raw = await generate(prompt, { ...o, jsonSchema: schema });
  return parseJSON<T>(raw);
}

export function parseJSON<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
    throw new Error("Model did not return valid JSON.");
  }
}

/** Streaming generate, yielding text deltas as they arrive. */
export async function* generateStream(
  prompt: string,
  o: GenerateOptions = {},
): AsyncGenerator<string> {
  // Streaming walks the same chain: the first model that opens a stream wins.
  let res: Response | null = null;
  let lastError: Error | null = null;
  for (const model of CHAT_MODELS) {
    try {
      res = await callGemini(`models/${model}:streamGenerateContent`, buildBody(prompt, o), { stream: true });
      break;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (!res) throw lastError ?? new Error("No Gemini model produced a stream.");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) if (p.text) yield p.text as string;
      } catch {
        /* partial frame. The next read completes it */
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}
