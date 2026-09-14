/**
 * Retrieval — the part that makes Markwise different from asking Gemini.
 *
 * Pipeline, in order:
 *
 *   1. Parse the question for hard filters. "mark my answer to 0625 s19 p42
 *      Q4(b)" contains an exact paper and question; a vector search would
 *      rank it against 200k similar-sounding physics questions and lose. Any
 *      identifier found becomes a SQL filter instead of a similarity hint.
 *   2. Hybrid search (vector + full text, RRF-fused) inside those filters.
 *   3. Sibling expansion. Question parts are retrieved individually but only
 *      make sense with the stem — "4(b) Explain why this happens" is useless
 *      without 4(a). Siblings of the top hits are pulled in whole.
 *   4. Budgeted packing. Free-tier context is finite, so chunks are added
 *      highest-score-first until the character budget is spent.
 *
 * Nothing here paraphrases the corpus. The text handed to the model is the
 * verbatim question and mark scheme, which is the entire point.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { embedOne } from "./gemini.ts";

export interface Chunk {
  id: string;
  subject_code: string;
  kind: "question" | "markscheme" | "syllabus" | "examiner_report";
  paper_code: string | null;
  year: number | null;
  session: string | null;
  paper_no: number | null;
  variant: number | null;
  question_no: string | null;
  marks: number | null;
  command_word: string | null;
  topic: string | null;
  syllabus_refs: string[];
  content: string;
  ms_content: string | null;
  er_content: string | null;
  page: number | null;
  score?: number;
}

export interface Citation {
  id: string;
  label: string;        // '0625 Jun 2019 P42 Q4(b)'
  paperCode: string | null;
  questionNo: string | null;
  marks: number | null;
  topic: string | null;
  kind: string;
}

/* --------------------------------------------------- query understanding -- */

const SESSION_LETTER: Record<string, string> = { m: "Mar", s: "Jun", w: "Nov" };

export interface QueryFilters {
  paperCode?: string;
  years?: number[];
  questionNo?: string;
  session?: string;
  paperNo?: number;
}

/**
 * Pull exam identifiers out of free text. Handles both the filename form
 * (0625_s19_qp_42) and the way students actually write it
 * ("physics 2019 june paper 4 variant 2 question 7b").
 */
export function parseQuery(text: string): QueryFilters {
  const f: QueryFilters = {};
  const t = text.toLowerCase();

  // Filename form: 0625_s19_qp_42 / 0625 w21 ms 22 / e-4ma1_s24_qp_13
  //
  // The subject token is a Cambridge 4-digit code or a board-prefixed one, and
  // the separators are underscores — which are word characters, so `\b` cannot
  // be used to bound them.
  const file = t.match(
    /(?:^|[^a-z0-9])((?:[a-z]{1,3}-)?[a-z0-9]{3,12})[_ -]([msw])(\d{2})[_ -]?(?:qp|ms|er|papers?|p)?[_ -]?(\d)(\d)?(?:[^0-9]|$)/,
  );
  if (file && /\d/.test(file[1])) {
    const yy = Number(file[3]);
    f.paperCode = `${file[1]}_${file[2]}${file[3]}`;
    f.years = [yy + (yy > 50 ? 1900 : 2000)];
    f.session = SESSION_LETTER[file[2]];
    f.paperNo = Number(file[4]);
  }

  // Plain year, e.g. "2019" or "june 2021"
  if (!f.years) {
    const years = [...t.matchAll(/\b(20[0-2]\d)\b/g)].map((m) => Number(m[1]));
    if (years.length) f.years = [...new Set(years)];
  }
  if (!f.session) {
    if (/\b(june|summer|may\/june|may)\b/.test(t)) f.session = "Jun";
    else if (/\b(november|winter|oct\/nov|october)\b/.test(t)) f.session = "Nov";
    else if (/\b(march|feb\/mar|february)\b/.test(t)) f.session = "Mar";
  }
  if (f.paperNo === undefined) {
    const p = t.match(/\bpaper\s*(\d)\b/);
    if (p) f.paperNo = Number(p[1]);
  }

  // Question reference: q4b, question 4(b)(ii), Q7 a i
  const q = t.match(/\b(?:q|question)\s*\.?\s*(\d{1,2})\s*\(?([a-h])?\)?\s*\(?((?:i|v|x)+)?\)?/);
  if (q) {
    f.questionNo = q[1] + (q[2] ? `(${q[2]})` : "") + (q[3] ? `(${q[3]})` : "");
  }
  return f;
}

/* ---------------------------------------------------------------- search -- */

export interface SearchOptions {
  subject?: string | null;
  kinds?: string[] | null;
  topic?: string | null;
  count?: number;
  expandSiblings?: boolean;
  filters?: QueryFilters;
}

/** Columns every retrieval path returns. Never includes the embedding. */
const CHUNK_FIELDS =
  "id,subject_code,kind,paper_code,year,session,paper_no,variant,question_no," +
  "marks,command_word,topic,syllabus_refs,content,ms_content,er_content,page";

/**
 * When the student names both a paper and a question, look it up directly.
 *
 * Similarity search cannot do this job: "Q1(a)" carries almost no semantic
 * signal, so the right question ranks below whatever happens to be about the
 * same subject. This is the "mark my answer to 0625 Jun 2019 Q4(b)" path, and
 * getting the wrong question there means marking against the wrong scheme.
 */
