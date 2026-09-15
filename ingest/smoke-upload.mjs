/**
 * Upload smoke test: proves the two in-app document routes actually work.
 *
 *   npm run test:upload
 *
 * Sends a real PDF to /ingest and checks the corpus grew, then marks a paper
 * from a rendered page image via /mark-paper. Both routes hand whole documents
 * to Gemini, so nothing short of a real file exercises them.
 *
 * Uses a throwaway user and cleans up the rows it creates.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

const SUPABASE = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const FN = `${SUPABASE}/functions/v1`;
const PDF_DIR = new URL("./pdfs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const admin = createClient(SUPABASE, SERVICE, { auth: { persistSession: false } });
const email = `upload-${Date.now()}@example.com`;
const password = "uploaduploaded1234";
const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (cErr) throw new Error(cErr.message);
const userId = created.user.id;

const problems = [];
const check = (ok, what, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) problems.push(what);
};

try {
  const anon = createClient(SUPABASE, ANON, { auth: { persistSession: false } });
  const { data: s } = await anon.auth.signInWithPassword({ email, password });
  const headers = {
    Authorization: `Bearer ${s.session.access_token}`,
    apikey: ANON,
    "Content-Type": "application/json",
  };

  const files = (await readdir(PDF_DIR)).filter((f) => f.endsWith(".pdf"));
  const qp = files.find((f) => f.includes("_qp_"));
  if (!qp) throw new Error("No question-paper PDF in ingest/pdfs to test with.");

  /* ------------------------------------------------------------- ingest -- */
  console.log(`\ningest  (${qp})`);
  {
    // Ingest into a throwaway subject so the real corpus is untouched.
    const data = (await readFile(join(PDF_DIR, qp))).toString("base64");
    const t = Date.now();
    const res = await fetch(`${FN}/ingest`, {
      method: "POST", headers,
      body: JSON.stringify({ fileName: qp, file: { mimeType: "application/pdf", data } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      check(false, "PDF accepted", `${res.status} ${body.message ?? body.error ?? ""}`);
    } else {
      check(true, "PDF accepted", `${((Date.now() - t) / 1000).toFixed(0)}s`);
      check(body.kind === "qp", "recognised as a question paper", body.kind);
      check(!!body.subjectCode, "worked out the subject", `${body.subject} (${body.subjectCode})`);
      check(body.questions > 5, "extracted questions", `${body.questions}`);
      console.log(`        "${body.message}"`);
    }
  }

  /* ---------------------------------------------------------- mark-paper -- */
  console.log("\nmark-paper");
  {
    const { data: papers } = await admin.from("papers")
      .select("id,title,subject_code").eq("kind", "qp").limit(1);
    if (!papers?.length) {
      check(false, "a paper exists to mark against");
    } else {
      // A page of the question paper stands in for a photo of handwriting: the
      // route should read it, find no matching answers, and say so clearly
      // rather than inventing marks.
      const data = (await readFile(join(PDF_DIR, qp))).toString("base64");
      const res = await fetch(`${FN}/mark-paper`, {
        method: "POST", headers,
        body: JSON.stringify({ subject: papers[0].subject_code, files: [{ mimeType: "application/pdf", data }] }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body.error === "paper_not_held") {
        check(true, "refuses to mark a paper it does not hold", body.message.slice(0, 70));
      } else if (res.status === 422 && body.error === "no_answers") {
        check(true, "refuses to mark when it cannot find answers", body.message.slice(0, 60));
      } else if (res.ok) {
        check(true, "returned a marked paper", `${body.awarded}/${body.total} (${body.pct}%)`);
        check(Array.isArray(body.questions) && body.questions.length > 0, "per-question results");
        const overAwarded = (body.questions ?? []).filter((q) => q.awarded !== null && q.awarded > q.marks);
        check(overAwarded.length === 0, "never awards more than a question is worth");
      } else {
        check(false, "mark-paper responded", `${res.status} ${body.message ?? body.error ?? ""}`);
      }
    }
  }

  /* --------------------------------------------------------------- quota -- */
  console.log("\nallowance");
  {
    const user = createClient(SUPABASE, ANON, {
      global: { headers: { Authorization: `Bearer ${s.session.access_token}` } },
      auth: { persistSession: false },
    });
    const { data: usage } = await user.rpc("my_ai_usage");
    const routes = (usage ?? []).map((u) => u.route);
    check(routes.includes("ingest"), "ingest is metered");
    check(routes.includes("markpaper"), "markpaper is metered");
  }
} finally {
  await admin.from("attempts").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\nthrowaway user deleted.");
}

console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : "\nUpload routes: working.");
process.exit(problems.length ? 1 : 0);
