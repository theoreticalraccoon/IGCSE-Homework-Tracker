/**
 * POST /functions/v1/mark-paper
 *
 * Marks a whole past paper from photos or a scan of the student's handwriting.
 *
 * Two passes, deliberately:
 *
 *   1. Transcribe. The images go to Gemini once and come back as answers keyed
 *      by question number. Images are by far the most expensive thing in the
 *      request, so they are sent exactly once.
 *   2. Mark. The transcribed text is marked in small batches against the real
 *      mark schemes already stored for that paper. Batching keeps each response
 *      inside the output limit — a 25-question paper marked in one call runs
 *      out of room halfway down and returns truncated JSON.
 *
 * Every question is marked against its own stored scheme. A question with no
 * scheme is reported as unmarkable rather than guessed at.
 *
 * Body: { paperId, files: [{ mimeType, data }] }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, QuotaExceeded } from "../_shared/quota.ts";
import { generateJSON } from "../_shared/gemini.ts";
import { readFiles, validate, type Attachment } from "../_shared/files.ts";
import { MARK_SYSTEM } from "../_shared/prompts.ts";

const TRANSCRIBE_SYSTEM = `
You read a student's handwritten exam answers from photographs or a scan.

- One entry per question the student attempted, in the order they appear.
- questionNo is the number the student wrote against the answer: "4", "4(b)",
  "4(b)(ii)". Copy the paper's numbering exactly.
- answer is what they wrote, TRANSCRIBED VERBATIM — including working,
  crossings-out that are still legible, units and wrong answers. You are not
  correcting or improving it; a transcription that tidies up the student's
  mistakes gets them marks they did not earn.
- Transcribe mathematics linearly: x^2, 3/4, 5.2 x 10^-3.
- If a question is clearly left blank, leave it out entirely.
- If handwriting is genuinely illegible, transcribe what you can and put
  [illegible] where it is not.
`.trim();

const TRANSCRIBE_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          answer: { type: "string" },
        },
        required: ["questionNo", "answer"],
      },
    },
  },
  required: ["answers"],
} as const;

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          awarded: { type: "number" },
          breakdown: {
            type: "array",
            items: {
              type: "object",
              properties: {
                point: { type: "string" },
                earned: { type: "boolean" },
                why: { type: "string" },
              },
              required: ["point", "earned", "why"],
            },
          },
          feedback: { type: "string" },
        },
        required: ["questionNo", "awarded", "breakdown", "feedback"],
      },
    },
  },
  required: ["results"],
} as const;

const BATCH_SIZE = 5;
const key = (n: string) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

interface Question {
  id: string; question_no: string; marks: number | null;
  content: string; ms_content: string | null; topic: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "POST only", 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return fail(req, "Sign in first.", 401);
  }

  let body: { paperId?: string; files?: Attachment[] };
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid request.");
  }
  if (!body.paperId) return fail(req, "Choose which paper this is.");
  const invalid = validate(body.files ?? []);
  if (invalid) return fail(req, invalid);

  try {
    await claim(user.id, "markpaper");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // ---- the paper ----------------------------------------------------------
  const { data: paper } = await admin.from("papers")
    .select("id,subject_code,title,code,paper_no").eq("id", body.paperId).maybeSingle();
  if (!paper) return fail(req, "That paper is no longer available.", 404);

  const { data: qData } = await admin.from("chunks")
    .select("id,question_no,marks,content,ms_content,topic")
    .eq("paper_id", paper.id).eq("kind", "question");

  const questions = (qData ?? []) as Question[];
  if (!questions.length) return fail(req, "That paper has no questions stored.", 409);

  questions.sort((a, b) => naturalOrder(a.question_no, b.question_no));

  // ---- 1. transcribe ------------------------------------------------------
  let transcribed: { questionNo: string; answer: string }[];
  try {
    const out = await readFiles<{ answers: { questionNo: string; answer: string }[] }>(
      body.files!,
      `These are a student's handwritten answers to ${paper.title}. Transcribe them.`,
      TRANSCRIBE_SCHEMA as unknown as Record<string, unknown>,
      { system: TRANSCRIBE_SYSTEM },
    );
    transcribed = (out.answers ?? []).filter((a) => a.answer?.trim());
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "Could not read that handwriting.", 502);
  }

  if (!transcribed.length) {
    return json(req, {
      error: "no_answers",
      message: "No answers could be read from those images. Try clearer, closer photos of each page.",
    }, 422);
  }

  const answerFor = new Map(transcribed.map((a) => [key(a.questionNo), a.answer.trim()]));

  // ---- 2. mark, in batches ------------------------------------------------
  const attempted = questions.filter((q) => answerFor.has(key(q.question_no)));
  const markable = attempted.filter((q) => q.ms_content);
  const results = new Map<string, { awarded: number; breakdown: unknown[]; feedback: string }>();

  for (let i = 0; i < markable.length; i += BATCH_SIZE) {
    const batch = markable.slice(i, i + BATCH_SIZE);
    const prompt = batch.map((q) => [
      `QUESTION ${q.question_no} (${q.marks ?? 0} marks)`,
      q.content,
      `MARK SCHEME:`,
      q.ms_content,
      `STUDENT ANSWER:`,
      answerFor.get(key(q.question_no)),
    ].join("\n")).join("\n\n---\n\n");

    try {
      const out = await generateJSON<{ results: { questionNo: string; awarded: number; breakdown: unknown[]; feedback: string }[] }>(
        `Mark each of these answers against its own mark scheme.\n\n${prompt}`,
        BATCH_SCHEMA as unknown as Record<string, unknown>,
        { system: MARK_SYSTEM, temperature: 0, maxOutputTokens: 8192 },
      );
      for (const r of out.results ?? []) {
        results.set(key(r.questionNo), {
          awarded: Number(r.awarded) || 0,
          breakdown: r.breakdown ?? [],
          feedback: r.feedback ?? "",
        });
      }
    } catch (e) {
      console.error(`batch ${i} failed:`, e);
      // One bad batch must not lose the rest of the paper.
    }
  }

  // ---- assemble -----------------------------------------------------------
  let awarded = 0;
  let total = 0;
  const perQuestion = questions.map((q) => {
    const answer = answerFor.get(key(q.question_no)) ?? null;
    const marked = results.get(key(q.question_no));
    const cap = q.marks ?? 0;
    total += cap;

    // Clamped: a marking tool that can award 9/6 is worse than useless.
    const got = marked ? Math.max(0, Math.min(cap, marked.awarded)) : 0;
    if (marked) awarded += got;

    return {
      chunkId: q.id,
      questionNo: q.question_no,
      marks: cap,
      topic: q.topic,
      question: q.content,
      markScheme: q.ms_content,
      answer,
      awarded: marked ? got : null,
      breakdown: marked?.breakdown ?? [],
      feedback: marked?.feedback ?? "",
      status: !answer ? "blank" : !q.ms_content ? "no_markscheme" : marked ? "marked" : "failed",
    };
  });

  const pct = total ? Math.round((awarded / total) * 100) : 0;
  let grade: string | null = null;
  try {
    const { data } = await admin.rpc("predict_grade", {
      p_subject: paper.subject_code, p_paper_no: paper.paper_no ?? 1, p_pct: pct,
    });
    grade = (data as string | null) ?? null;
  } catch { /* boundaries are optional */ }

  // ---- record, so Progress and the weak-topic profile learn from it -------
  const rows = perQuestion
    .filter((q) => q.status === "marked")
    .map((q) => ({
      chunk_id: q.chunkId,
      subject_code: paper.subject_code,
      question_ref: `${paper.code ?? paper.title} Q${q.questionNo}`,
      question_text: q.question,
      answer_text: q.answer,
      awarded: q.awarded,
      total: q.marks,
      breakdown: q.breakdown,
      topic: q.topic,
    }));
  if (rows.length) {
    const { error } = await user.db.from("attempts").insert(rows);
    if (error) console.error("attempts insert failed:", error.message);
  }

  return json(req, {
    paper: { id: paper.id, title: paper.title, code: paper.code, subject: paper.subject_code },
    awarded,
    total,
    pct,
    grade,
    answered: attempted.length,
    marked: rows.length,
    unmarkable: perQuestion.filter((q) => q.status === "no_markscheme").length,
    questions: perQuestion,
  });
});

/** 2 before 10, and 4(b) before 4(b)(ii). */
function naturalOrder(a: string, b: string): number {
  const parse = (s: string) => {
    const m = String(s ?? "").match(/^(\d+)\s*\(?([a-h])?\)?\s*\(?((?:i|v|x)+)?\)?/i);
    return [Number(m?.[1] ?? 0), m?.[2] ?? "", m?.[3] ?? ""];
  };
  const [an, ap, as_] = parse(a);
  const [bn, bp, bs] = parse(b);
  if (an !== bn) return (an as number) - (bn as number);
  if (ap !== bp) return String(ap).localeCompare(String(bp));
  return String(as_).localeCompare(String(bs));
}