async function exactLookup(
  db: SupabaseClient,
  filters: QueryFilters,
  subject?: string | null,
): Promise<Chunk[]> {
  if (!filters.questionNo || !filters.paperCode) return [];

  let q = db
    .from("chunks")
    .select(CHUNK_FIELDS)
    .eq("kind", "question")
    .ilike("paper_code", `%${filters.paperCode}%`)
    .limit(200);
  if (subject) q = q.eq("subject_code", subject);

  const { data, error } = await q;
  if (error || !data) return [];

  // Numbering is written inconsistently ("4(b)", "4 b", "4b"), so compare on a
  // stripped form rather than trusting either side's punctuation.
  const want = filters.questionNo.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const rows = data as Chunk[];

  const exact = rows.filter((c) => strip(c.question_no) === want);
  // "Q4" should also bring back 4(a), 4(b)(i) — the whole question.
  const children = rows.filter((c) => strip(c.question_no).startsWith(want) && strip(c.question_no) !== want);

  return [...exact, ...children].slice(0, 12).map((c, i) => ({ ...c, score: 100 - i }));
}

function strip(n: string | null): string {
  return (n ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export async function search(
  db: SupabaseClient,
  query: string,
  opts: SearchOptions = {},
): Promise<Chunk[]> {
  const filters = opts.filters ?? parseQuery(query);

  // A named paper + question wins outright; nothing similarity finds can beat
  // the question the student actually asked about.
  const pinned = await exactLookup(db, filters, opts.subject);

  const embedding = await embedOne(query, "RETRIEVAL_QUERY");

  const { data, error } = await db.rpc("match_chunks", {
    query_embedding: embedding,
    query_text: query,
    p_subject: opts.subject ?? null,
    p_kinds: opts.kinds ?? null,
    p_years: filters.years ?? null,
    p_paper_code: filters.paperCode ?? null,
    p_topic: opts.topic ?? null,
    match_count: opts.count ?? 8,
  });
  if (error) throw new Error(`Retrieval failed: ${error.message}`);

  let hits = (data ?? []) as Chunk[];

  // Merge the pinned exact matches in front, de-duplicated.
  if (pinned.length) {
    const seen = new Set(pinned.map((c) => c.id));
    hits = [...pinned, ...hits.filter((c) => !seen.has(c.id))];
  } else if (filters.questionNo) {
    // No paper was named, so only the number is known — promote number matches
    // rather than trusting similarity to have found them.
    const want = strip(filters.questionNo);
    hits.sort((a, b) => rankExact(b, want) - rankExact(a, want));
  }

  if (opts.expandSiblings && hits.length) {
    hits = await expandSiblings(db, hits);
  }
  return hits;
}

function rankExact(c: Chunk, want: string): number {
  const got = (c.question_no ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!got) return 0;
  if (got === want) return 2;
  if (got.startsWith(want) || want.startsWith(got)) return 1;
  return 0;
}

/** Pull in the other parts of the top hits' questions, de-duplicated. */
async function expandSiblings(db: SupabaseClient, hits: Chunk[]): Promise<Chunk[]> {
  const seeds = hits.slice(0, 3);
  const seen = new Set(hits.map((h) => h.id));
  const out = [...hits];
  for (const seed of seeds) {
    const { data } = await db.rpc("question_siblings", { p_chunk_id: seed.id });
    for (const sib of (data ?? []) as Chunk[]) {
      if (seen.has(sib.id)) continue;
      seen.add(sib.id);
      out.push({ ...sib, score: (seed.score ?? 0) * 0.5 });
    }
  }
  return out;
}

/** Fetch one question part plus every sibling, for the marking flow. */
export async function getQuestion(db: SupabaseClient, chunkId: string): Promise<Chunk[]> {
  const { data, error } = await db.rpc("question_siblings", { p_chunk_id: chunkId });
  if (error) throw new Error(`Question lookup failed: ${error.message}`);
  return (data ?? []) as Chunk[];
}

/* ----------------------------------------------------------- formatting -- */

export function label(c: Chunk): string {
  if (c.kind === "syllabus") {
    return `${c.subject_code} syllabus${c.topic ? ` — ${c.topic}` : ""}`;
  }
  const bits = [c.subject_code];
  if (c.session && c.year) bits.push(`${c.session} ${c.year}`);
  if (c.paper_no) bits.push(`P${c.paper_no}${c.variant ?? ""}`);
  if (c.question_no) bits.push(`Q${c.question_no}`);
  return bits.join(" ");
}

export function toCitation(c: Chunk): Citation {
  return {
    id: c.id,
    label: label(c),
    paperCode: c.paper_code,
    questionNo: c.question_no,
    marks: c.marks,
    topic: c.topic,
    kind: c.kind,
  };
}

/**
 * Render chunks as the numbered source block the prompts cite by index.
 * Highest score first, stopping at the character budget.
 */
export function packContext(chunks: Chunk[], budget = 24000): { text: string; used: Chunk[] } {
  const ordered = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const used: Chunk[] = [];
  const parts: string[] = [];
  let spent = 0;

  for (const c of ordered) {
    const block = renderChunk(c, used.length + 1);
    if (spent + block.length > budget && used.length > 0) break;
    parts.push(block);
    used.push(c);
    spent += block.length;
  }
  return { text: parts.join("\n\n"), used };
}

function renderChunk(c: Chunk, n: number): string {
  const head = `[${n}] ${label(c)}${c.marks ? ` — ${c.marks} mark${c.marks === 1 ? "" : "s"}` : ""}${c.topic ? ` — topic: ${c.topic}` : ""}`;
  const lines = [head];
  if (c.kind === "syllabus") {
    lines.push(`SYLLABUS: ${c.content.trim()}`);
  } else {
    lines.push(`QUESTION: ${c.content.trim()}`);
    if (c.ms_content) lines.push(`MARK SCHEME: ${c.ms_content.trim()}`);
    if (c.er_content) lines.push(`EXAMINER REPORT: ${c.er_content.trim()}`);
  }
  if (c.syllabus_refs?.length) lines.push(`SYLLABUS REFS: ${c.syllabus_refs.join(", ")}`);
  return lines.join("\n");
}
