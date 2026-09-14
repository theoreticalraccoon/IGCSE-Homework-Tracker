/**
 * Supabase client and the edge-function transport.
 *
 * Edge functions are called directly rather than through supabase.functions
 * .invoke() because the ask route streams SSE, and invoke() buffers.
 */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, FUNCTIONS_URL, STORAGE } from "../config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: STORAGE.auth,
  },
});

async function authHeaders() {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Your session expired — sign in again.");
  return {
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_KEY,
    "Content-Type": "application/json",
  };
}

/** POST to an edge function and parse JSON. Throws with the server's message. */
export async function callFunction(name, body, { signal } = {}) {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const err = new Error(payload?.message ?? payload?.error ?? `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = payload?.error;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/**
 * POST and consume the SSE response.
 *
 * Uses fetch + a manual parser rather than EventSource, which cannot send
 * headers and so cannot carry the auth token.
 */
export async function streamFunction(name, body, handlers = {}, { signal } = {}) {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const payload = await res.json();
      message = payload.message ?? payload.error ?? message;
    } catch {
      /* keep the default */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; a partial frame stays buffered.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      let event = "message";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let data;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      handlers[event]?.(data);
    }
  }
}
