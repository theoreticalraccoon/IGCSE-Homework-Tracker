/**
 * Ingestion configuration. Read from .env in this directory (see .env.example).
 *
 * The service-role key lives here and nowhere else in the project — it bypasses
 * row-level security, so it must never reach the browser or an edge function
 * that handles user input.
 */

import "dotenv/config";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy ingest/.env.example to ingest/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const SUPABASE_URL = need("SUPABASE_URL");
export const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");

/** Comma-separated keys are rotated to spread the free-tier rate limit. */
export const GEMINI_KEYS = need("GEMINI_API_KEYS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Generation models, tried in order.
 *
 * Free-tier quota is per model as well as per key, and the flagship flash
 * model is the most contended — it returns 429/503 far more often than the
 * lite variant. Ingestion is mechanical extraction, not reasoning, so the lite
 * model leads and the others are there to absorb a bad afternoon rather than
 * to do better work.
 */
export const CHAT_MODELS = (process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.5-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CHAT_MODEL = CHAT_MODELS[0];
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

/**
 * 768, not the model's native 3072.
 *
 * gemini-embedding-001 supports Matryoshka truncation, and 768 keeps the
 * pgvector column a quarter of the size with negligible retrieval loss — which
 * matters because the corpus is hundreds of thousands of rows and Supabase's
 * free tier is 500 MB. Truncated vectors come back un-normalised, so they are
 * normalised before storage (see gemini.js).
 */
export const EMBED_DIMS = 768;

/** Free tier is ~15 requests/minute/key. Concurrency is per-key, not global. */
export const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || GEMINI_KEYS.length * 2);
export const EMBED_BATCH = Number(process.env.EMBED_BATCH || 96);

/** Set INGEST_LLM_PARSE=0 to run regex-only (free, faster, less accurate). */
export const LLM_PARSE = process.env.INGEST_LLM_PARSE !== "0";
export const LLM_CLASSIFY = process.env.INGEST_LLM_CLASSIFY !== "0";
