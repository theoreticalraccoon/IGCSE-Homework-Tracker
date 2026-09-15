/**
 * Security smoke test: proves row-level security actually holds.
 *
 *   npm run test:security
 *
 * Creates two users, has each write data, and then tries every way one could
 * reach the other's rows. RLS is the only thing standing between students on a
 * shared deployment, and a policy that silently fails open looks exactly like
 * a policy that works until someone checks.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const problems = [];
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) problems.push(what);
};

async function makeUser(tag) {
  const email = `markwise-sec-${tag}-${Date.now()}@example.com`;
  const password = "markwise-sec-1234";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr) throw new Error(signErr.message);
  return { id: data.user.id, client };
}

const alice = await makeUser("a");
const bob = await makeUser("b");

try {
  // --- each writes something private -------------------------------------
  const { data: aliceTask, error: taskErr } = await alice.client.from("tasks").insert({
    subject: "E-4MA1", type: "homework", source: "school",
    text: "alice private homework", created: Date.now(),
  }).select("id").single();
  if (taskErr) throw new Error(`alice could not create a task: ${taskErr.message}`);

  await alice.client.from("attempts").insert({
    subject_code: "E-4MA1", question_ref: "alice private attempt",
    answer_text: "secret", awarded: 1, total: 2,
  });

  console.log("\nrow-level security");

  // --- reads --------------------------------------------------------------
  const { data: bobSeesTasks } = await bob.client.from("tasks").select("id,text");
  check(!(bobSeesTasks ?? []).some((t) => t.text === "alice private homework"),
    "bob cannot read alice's tasks");

  const { data: bobSeesAttempts } = await bob.client.from("attempts").select("id,question_ref");
  check(!(bobSeesAttempts ?? []).some((a) => a.question_ref === "alice private attempt"),
    "bob cannot read alice's marked answers");

  const { data: byId } = await bob.client.from("tasks").select("id").eq("id", aliceTask.id);
  check((byId ?? []).length === 0, "bob cannot read alice's task by its exact id");

  const { data: bobProfiles } = await bob.client.from("profiles").select("id");
  check((bobProfiles ?? []).every((p) => p.id === bob.id), "bob cannot read other profiles");

  // --- writes -------------------------------------------------------------
  const { data: updated } = await bob.client.from("tasks")
    .update({ text: "hijacked" }).eq("id", aliceTask.id).select("id");
  check((updated ?? []).length === 0, "bob cannot update alice's task");

  const { data: deleted } = await bob.client.from("tasks")
    .delete().eq("id", aliceTask.id).select("id");
  check((deleted ?? []).length === 0, "bob cannot delete alice's task");

  const { error: forgeErr } = await bob.client.from("tasks").insert({
    user_id: alice.id, subject: "E-4MA1", type: "homework",
    source: "school", text: "forged", created: Date.now(),
  });
  check(!!forgeErr, "bob cannot insert a row owned by alice");

  // --- the corpus is shared on purpose ------------------------------------
  console.log("\ncorpus access");
  const { data: chunks } = await bob.client.from("chunks").select("id").limit(1);
  check((chunks ?? []).length === 1, "any signed-in user can read the corpus");

  const { error: writeCorpus } = await bob.client.from("chunks").insert({
    paper_id: "00000000-0000-0000-0000-000000000000",
    subject_code: "E-4MA1", kind: "question", content: "injected",
  });
  check(!!writeCorpus, "a signed-in user cannot write to the corpus");

  const { error: writeSubject } = await bob.client.from("subjects")
    .insert({ code: "HACK", name: "hack" });
  check(!!writeSubject, "a signed-in user cannot add subjects");

  // --- quota cannot be self-served ----------------------------------------
  console.log("\nquota integrity");
  const { error: claimErr } = await bob.client.rpc("claim_ai_call", { p_user: bob.id, p_route: "ask" });
  check(!!claimErr, "a signed-in user cannot call claim_ai_call directly");

  const { error: usageWrite } = await bob.client.from("ai_usage")
    .insert({ user_id: bob.id, route: "ask" });
  check(!!usageWrite, "a signed-in user cannot forge usage rows");

  const { data: bobUsage } = await bob.client.from("ai_usage").select("id").eq("user_id", alice.id);
  check((bobUsage ?? []).length === 0, "bob cannot read alice's usage");

  // --- anonymous ----------------------------------------------------------
  console.log("\nanonymous access");
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: anonTasks } = await anon.from("tasks").select("id").limit(1);
  check((anonTasks ?? []).length === 0, "a signed-out visitor reads no tasks");
  const { data: anonChunks } = await anon.from("chunks").select("id").limit(1);
  check((anonChunks ?? []).length === 0, "a signed-out visitor reads no corpus");
} finally {
  await admin.from("tasks").delete().in("user_id", [alice.id, bob.id]);
  await admin.from("attempts").delete().in("user_id", [alice.id, bob.id]);
  await admin.auth.admin.deleteUser(alice.id).catch(() => {});
  await admin.auth.admin.deleteUser(bob.id).catch(() => {});
  console.log("\nthrowaway users deleted.");
}

if (problems.length) {
  console.log(`\n${problems.length} SECURITY PROBLEM(S). These are not cosmetic.`);
  process.exit(1);
}
console.log("\nSecurity: row-level security holds on every path tested.");
