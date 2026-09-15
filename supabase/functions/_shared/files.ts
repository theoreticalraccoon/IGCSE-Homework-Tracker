/**
 * Sending PDFs and photos to Gemini.
 *
 * The ingestion CLI extracts text with pdf.js and parses it with regexes,
 * which is exact and free but needs a Node process and a folder of correctly
 * named files. Neither exists when a student drags a PDF into the browser, so
 * the in-app path hands the whole document to Gemini instead and lets it read
 * the layout directly: slower and not free, but it needs nothing from the
 * student except the file.
 */

import { CHAT_MODELS } from "./gemini.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";

const KEYS = (Deno.env.get("GEMINI_API_KEYS") ?? Deno.env.get("GEMINI_API_KEY") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

let cursor = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Attachment {
  mimeType: string;
  /** Base64, without the data: prefix. */
  data: string;
}

export const ALLOWED_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic",
]);

/** ~15 MB of base64 is ~11 MB of file, comfortably inside Gemini's limit. */
export const MAX_BASE64 = 15 * 1024 * 1024;

export function validate(files: Attachment[]): string | null {
  if (!files.length) return "Attach at least one file.";
  if (files.length > 12) return "That is too many files at once: send up to 12.";
  let total = 0;
  for (const f of files) {
    if (!ALLOWED_TYPES.has(f.mimeType)) return `${f.mimeType} is not a PDF or a photo.`;
    if (!f.data) return "One of the files came through empty.";
    total += f.data.length;
  }
  if (total > MAX_BASE64) return "Those files are too large: try fewer, or smaller photos.";
  return null;
}

/**
 * Ask Gemini to read the attached documents and answer in a fixed shape.
 * Walks the model chain the same way the text routes do.
 */
export async function readFiles<T>(
  files: Attachment[],
  prompt: string,
  schema: Record<string, unknown>,
  { system, maxOutputTokens = 32768 }: { system?: string; maxOutputTokens?: number } = {},
): Promise<T> {
  const body: Record<string, unknown> = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        ...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })),
      ],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let lastError = "";
  for (const model of CHAT_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!KEYS.length) throw new Error("No Gemini API key configured.");
      const key = KEYS[cursor++ % KEYS.length];
      let res: Response;
      try {
        res = await fetch(`${API}/models/${model}:generateContent?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await sleep(800 * (attempt + 1));
        continue;
      }

      if (res.status === 429) { lastError = `${model} is out of quota`; break; }  // next model
      if (!res.ok) {
        lastError = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
        await sleep(800 * (attempt + 1));
        continue;
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") {
        lastError = `${model} ran out of room before finishing. Try sending fewer pages at once.`;
        break;
      }
      const text = (candidate?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "").join("");
      if (!text) { lastError = `${model} returned nothing (${candidate?.finishReason ?? "unknown"})`; break; }

      try {
        return JSON.parse(text) as T;
      } catch {
        const a = text.indexOf("{");
        const b = text.lastIndexOf("}");
        if (a >= 0 && b > a) {
          try { return JSON.parse(text.slice(a, b + 1)) as T; } catch { /* next model */ }
        }
        lastError = `${model} returned malformed JSON`;
        break;
      }
    }
  }
  throw new Error(`Could not read those files. ${lastError}`);
}
