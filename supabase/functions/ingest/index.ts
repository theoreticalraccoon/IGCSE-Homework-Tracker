/**
 * POST /functions/v1/ingest
 *
 * Adds one past-paper PDF to the corpus, straight from the browser.
 *
 * The student supplies a file and nothing else. No filename convention, no
 * subject code, no CLI. Gemini reads the cover page to work out what the
 * document is, then extracts either the questions or the marking points,
 * and the result is embedded and stored.
 *
 * Mark schemes are matched to a question paper that is already in the corpus
 * and fill in its `ms_content`. A mark scheme that arrives first is stored on
 * its own so the question paper can pair with it later. The student should
 * not have to care which order they dragged the files in.
 *
 * Body: { file: { mimeType, data }, fileName? }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, QuotaExceeded } from "../_shared/quota.ts";
import { embedBatch } from "../_shared/gemini.ts";
import { readFiles, validate, type Attachment } from "../_shared/files.ts";

const IDENTIFY_SYSTEM = `
You identify IGCSE exam documents from their cover page and contents.

- kind: "qp" a question paper, "ms" a mark scheme, "sy" a syllabus or
  specification, "er" an examiner report, "other" for anything else.
- subjectName is the subject as printed ("Mathematics A", "Physics").
- subjectCode is the board's syllabus code exactly as printed: Cambridge uses
  four digits (0625), Edexcel uses codes like 4MA1. Null if you cannot see one.
- session is the exam series month: "Jun" for May/June, "Nov" for October/
  November, "Mar" for February/March. Null for a syllabus.
- paperNo and variant come from the paper reference (Paper 4 Variant 2 → 4 and
  2; "1H" → paper 1, variant null).
Report only what is printed. Guess nothing.
`.trim();

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["qp", "ms", "sy", "er", "other"] },
    board: { type: "string" },
    subjectName: { type: "string" },
    subjectCode: { type: "string", nullable: true },
    year: { type: "number", nullable: true },
    session: { type: "string", nullable: true },
    paperNo: { type: "number", nullable: true },
    variant: { type: "number", nullable: true },
    tier: { type: "string", nullable: true },
  },
  required: ["kind", "subjectName"],
} as const;

const QP_SYSTEM = `
You split an IGCSE question paper into its markable parts.

- One entry per part that carries its own marks. If 4(a) has (i) and (ii),
  emit 4(a)(i) and 4(a)(ii), never 4(a).
- text is the question VERBATIM. Never summarise, correct or complete it.
  Where a part depends on a stem ("Fig. 2.1 shows a circuit", "450 students
  were asked…"), repeat that stem at the top of the part so it can be read and
  answered on its own.
- Describe any diagram the question depends on in one bracketed line, e.g.
  [Diagram: a ray of light entering a glass block at 40 degrees].
- marks is the mark allocation: Cambridge prints [3], Edexcel prints (3) in the
  margin and "(Total for Question 1 is 3 marks)" at the end.
- topic is the syllabus topic the question tests, in three words or fewer.
- Skip cover pages, formulae sheets, blank pages and answer lines.
- A part with no mark allocation is not markable. Leave it out.
`.trim();

const QP_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string" },
          marks: { type: "number" },
          topic: { type: "string", nullable: true },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["parts"],
} as const;

const MS_SYSTEM = `
You transcribe an IGCSE mark scheme into rows, one per question part.

- Copy the marking points VERBATIM, including "accept", "reject", "allow",
  "or equivalent", "oe", "ora", "owtte", "cao", "ft" and every alternative
  separated by "/". Keep the guidance column: that is where the accept and
  reject rules live.
- questionNo must match the question paper's numbering: 4(b)(ii), not "4b ii".
- marks is the allocation for that part.
- Never paraphrase. A paraphrased mark scheme cannot be marked against.
`.trim();

const MS_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string" },
          marks: { type: "number", nullable: true },
        },
        required: ["questionNo", "text"],
      },
    },
  },
  required: ["rows"],
} as const;

interface Identity {
  kind: string; board?: string; subjectName: string; subjectCode?: string | null;
  year?: number | null; session?: string | null; paperNo?: number | null; variant?: number | null;
}

const key = (n: string) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

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

  let body: { file?: Attachment; fileName?: string };
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid request.");
  }
  const file = body.file;
  if (!file) return fail(req, "No file received.");
  const invalid = validate([file]);
  if (invalid) return fail(req, invalid);

  try {
    await claim(user.id, "ingest");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // ---- what is this document? --------------------------------------------
  let id: Identity;
  try {
    id = await readFiles<Identity>(
      [file],
      `Identify this exam document.${body.fileName ? ` Its filename is "${body.fileName}".` : ""}`,
      IDENTIFY_SCHEMA as unknown as Record<string, unknown>,
      { system: IDENTIFY_SYSTEM, maxOutputTokens: 2048 },
    );
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "Could not read that file.", 502);
  }

  if (id.kind === "other") {
    return json(req, { error: "unrecognised", message: "That does not look like a past paper, mark scheme or syllabus." }, 422);
  }
  if (id.kind === "sy" || id.kind === "er") {
    return json(req, {
      error: "unsupported",
      message: `That looks like a ${id.kind === "sy" ? "syllabus" : "examiner report"}. Add question papers and mark schemes for now.`,
    }, 422);
  }

  // ---- which subject? -----------------------------------------------------
  const subjectCode = await resolveSubject(admin, id);

  // ---- extract ------------------------------------------------------------
  const paperCode = buildCode(subjectCode, id);

  if (id.kind === "ms") {
    const { rows } = await readFiles<{ rows: { questionNo: string; text: string; marks?: number | null }[] }>(
      [file], "Transcribe this mark scheme.", MS_SCHEMA as unknown as Record<string, unknown>,
      { system: MS_SYSTEM },
    ).catch((e) => { throw e; });

    const attached = await attachMarkScheme(admin, subjectCode, id, rows);
    return json(req, {
      kind: "ms",
      subject: id.subjectName,
      subjectCode,
      paperCode,
      rows: rows.length,
      attached,
      message: attached > 0
        ? `Mark scheme added: ${attached} question${attached === 1 ? "" : "s"} can now be marked.`
        : "Mark scheme saved. Add its question paper and they will be paired automatically.",
    });
  }

  // --- question paper ------------------------------------------------------
  const { parts } = await readFiles<{ parts: { questionNo: string; text: string; marks: number; topic?: string | null }[] }>(
    [file], "Split this question paper into its markable parts.",
    QP_SCHEMA as unknown as Record<string, unknown>, { system: QP_SYSTEM },
  );

  const usable = (parts ?? []).filter((p) => p.text?.trim() && p.marks > 0);
  if (!usable.length) return fail(req, "No questions could be read from that paper.", 422);

  // De-duplicate: a repeated number means the reader lost its place.
  const seen = new Set<string>();
  const clean = usable.filter((p) => {
    const k = key(p.questionNo);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const paperId = await upsertPaper(admin, subjectCode, id, paperCode, body.fileName ?? null);

  // Mark schemes this paper already had, before its rows are replaced.
  // Re-adding a question paper must never silently destroy pairings that took
  // a separate upload, or a whole CLI run, to establish.
  const existing = await loadExistingMarkSchemes(admin, paperId);
  await admin.from("chunks").delete().eq("paper_id", paperId);

  // A mark scheme uploaded before its question paper waits here for it.
  const pending = await loadPendingMarkScheme(admin, subjectCode, id);
  for (const [k, v] of existing) if (!pending.has(k)) pending.set(k, v);

  const rows = clean.map((p) => ({
    paper_id: paperId,
    subject_code: subjectCode,
    kind: "question",
    paper_code: paperCode,
    year: id.year ?? null,
    session: id.session ?? null,
    paper_no: id.paperNo ?? null,
    variant: id.variant ?? null,
    question_no: p.questionNo,
    question_root: String(p.questionNo).match(/^\d+/)?.[0] ?? null,
    marks: p.marks,
    topic: p.topic?.trim() || null,
    content: p.text.trim(),
    ms_content: pending.get(key(p.questionNo)) ?? null,
  }));

  const vectors = await embedBatch(
    rows.map((r) => [r.topic, `Question ${r.question_no} (${r.marks} marks)`, r.content, r.ms_content]
      .filter(Boolean).join("\n").slice(0, 7000)),
    "RETRIEVAL_DOCUMENT",
  ).catch(() => [] as number[][]);

  rows.forEach((r, i) => { (r as Record<string, unknown>).embedding = vectors[i] ?? null; });

  const { error } = await admin.from("chunks").insert(rows);
  if (error) return fail(req, `Could not save those questions: ${error.message}`, 500);

  const paired = rows.filter((r) => r.ms_content).length;
  return json(req, {
    kind: "qp",
    subject: id.subjectName,
    subjectCode,
    paperCode,
    questions: rows.length,
    paired,
    message: paired
      ? `${rows.length} questions added, ${paired} ready to mark.`
      : `${rows.length} questions added. Add the mark scheme to be able to mark them.`,
  });
});

/* ---------------------------------------------------------------- helpers -- */

