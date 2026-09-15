/**
 * Every table read and write the app makes.
 *
 * Kept in one module so the data contract is auditable in one place; RLS means
 * none of these can touch another user's rows even if a bug asked them to.
 */

import { sb } from "./client.js";
import { store } from "../store.js";

const fail = (what, error) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

/* -------------------------------------------------------------- catalogue -- */

export async function loadCatalogue() {
  const [subjects, coverage] = await Promise.all([
    sb.from("subjects").select("code,name,board,level,corpus_code").eq("active", true).order("name"),
    sb.from("corpus_coverage").select("*"),
  ]);
  fail("Could not load subjects", subjects.error);
  store.subjects = subjects.data ?? [];
  // Coverage is a nicety. A missing view must not block sign-in.
  store.coverage = coverage.error ? [] : (coverage.data ?? []);
  return store.subjects;
}

/* ---------------------------------------------------------------- profile -- */

export async function loadProfile(userId) {
  const { data, error } = await sb
    .from("profiles")
    .select("subjects,onboarded,prefs,exam_session,board,display_name")
    .eq("id", userId)
    .maybeSingle();
  fail("Could not load your profile", error);

  store.profile = data ?? null;
  store.mySubjects = data?.subjects ?? [];
  if (data?.prefs && typeof data.prefs === "object") {
    Object.assign(store.prefs, data.prefs);
  }
  return data;
}

export async function saveProfile(patch) {
  const { error } = await sb.from("profiles").upsert({
    id: store.user.id,
    ...patch,
    onboarded: true,
    updated_at: new Date().toISOString(),
  });
  fail("Could not save your profile", error);
  if (patch.subjects) store.mySubjects = patch.subjects;
  store.profile = { ...(store.profile ?? {}), ...patch };
}

let prefsTimer = null;
/** Debounced, because tab switches and toggles fire fast. */
export function syncPrefs() {
  if (!store.user) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(async () => {
    const { source, hideEmpty, plannerView, lastSubject } = store.prefs;
    await sb
      .from("profiles")
      .update({ prefs: { source, hideEmpty, plannerView, lastSubject }, updated_at: new Date().toISOString() })
      .eq("id", store.user.id);
  }, 600);
}

/* ------------------------------------------------------------------ tasks -- */

const TASK_FIELDS =
  "id,subject,type,source,text,notes,due,due_time,done,done_at,priority,topic,estimate_min,created,origin,origin_ref";

export async function loadTasks() {
  const { data, error } = await sb.from("tasks").select(TASK_FIELDS).order("due", { nullsFirst: false });
  fail("Could not load your tasks", error);
  store.tasks = data ?? [];
  return store.tasks;
}

export async function createTask(fields) {
  const row = {
    subject: fields.subject,
    type: fields.type ?? "homework",
    source: fields.source ?? "school",
    text: fields.text,
    notes: fields.notes ?? null,
    due: fields.due || null,
    due_time: fields.dueTime || null,
    priority: fields.priority ?? 1,
    topic: fields.topic ?? null,
    estimate_min: fields.estimateMin ?? null,
    origin: fields.origin ?? "manual",
    origin_ref: fields.originRef ?? null,
    done: false,
    created: Date.now(),
  };
  const { data, error } = await sb.from("tasks").insert(row).select(TASK_FIELDS).single();
  fail("Could not save that task", error);
  store.tasks.push(data);
  return data;
}

export async function updateTask(id, patch) {
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select(TASK_FIELDS).single();
  fail("Could not update that task", error);
  const i = store.tasks.findIndex((t) => t.id === id);
  if (i >= 0) store.tasks[i] = data;
  return data;
}

export async function setTaskDone(id, done) {
  return updateTask(id, { done, done_at: done ? new Date().toISOString() : null });
}

export async function deleteTask(id) {
  const { error } = await sb.from("tasks").delete().eq("id", id);
  fail("Could not delete that task", error);
  store.tasks = store.tasks.filter((t) => t.id !== id);
}

export async function clearCompleted(source) {
  const doomed = store.tasks.filter((t) => t.done && (!source || t.source === source));
  if (!doomed.length) return 0;
  const { error } = await sb.from("tasks").delete().in("id", doomed.map((t) => t.id));
  fail("Could not clear completed tasks", error);
  const gone = new Set(doomed.map((t) => t.id));
  store.tasks = store.tasks.filter((t) => !gone.has(t.id));
  return doomed.length;
}

/* --------------------------------------------------------------- tuition -- */

export async function loadTuition() {
  const { data, error } = await sb
    .from("tuition_sessions")
    .select("id,subject,tutor,weekday,start_time,end_time,location,active")
    .eq("active", true)
    .order("weekday")
    .order("start_time");
  fail("Could not load your tuition timetable", error);
  store.tuition = data ?? [];
  return store.tuition;
}

export async function createTuition(row) {
  const { data, error } = await sb.from("tuition_sessions").insert(row).select("*").single();
  fail("Could not save that session", error);
  store.tuition.push(data);
  return data;
}

export async function deleteTuition(id) {
  const { error } = await sb.from("tuition_sessions").delete().eq("id", id);
  fail("Could not remove that session", error);
  store.tuition = store.tuition.filter((t) => t.id !== id);
}

/* ---------------------------------------------------------------- corpus -- */

const CHUNK_FIELDS =
  "id,subject_code,kind,paper_code,year,session,paper_no,variant,question_no," +
  "question_root,marks,command_word,topic,syllabus_refs,content,ms_content,er_content,page";

