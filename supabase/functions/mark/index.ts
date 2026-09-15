/**
 * POST /functions/v1/mark
 *
 * Marks one answer against the real mark scheme.
 *
 * Two entry paths, because students arrive two ways:
 *   - chunkId. They picked the question in the library or a mock. Exact.
 *   - question. They typed or pasted it ("0625 Jun 2019 P42 Q4(b)", or the
 *     question text itself). Retrieval finds the paper, and the response says
 *     which question it matched so a wrong match is visible, not silent.
 *
 * The result is written to `attempts`, which the mastery trigger folds into the
 * student's weakness profile. This is the loop that makes every other feature
 * personal.
 *
 * Body: { answer, chunkId? , question?, subject?, mockId? }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, QuotaExceeded } from "../_shared/quota.ts";
import { generateJSON } from "../_shared/gemini.ts";
import {
  search,
  getQuestion,
  packContext,
  toCitation,
  label,
  parseQuery,
  type Chunk,
} from "../_shared/retrieve.ts";
import { MARK_SYSTEM, MARK_SCHEMA, markUserPrompt } from "../_shared/prompts.ts";

interface Body {
  answer: string;
  chunkId?: string | null;
  question?: string | null;
  subject?: string | null;
  mockId?: string | null;
  /** Skip writing to attempts: used when marking a mock question by question. */
  noRecord?: boolean;
}

interface MarkResult {
  awarded: number;
  total: number;
  breakdown: { point: string; earned: boolean; why: string }[];
  missed: string[];
  strengths: string[];
  modelAnswer: string;
  feedback: string;
  topic?: string;
  syllabusRefs?: string[];
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

  const answer = (body.answer ?? "").trim();
  if (!answer) return fail(req, "Paste your answer first.");
  if (answer.length > 12000) return fail(req, "That answer is too long to mark.");
  if (!body.chunkId && !body.question) {
    return fail(req, "Tell Markwise which question this answers.");
  }

  try {
    await claim(user.id, "mark");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // ---- locate the question ------------------------------------------------
  let parts: Chunk[] = [];
  try {
    if (body.chunkId) {
      parts = await getQuestion(admin, body.chunkId);
    } else {
      const hits = await search(admin, body.question!, {
        subject: body.subject ?? null,
        kinds: ["question"],
        count: 4,
        expandSiblings: true,
        filters: parseQuery(body.question!),
      });
      parts = hits;
    }
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "Could not find that question.", 502);
  }

  if (parts.length === 0) {
    return json(req, {
      error: "not_found",
      message:
        "No matching question in the corpus. Check the paper code, or pick the question from the Library.",
    }, 404);
  }

  // The target is the exact chunk asked for, or the best-scoring hit.
  const target = body.chunkId
    ? (parts.find((p) => p.id === body.chunkId) ?? parts[0])
    : parts[0];

  if (!target.ms_content) {
    return json(req, {
      error: "no_markscheme",
      message: `The mark scheme for ${label(target)} has not been ingested yet, so Markwise will not guess at the marks.`,
      citation: toCitation(target),
    }, 409);
  }

  // ---- mark ---------------------------------------------------------------
  const { text: sources, used } = packContext(parts, 20000);
  const total = target.marks ?? 0;

  let result: MarkResult;
  try {
    result = await generateJSON<MarkResult>(
      markUserPrompt(target.content, answer, sources, total),
      MARK_SCHEMA as unknown as Record<string, unknown>,
      { system: MARK_SYSTEM, temperature: 0, maxOutputTokens: 2200 },
    );
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "Marking failed.", 502);
  }

  // The model is told never to exceed the total; clamp anyway, because a
  // marking tool that can award 9/6 is worse than useless.
  const cap = total || result.total || 0;
  const awarded = Math.max(0, Math.min(cap, Number(result.awarded) || 0));

  const questionRef = label(target);
  const topic = result.topic ?? target.topic ?? null;

  // ---- record -------------------------------------------------------------
  let attemptId: string | null = null;
  if (!body.noRecord) {
    const { data, error } = await user.db.from("attempts").insert({
      chunk_id: target.id,
      mock_id: body.mockId ?? null,
      subject_code: target.subject_code,
      question_ref: questionRef,
      question_text: target.content,
      answer_text: answer,
      awarded,
      total: cap,
      breakdown: result.breakdown ?? [],
      missed: result.missed ?? [],
      strengths: result.strengths ?? [],
      topic,
      syllabus_refs: result.syllabusRefs ?? target.syllabus_refs ?? [],
      model_answer: result.modelAnswer ?? null,
    }).select("id").single();
    if (error) console.error("Attempt save failed:", error.message);
    else attemptId = data.id;
  }

  return json(req, {
    attemptId,
    questionRef,
    questionText: target.content,
    markScheme: target.ms_content,
    examinerReport: target.er_content,
    awarded,
    total: cap,
    pct: cap ? Math.round((awarded / cap) * 100) : null,
    breakdown: result.breakdown ?? [],
    missed: result.missed ?? [],
    strengths: result.strengths ?? [],
    modelAnswer: result.modelAnswer ?? "",
    feedback: result.feedback ?? "",
    topic,
    citations: used.map(toCitation),
  });
});
