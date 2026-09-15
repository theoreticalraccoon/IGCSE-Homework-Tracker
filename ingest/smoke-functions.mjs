/**
 * Smoke test for the DEPLOYED edge functions.
 *
 *   npm run test:functions        (from the repo root)
 *   node smoke-functions.mjs      (from ingest/)
 *
 * Creates a throwaway confirmed user, signs in as them, and exercises ask /
 * mark / mock over HTTP exactly as the browser does: same auth header, same
 * SSE parsing: then deletes the user again. Run it after every deploy: the
 * unit tests cannot catch a missing secret, a retired model, or an RLS policy
 * that blocks the service.
 *
 * Lives beside the ingestion package because it needs the same Supabase client
 * and the same .env. The service-role key is what lets it create and delete the
 * throwaway user.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const FN = `${URL}/functions/v1`;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const email = `markwise-check-${Date.now()}@example.com`;
const password = "markwise-check-1234";

console.log("creating a throwaway user…");
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email, password, email_confirm: true,
});
if (createErr) throw new Error(`could not create the test user: ${createErr.message}`);
const userId = created.user.id;

let failures = 0;
try {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: session, error: signErr } = await anon.auth.signInWithPassword({ email, password });
  if (signErr) throw new Error(`sign-in failed: ${signErr.message}`);
  const token = session.session.access_token;
  console.log("signed in\n");

  const headers = { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" };

  /* ---------------------------------------------------------------- ask -- */
  console.log("▸ ask  (streamed, grounded)");
  {
    const t = Date.now();
    const res = await fetch(`${FN}/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question: "How do I find the nth term of an arithmetic sequence? Show the marking points.",
        subject: "E-4MA1",
        mode: "technique",
      }),
    });
    if (!res.ok) {
      console.log(`   FAIL ${res.status}: ${(await res.text()).slice(0, 300)}`);
      failures++;
    } else {
      let citations = [], text = "", err = null, first = null;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
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
          if (ev === "delta") { if (first === null) first = Date.now() - t; text += d; }
          if (ev === "error") err = d.message;
        }
      }
      if (err) { console.log(`   FAIL generation: ${err}`); failures++; }
      else if (!text) { console.log("   FAIL: no text streamed"); failures++; }
      else {
        console.log(`   OK  ${citations.length} citations, ${text.length} chars, first token ${first}ms`);
        console.log(`   cited: ${citations.slice(0, 3).map((c) => c.label).join(" | ")}`);
        console.log(`   ${text.replace(/\s+/g, " ").slice(0, 200)}…`);
      }
    }
  }

  /* --------------------------------------------------------------- mark -- */
  console.log("\n▸ mark  (against the real scheme)");
  {
    const res = await fetch(`${FN}/mark`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question: "E-4MA1_s24_qp_13 Q1(a)",
        subject: "E-4MA1",
        answer: "3n - 2",
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.log(`   FAIL ${res.status}: ${body.message ?? body.error ?? ""}`); failures++; }
    else {
      console.log(`   OK  ${body.questionRef} → ${body.awarded}/${body.total} (${body.pct}%)`);
      for (const b of body.breakdown ?? []) console.log(`       ${b.earned ? "✓" : "✗"} ${String(b.point).replace(/\s+/g, " ").slice(0, 70)}`);
      console.log(`   feedback: ${String(body.feedback ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
      if (!String(body.questionRef ?? "").includes("Q1(a)")) { console.log("   FAIL: marked the wrong question"); failures++; }
    }
  }

  /* --------------------------------------------------------------- mock -- */
  console.log("\n▸ mock  (assembled from real questions)");
  {
    const res = await fetch(`${FN}/mock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "E-4MA1", marks: 40 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.log(`   FAIL ${res.status}: ${body.message ?? body.error ?? ""}`); failures++; }
    else {
      console.log(`   OK  "${body.title}": ${body.totalMarks} marks, ${body.durationMin} min, ${body.questions?.length} questions`);
      for (const q of (body.questions ?? []).slice(0, 3)) {
        console.log(`       ${q.n}. [${q.marks}] ${q.paperRef}: ${String(q.text).replace(/\s+/g, " ").slice(0, 60)}`);
      }
      const invented = (body.questions ?? []).filter((q) => !q.chunkId);
      if (invented.length) { console.log(`   FAIL: ${invented.length} question(s) not from the corpus`); failures++; }
    }
  }

  /* -------------------------------------------------------------- quota -- */
  console.log("\n▸ usage accounting");
  {
    const { data } = await anon.auth.getSession();
    const user = createClient(URL, ANON, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      auth: { persistSession: false },
    });
    const { data: usage, error } = await user.rpc("my_ai_usage");
    if (error) { console.log(`   FAIL ${error.message}`); failures++; }
    else console.log("   " + usage.map((u) => `${u.route} ${u.used}/${u.per_day}`).join("  ·  "));
  }
} finally {
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\nthrowaway user deleted.");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nGate B: all routes working.");
process.exit(failures ? 1 : 0);