export async function searchLibrary({ subject, query = "", topic = null, limit = 30, offset = 0 }) {
  let q = sb
    .from("chunks")
    .select("id,paper_code,year,session,paper_no,variant,question_no,marks,topic,command_word,content,ms_content", {
      count: "exact",
    })
    .eq("kind", "question")
    .order("year", { ascending: false })
    .range(offset, offset + limit - 1);

  if (subject) q = q.eq("subject_code", subject);
  if (topic) q = q.eq("topic", topic);
  // Keyword search only: semantic search costs a Gemini call, so it belongs
  // to Ask, not to browsing.
  if (query.trim()) q = q.textSearch("fts", query.trim(), { type: "websearch" });

  const { data, error, count } = await q;
  fail("Search failed", error);
  return { rows: data ?? [], total: count ?? 0 };
}

export async function getChunk(id) {
  // Explicit columns: select("*") would ship the 768-float embedding too.
  const { data, error } = await sb
    .from("chunks")
    .select(CHUNK_FIELDS)
    .eq("id", id)
    .maybeSingle();
  fail("Could not load that question", error);
  return data;
}

/** Question papers for a subject that actually have questions stored. */
export async function listPapers(subject) {
  const { data, error } = await sb
    .from("papers")
    .select("id,title,code,year,session,paper_no,variant,kind")
    .eq("subject_code", subject)
    .eq("kind", "qp")
    .order("year", { ascending: false })
    .order("paper_no");
  fail("Could not load papers", error);
  return data ?? [];
}

export async function subjectTopics(subject) {
  const { data, error } = await sb.rpc("subject_topics", { p_subject: subject });
  fail("Could not load topics", error);
  return data ?? [];
}

export async function similarQuestions(chunkId, limit = 6) {
  const { data, error } = await sb.rpc("similar_chunks", { p_chunk_id: chunkId, p_limit: limit });
  fail("Could not find similar questions", error);
  return data ?? [];
}

/* --------------------------------------------------------------- progress -- */

export async function loadAttempts({ subject = null, limit = 100 } = {}) {
  let q = sb
    .from("attempts")
    .select("id,subject_code,question_ref,awarded,total,topic,created_at,missed,mock_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (subject) q = q.eq("subject_code", subject);
  const { data, error } = await q;
  fail("Could not load your attempts", error);
  return data ?? [];
}

export async function getAttempt(id) {
  const { data, error } = await sb.from("attempts").select("*").eq("id", id).maybeSingle();
  fail("Could not load that attempt", error);
  return data;
}

export async function loadMastery(subject = null) {
  let q = sb.from("topic_mastery").select("subject_code,topic,attempts,marks_awarded,marks_total");
  if (subject) q = q.eq("subject_code", subject);
  const { data, error } = await q;
  fail("Could not load your topic mastery", error);
  return data ?? [];
}

export async function weakTopics(subject = null, limit = 8) {
  const { data, error } = await sb.rpc("weak_topics", { p_subject: subject, p_limit: limit });
  fail("Could not work out your weak topics", error);
  return data ?? [];
}

export async function predictGrade(subject, paperNo, pct) {
  const { data, error } = await sb.rpc("predict_grade", {
    p_subject: subject,
    p_paper_no: paperNo,
    p_pct: pct,
  });
  if (error) return null; // no boundaries ingested. Not an error worth showing
  return data ?? null;
}

/* ------------------------------------------------------------------ mocks -- */

export async function loadMocks(limit = 30) {
  const { data, error } = await sb
    .from("mocks")
    .select("id,subject_code,title,total_marks,duration_min,status,awarded,grade,created_at,submitted_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  fail("Could not load your mocks", error);
  return data ?? [];
}

export async function getMock(id) {
  const { data, error } = await sb.from("mocks").select("*").eq("id", id).maybeSingle();
  fail("Could not load that mock", error);
  return data;
}

export async function updateMock(id, patch) {
  const { data, error } = await sb.from("mocks").update(patch).eq("id", id).select("*").single();
  fail("Could not update that mock", error);
  return data;
}

export async function deleteMock(id) {
  const { error } = await sb.from("mocks").delete().eq("id", id);
  fail("Could not delete that mock", error);
}

/* ------------------------------------------------------------------ chat -- */

export async function loadThreads(limit = 30) {
  const { data, error } = await sb
    .from("chat_threads")
    .select("id,title,mode,subject_code,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  fail("Could not load your chats", error);
  return data ?? [];
}

export async function createThread({ title, mode = "ask", subject = null }) {
  const { data, error } = await sb
    .from("chat_threads")
    .insert({ title: title.slice(0, 80), mode, subject_code: subject })
    .select("id,title,mode,subject_code")
    .single();
  fail("Could not start that chat", error);
  return data;
}

export async function loadMessages(threadId) {
  const { data, error } = await sb
    .from("chat_messages")
    .select("id,role,content,citations,created_at")
    .eq("thread_id", threadId)
    .order("created_at");
  fail("Could not load that chat", error);
  return data ?? [];
}

export async function deleteThread(id) {
  const { error } = await sb.from("chat_threads").delete().eq("id", id);
  fail("Could not delete that chat", error);
}

/* ----------------------------------------------------------------- usage -- */

export async function loadUsage() {
  const { data, error } = await sb.rpc("my_ai_usage");
  if (error) return [];
  store.usage = data ?? [];
  return store.usage;
}