/** Find or create the subject row this document belongs to. */
async function resolveSubject(admin: ReturnType<typeof adminClient>, id: Identity): Promise<string> {
  const printed = (id.subjectCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const board = (id.board ?? "").toLowerCase();

  // Cambridge codes are bare digits; every other board is prefixed so the two
  // can never collide. This mirrors what the CLI does with filenames.
  let code = printed;
  if (printed && !/^\d{4}$/.test(printed)) {
    const prefix = board.includes("edexcel") || board.includes("pearson") ? "E-"
      : board.includes("aqa") ? "A-"
      : board.includes("ocr") ? "O-"
      : "X-";
    code = printed.startsWith(prefix) ? printed : prefix + printed;
  }
  if (!code) code = "X-" + (id.subjectName || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

  const { data: existing } = await admin.from("subjects").select("code").eq("code", code).maybeSingle();
  if (existing) return existing.code;

  await admin.from("subjects").insert({
    code,
    name: id.subjectName || code,
    board: id.board || (/^\d{4}$/.test(code) ? "Cambridge" : "Other"),
    level: "IGCSE",
  });
  return code;
}

function buildCode(subjectCode: string, id: Identity): string {
  const letter = id.session === "Nov" ? "w" : id.session === "Mar" ? "m" : "s";
  const yy = id.year ? String(id.year).slice(2) : "00";
  const paper = id.paperNo ? `_${id.paperNo}${id.variant ?? ""}` : "";
  return `${subjectCode}_${letter}${yy}_${id.kind}${paper}`;
}

function paperMatch(admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity, kind: string) {
  return admin.from("papers").select("id")
    .eq("subject_code", subjectCode).eq("kind", kind)
    .eq("year", id.year ?? null).eq("session", id.session ?? null)
    .eq("paper_no", id.paperNo ?? null).eq("variant", id.variant ?? null)
    .maybeSingle();
}

async function upsertPaper(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
  paperCode: string, fileName: string | null,
): Promise<string> {
  const row = {
    subject_code: subjectCode, kind: id.kind, year: id.year ?? null,
    session: id.session ?? null, paper_no: id.paperNo ?? null, variant: id.variant ?? null,
    title: [id.subjectName, id.session && id.year ? `${id.session} ${id.year}` : id.year,
      id.paperNo ? `Paper ${id.paperNo}${id.variant ?? ""}` : null].filter(Boolean).join(" · "),
    code: paperCode, source_url: fileName, ingested_at: new Date().toISOString(),
  };
  const { data: existing } = await paperMatch(admin, subjectCode, id, id.kind);
  if (existing) {
    await admin.from("papers").update(row).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await admin.from("papers").insert(row).select("id").single();
  if (error) throw new Error(`Could not save that paper: ${error.message}`);
  return data.id;
}

/** Mark schemes already attached to this paper's questions, by question number. */
async function loadExistingMarkSchemes(
  admin: ReturnType<typeof adminClient>, paperId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data } = await admin.from("chunks")
    .select("question_no,ms_content").eq("paper_id", paperId).not("ms_content", "is", null);
  for (const row of data ?? []) map.set(key(row.question_no), row.ms_content);
  return map;
}

/**
 * Mark-scheme rows waiting for their question paper, keyed by question number.
 * Held as a `markscheme` chunk so nothing is lost when the files arrive in the
 * order the student happened to pick them.
 */
async function loadPendingMarkScheme(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data: msPaper } = await paperMatch(admin, subjectCode, id, "ms");
  if (!msPaper) return map;
  const { data } = await admin.from("chunks")
    .select("question_no,content").eq("paper_id", msPaper.id).eq("kind", "markscheme");
  for (const row of data ?? []) map.set(key(row.question_no), row.content);
  return map;
}

/** Store a mark scheme and fill in any question paper already ingested. */
async function attachMarkScheme(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
  rows: { questionNo: string; text: string; marks?: number | null }[],
): Promise<number> {
  const msPaperId = await upsertPaper(admin, subjectCode, id, buildCode(subjectCode, id), null);
  await admin.from("chunks").delete().eq("paper_id", msPaperId);

  const clean = (rows ?? []).filter((r) => r.questionNo && r.text?.trim());
  if (clean.length) {
    await admin.from("chunks").insert(clean.map((r) => ({
      paper_id: msPaperId, subject_code: subjectCode, kind: "markscheme",
      paper_code: buildCode(subjectCode, id), year: id.year ?? null, session: id.session ?? null,
      paper_no: id.paperNo ?? null, variant: id.variant ?? null,
      question_no: r.questionNo, marks: r.marks ?? null, content: r.text.trim(),
    })));
  }

  // Now fill in the question paper, if it is already here.
  const { data: qpPaper } = await paperMatch(admin, subjectCode, { ...id, kind: "qp" }, "qp");
  if (!qpPaper) return 0;

  const { data: questions } = await admin.from("chunks")
    .select("id,question_no").eq("paper_id", qpPaper.id).eq("kind", "question");

  const byKey = new Map(clean.map((r) => [key(r.questionNo), r.text.trim()]));
  let attached = 0;
  for (const q of questions ?? []) {
    const ms = byKey.get(key(q.question_no));
    if (!ms) continue;
    const { error } = await admin.from("chunks").update({ ms_content: ms }).eq("id", q.id);
    if (!error) attached++;
  }
  return attached;
}
