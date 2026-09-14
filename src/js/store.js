/**
 * Application state.
 *
 * A single observable object rather than a framework: the app is small enough
 * that views re-render themselves on the events they care about, and the
 * absence of a build step is worth more here than reactivity.
 */

import { STORAGE } from "./config.js";

const listeners = new Map(); // event -> Set<fn>

export const store = {
  user: null,
  profile: null,          // { subjects, exam_session, board, display_name, prefs }
  subjects: [],           // catalogue rows: { code, name, board, level }
  mySubjects: [],         // codes the user takes
  tasks: [],
  tuition: [],
  coverage: [],           // corpus_coverage rows
  usage: [],              // my_ai_usage rows
  prefs: {
    source: "school",
    hideEmpty: false,
    lastSubject: null,
    plannerView: "board",
  },
  ready: false,
};

export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`listener for "${event}" failed`, e);
    }
  }
}

export function subscribe(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

/* ----------------------------------------------------------------- prefs -- */

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE.prefs);
    if (raw) Object.assign(store.prefs, JSON.parse(raw));
  } catch {
    /* a blocked or full localStorage must not stop the app */
  }
}

export function savePrefs(patch = {}) {
  Object.assign(store.prefs, patch);
  try {
    localStorage.setItem(STORAGE.prefs, JSON.stringify(store.prefs));
  } catch {
    /* ignore */
  }
  emit("prefs", store.prefs);
}

/* -------------------------------------------------------------- lookups -- */

export function subjectName(code) {
  return store.subjects.find((s) => s.code === code)?.name ?? code ?? "";
}

/**
 * Which subject's papers a course is answered from.
 *
 * A school's "Extra Maths" or "Single Science Physics" class has no syllabus
 * of its own, but the questions its students need are 0580's and 0625's. The
 * planner keeps the course separate; retrieval follows the pointer. Anything
 * sent to the corpus — search, ask, mark, mock — must go through this.
 */
export function corpusCode(code) {
  const row = store.subjects.find((s) => s.code === code);
  return row?.corpus_code || code;
}

/** The subjects a student takes, in catalogue order, as full rows. */
export function mySubjectRows() {
  const mine = new Set(store.mySubjects);
  return store.subjects.filter((s) => mine.has(s.code));
}

/** Corpus coverage for one subject, or null when nothing is ingested. */
export function coverageFor(code) {
  const row = store.coverage.find((c) => c.subject_code === code);
  return row && row.questions > 0 ? row : null;
}

/** Subjects the AI can actually ground answers in. */
export function groundedSubjects() {
  return mySubjectRows().filter((s) => coverageFor(s.code));
}

export function reset() {
  store.user = null;
  store.profile = null;
  store.mySubjects = [];
  store.tasks = [];
  store.tuition = [];
  store.usage = [];
  store.ready = false;
}
