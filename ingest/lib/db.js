/**
 * Database writes for the ingestion pipeline.
 *
 * Uses the service-role key, so RLS does not apply. This is the only place in
 * the project that writes to the corpus tables.
 */

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SERVICE_KEY } from "./config.js";

export const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function getSubject(code) {
  const { data } = await db.from("subjects").select("code,name,board").eq("code", code).maybeSingle();
  return data;
}

/**
 * The board a code belongs to, read from its prefix. Cambridge codes are bare
 * digits; everyone else is prefixed so the two never collide.
 */
const BOARD_PREFIX = { "E-": "Edexcel", "A-": "AQA", "O-": "OCR", "X-": "School" };

function boardFor(code) {
  for (const [prefix, board] of Object.entries(BOARD_PREFIX)) {
    if (code.toUpperCase().startsWith(prefix)) return board;
  }
  return /^\d{4}$/.test(code) ? "Cambridge" : "Other";
}

/**
 * Ensure a subject row exists so papers can reference it.
 *
 * Auto-created rows are named after their code, which is ugly in the UI: the
 * caller is told so it can suggest a proper name.
 */
export async function ensureSubject(code, name = null) {
  const existing = await getSubject(code);
  if (existing) return existing;
  const { data, error } = await db
    .from("subjects")
    .insert({ code, name: name ?? code, board: boardFor(code) })
    .select("code,name,board")
    .single();
  if (error) throw new Error(`Could not create subject ${code}: ${error.message}`);
  console.warn(`  ! created subject "${code}" (board: ${boardFor(code)}). Give it a real name:`);
  console.warn(`    update public.subjects set name = 'Your Subject Name' where code = '${code}';`);
  return data;
}

/**
 * Upsert a paper row. Returns { paper, unchanged }. Unchanged is true when the
 * same file (by sha256) is already ingested, letting the caller skip the
 * expensive parse-and-embed entirely.
 */
export async function upsertPaper(meta, { title, sha256, pages, sourceUrl = null }) {
  const { data: existing } = await db
    .from("papers")
    .select("id,sha256")
    .eq("subject_code", meta.subjectCode)
    .eq("kind", meta.kind)
    .eq("year", meta.year)
    .eq("session", meta.session)
    .eq("paper_no", meta.paperNo)
    .eq("variant", meta.variant)
    .maybeSingle();

  if (existing && existing.sha256 === sha256) {
    return { paper: existing, unchanged: true };
  }

  const row = {
    subject_code: meta.subjectCode,
    kind: meta.kind,
    year: meta.year,
    session: meta.session,
    paper_no: meta.paperNo,
    variant: meta.variant,
    title,
    code: meta.code,
    source_url: sourceUrl,
    pages,
    sha256,
    ingested_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await db.from("papers").update(row).eq("id", existing.id).select("id").single();
    if (error) throw new Error(`Paper update failed: ${error.message}`);
    // Content changed: drop the old chunks so we never serve a stale mix.
    await db.from("chunks").delete().eq("paper_id", existing.id);
    return { paper: data, unchanged: false };
  }

  const { data, error } = await db.from("papers").insert(row).select("id").single();
  if (error) throw new Error(`Paper insert failed: ${error.message}`);
  return { paper: data, unchanged: false };
}

/** Insert chunks in batches small enough to stay under the request size cap. */
export async function insertChunks(rows, batch = 100) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const { error } = await db.from("chunks").insert(slice);
    if (error) throw new Error(`Chunk insert failed: ${error.message}`);
    written += slice.length;
  }
  return written;
}

export async function coverage() {
  const { data, error } = await db.from("corpus_coverage").select("*").order("questions", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Chunks that were written before embedding succeeded, for `reembed`. */
export async function chunksMissingEmbedding(subjectCode, limit = 500) {
  let q = db.from("chunks").select("id,content,ms_content,topic,question_no").is("embedding", null).limit(limit);
  if (subjectCode) q = q.eq("subject_code", subjectCode);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setEmbedding(id, embedding) {
  const { error } = await db.from("chunks").update({ embedding }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function upsertGradeBoundaries(rows) {
  if (!rows.length) return 0;
  const { error } = await db
    .from("grade_boundaries")
    .upsert(rows, { onConflict: "subject_code,year,session,paper_no,grade" });
  if (error) throw new Error(`Grade boundary upsert failed: ${error.message}`);
  return rows.length;
}
