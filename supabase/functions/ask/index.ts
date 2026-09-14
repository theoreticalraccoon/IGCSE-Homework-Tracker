/**
 * POST /functions/v1/ask
 *
 * Grounded chat. Streams the answer back over SSE so the first token appears
 * quickly even though retrieval ran first — on a free tier that perceived
 * latency is most of the felt quality.
 *
 * Body:   { question, subject?, mode?, threadId?, history? }
 * Events: "citations" (once, before any text), "delta" (many), "done", "error"
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { preflight, fail, sseHeaders, sseEvent } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, QuotaExceeded } from "../_shared/quota.ts";
import { generateStream } from "../_shared/gemini.ts";
import { search, packContext, toCitation, parseQuery, type Citation } from "../_shared/retrieve.ts";
import { ASK_SYSTEM, TECHNIQUE_SYSTEM, askUserPrompt } from "../_shared/prompts.ts";

type Mode = "ask" | "technique" | "syllabus";

interface Body {
  question: string;
  subject?: string | null;
  mode?: Mode;
  threadId?: string | null;
  history?: { role: "user" | "model"; text: string }[];
}

/** Which corpus slices matter for this kind of question. */
function kindsFor(mode: Mode): string[] | null {
  if (mode === "syllabus") return ["syllabus", "question"];
  if (mode === "technique") return ["question", "markscheme", "examiner_report"];
  return null; // 'ask' searches everything
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "POST only", 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return fail(req, "Sign in to use Markwise AI.", 401);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid JSON body.");
  }

  const question = (body.question ?? "").trim();
  if (!question) return fail(req, "Ask a question.");
  if (question.length > 4000) return fail(req, "That question is too long.");

  const mode: Mode = body.mode ?? "ask";

  try {
    await claim(user.id, "ask");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const started = Date.now();
  const admin = adminClient(); // corpus reads bypass RLS; user data never does

  // ---- retrieve -----------------------------------------------------------
  let hits;
  try {
    hits = await search(admin, question, {
      subject: body.subject ?? null,
      kinds: kindsFor(mode),
      count: mode === "technique" ? 10 : 8,
      expandSiblings: true,
      filters: parseQuery(question),
    });
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "Retrieval failed.", 502);
  }

  const { text: sources, used } = packContext(hits, mode === "technique" ? 28000 : 22000);
  const citations = used.map(toCitation);

  // ---- personalisation ----------------------------------------------------
  let weakTopics: string[] = [];
  if (body.subject) {
    const { data } = await user.db.rpc("weak_topics", { p_subject: body.subject, p_limit: 3 });
    weakTopics = ((data ?? []) as { topic: string }[]).map((r) => r.topic);
  }

  // ---- stream -------------------------------------------------------------
  const encoder = new TextEncoder();
  const db = user.db;
  let full = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(event, data)));

      send("citations", { citations, grounded: used.length > 0 });

      try {
        const system = mode === "technique" ? TECHNIQUE_SYSTEM : ASK_SYSTEM;
        const prompt = askUserPrompt(question, sources, {
          subject: body.subject,
          weakTopics,
        });
        for await (
          const delta of generateStream(prompt, {
            system,
            history: (body.history ?? []).slice(-6),
            temperature: 0.15,
            maxOutputTokens: 1800,
          })
        ) {
          full += delta;
          send("delta", delta);
        }
        send("done", { chars: full.length, ms: Date.now() - started });
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : "Generation failed." });
      } finally {
        controller.close();
      }

      // Persisted after the socket closes so a slow write never delays the
      // last token the student sees.
      if (body.threadId && full) {
        await persist(db, body.threadId, question, full, citations);
      }
    },
  });

  return new Response(stream, { headers: sseHeaders(req) });
});

async function persist(
  db: SupabaseClient,
  threadId: string,
  question: string,
  answer: string,
  citations: Citation[],
) {
  try {
    await db.from("chat_messages").insert([
      { thread_id: threadId, role: "user", content: question, citations: [] },
      { thread_id: threadId, role: "model", content: answer, citations },
    ]);
    await db.from("chat_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", threadId);
  } catch (e) {
    console.error("Thread persist failed:", e);
  }
}
