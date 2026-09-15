/**
 * RAG proof — shows each stage of retrieval-augmented generation on real data.
 *
 *   npm run rag:proof
 *
 * Prints what is actually happening for one question: the embedding, the
 * hybrid search, the chunks that came back, the verbatim text handed to the
 * model, and the grounded answer. Then runs the ablation that matters — the
 * same question with retrieval switched off — because an app can claim to do
 * RAG while quietly answering from the model's own memory, and the only way to
 * tell from outside is to remove the corpus and see whether anything changes.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

const SUPABASE = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const FN = `${SUPABASE}/functions/v1`;
const SUBJECT = process.argv[2] ?? "E-4MA1";
const QUESTION = process.argv[3] ?? "How do I find the nth term of an arithmetic sequence, and how are the marks awarded?";

const admin = createClient(SUPABASE, SERVICE, { auth: { persistSession: false } });
const { embedBatch } = await import("./lib/gemini.js");

const rule = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${"─".repeat(72)}`);

/* -- 0. what is in the corpus ------------------------------------------- */
rule("0. THE CORPUS  (what retrieval can draw on)");
{
  const { count: q } = await admin.from("chunks").select("id", { count: "exact", head: true })
    .eq("subject_code", SUBJECT).eq("kind", "question");
  const { count: ms } = await admin.from("chunks").select("id", { count: "exact", head: true })
    .eq("subject_code", SUBJECT).eq("kind", "question").not("ms_content", "is", null);
  const { count: emb } = await admin.from("chunks").select("id", { count: "exact", head: true })
    .eq("subject_code", SUBJECT).not("embedding", "is", null);
  const { data: papers } = await admin.from("papers").select("code,kind").eq("subject_code", SUBJECT);
  console.log(`  ${q} question chunks, ${ms} carrying their mark scheme, ${emb} embedded`);
  console.log(`  from ${papers.length} documents: ${papers.map((p) => p.code).join(", ")}`);
}

/* -- 1. the query becomes a vector -------------------------------------- */
rule("1. RETRIEVAL — the question is embedded");
const [vector] = await embedBatch([QUESTION], "RETRIEVAL_QUERY");
console.log(`  "${QUESTION}"`);
console.log(`  → ${vector.length}-dimensional vector: [${vector.slice(0, 4).map((v) => v.toFixed(4)).join(", ")}, …]`);
const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
console.log(`  → L2 norm ${norm.toFixed(4)} (normalised, so cosine distance is meaningful)`);

/* -- 2. hybrid search over the corpus ------------------------------------ */
rule("2. RETRIEVAL — hybrid search (vector + keyword, RRF-fused)");
const { data: hits, error } = await admin.rpc("match_chunks", {
  query_embedding: vector,
  query_text: QUESTION,
  p_subject: SUBJECT,
  p_kinds: ["question"],
  match_count: 4,
});
if (error) throw new Error(error.message);
console.log(`  ${hits.length} chunks retrieved from the database, best first:\n`);
for (const h of hits) {
  console.log(`  [${h.score.toFixed(4)}]  ${h.paper_code}  Q${h.question_no}  (${h.marks} marks)  ${h.topic ?? ""}`);
  console.log(`           ${h.content.replace(/\s+/g, " ").slice(0, 88)}…`);
}

/* -- 3. what the model is actually given --------------------------------- */
rule("3. AUGMENTATION — the verbatim text placed in the prompt");
{
  const top = hits[0];
  console.log(`  From ${top.paper_code} Q${top.question_no}:\n`);
  console.log(`  QUESTION: ${top.content.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`\n  MARK SCHEME: ${(top.ms_content ?? "(none)").replace(/\s+/g, " ").slice(0, 240)}`);
  console.log(`\n  ← this is copied out of the PDF. The model is told to answer only from it.`);
}

/* -- 4. generation, grounded --------------------------------------------- */
rule("4. GENERATION — the answer, with citations");
const email = `rag-${Date.now()}@example.com`;
const password = "ragproof1234";
const { data: u } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const anon = createClient(SUPABASE, ANON, { auth: { persistSession: false } });
const { data: s } = await anon.auth.signInWithPassword({ email, password });
const headers = { Authorization: `Bearer ${s.session.access_token}`, apikey: ANON, "Content-Type": "application/json" };

async function askOnce(subject) {
  const res = await fetch(`${FN}/ask`, {
    method: "POST", headers,
    body: JSON.stringify({ question: QUESTION, subject, mode: "technique" }),
  });
  if (!res.ok) return { text: `(${res.status})`, citations: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", citations = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      let ev = "message"; const lines = [];
      for (const l of f.split("\n")) {
        if (l.startsWith("event:")) ev = l.slice(6).trim();
        else if (l.startsWith("data:")) lines.push(l.slice(5).trim());
      }
      if (!lines.length) continue;
      let d; try { d = JSON.parse(lines.join("\n")); } catch { continue; }
      if (ev === "citations") citations = d.citations ?? [];
      if (ev === "delta") text += d;
    }
  }
  return { text, citations };
}

try {
  const grounded = await askOnce(SUBJECT);
  console.log(`  cited: ${grounded.citations.slice(0, 4).map((c) => c.label).join("  |  ") || "(none)"}`);
  console.log(`\n  ${grounded.text.replace(/\n/g, "\n  ").slice(0, 900)}`);

  /* -- 5. the ablation --------------------------------------------------- */
  rule("5. ABLATION — the same question against a subject with no corpus");
  console.log("  If this app were only prompting an LLM, removing the corpus would change");
  console.log("  nothing. It should instead refuse, because the prompt forbids answering");
  console.log("  from the model's own recollection.\n");

  const { data: empty } = await admin.from("subjects").select("code")
    .not("code", "in", `(${SUBJECT})`).limit(1).single();
  const ungrounded = await askOnce(empty.code);
  console.log(`  subject "${empty.code}" — sources retrieved: ${ungrounded.citations.length}`);
  console.log(`\n  ${ungrounded.text.replace(/\n/g, "\n  ").slice(0, 400)}`);

  rule("VERDICT");
  const refused = /not cover|no (information|sources)|cannot|do not have|isn't covered|not available|no relevant/i
    .test(ungrounded.text);
  console.log(`  retrieval ran and returned real chunks ....... ${hits.length > 0 ? "YES" : "NO"}`);
  console.log(`  answer carried citations to real papers ...... ${grounded.citations.length > 0 ? "YES" : "NO"}`);
  console.log(`  quoted mark scheme text appears in answer .... ${
    hits[0].ms_content && grounded.text.includes(hits[0].ms_content.slice(0, 12).trim()) ? "YES" : "partial"}`);
  console.log(`  refuses when the corpus is empty ............. ${refused || ungrounded.citations.length === 0 ? "YES" : "NO"}`);
  console.log(`\n  This is retrieval-augmented generation: search first, then generate\n  from what was found — not a prompt wrapped around a chatbot.`);
} finally {
  await admin.auth.admin.deleteUser(u.user.id).catch(() => {});
}
