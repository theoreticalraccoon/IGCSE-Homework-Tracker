/** The three AI routes, and the friendly errors they can produce. */

import { callFunction, streamFunction } from "./client.js";

/**
 * Streamed, grounded answer.
 *
 * `onCitations` fires before any text, so the sources panel can render while
 * the model is still thinking. Which is also the honest moment to tell the
 * student that nothing was retrieved.
 */
export function ask({ question, subject, mode = "ask", threadId, history = [] }, handlers, options) {
  return streamFunction(
    "ask",
    { question, subject, mode, threadId, history },
    {
      citations: (d) => handlers.onCitations?.(d.citations ?? [], d.grounded),
      delta: (d) => handlers.onDelta?.(typeof d === "string" ? d : String(d ?? "")),
      done: (d) => handlers.onDone?.(d),
      error: (d) => handlers.onError?.(new Error(d.message ?? "Generation failed.")),
    },
    options,
  );
}

export function markAnswer(body, options) {
  return callFunction("mark", body, options);
}

export function generateMock(body, options) {
  return callFunction("mock", body, options);
}

/** Whole-paper marking from photos. Slow by nature: two model passes. */
export function markPaper(body, options) {
  return callFunction("mark-paper", body, options);
}

/** Add one past-paper PDF to the corpus. */
export function ingestPaper(body, options) {
  return callFunction("ingest", body, options);
}

/** Turn a route error into something a student can act on. */
export function explainError(error) {
  if (error?.name === "AbortError") return null;
  if (error?.status === 429) {
    return error.message ?? "You have used today's AI allowance. It resets at midnight UTC.";
  }
  if (error?.status === 401) return "Your session expired. Sign in again.";
  // Routes that explain themselves: pass their wording straight through.
  for (const code of ["empty_corpus", "not_found", "no_markscheme", "unrecognised", "unsupported", "no_answers"]) {
    if (error?.code === code) return error.message;
  }
  if (error?.status === 413) return "That file is too large. Try a smaller scan, or fewer photos.";
  if (error?.status === 502) return "Gemini is busy right now. Try again in a moment.";
  return error?.message ?? "Something went wrong.";
}
