/**
 * Mock exams — generate, sit under timer, submit, get marked.
 *
 * Three states in one route:
 *   #/mock            the list, and the generator
 *   #/mock/<id>       sitting the paper
 *   #/mock/<id>/marked   the marked result
 *
 * Answers are held in localStorage while the paper is being written, so a
 * closed tab or a dead battery does not destroy an hour of work before it has
 * been submitted.
 */

import { esc, escLines, on } from "../ui/dom.js";
import { toast, emptyState, spinner, confirmModal, skeleton } from "../ui/feedback.js";
import { groundedSubjects, subjectName, corpusCode } from "../store.js";
import { loadMocks, getMock, updateMock, deleteMock, predictGrade } from "../api/data.js";
import { generateMock, markAnswer, explainError } from "../api/ai.js";
import { formatDateTime, minutesToHuman } from "../lib/dates.js";
import { navigate } from "../router.js";

let root = null;
let timer = null;

/** One paper's worth of practice: long enough to be useful, short enough to sit. */
const DEFAULT_MARKS = 40;

const draftKey = (id) => `markwise-mock-${id}`;

export async function render(container, { segments = [] } = {}) {
  root = container;
  stopTimer();

  if (segments.length === 0) return renderList();
  if (segments[1] === "marked") return renderMarked(segments[0]);
  return renderSit(segments[0]);
}

/* ------------------------------------------------------------------ list -- */

async function renderList() {
  root.innerHTML = `
    <header class="view-head">
      <div>
        <h1>Mock exams</h1>
        <p class="view-sub">A practice paper made from real past questions, marked when you finish.</p>
      </div>
    </header>
    <div id="generator"></div>
    <h2 class="section-title">Papers you have made</h2>
    <div id="mockList">${skeleton(3)}</div>`;

  paintGenerator();

  try {
    const mocks = await loadMocks();
    // A slow load can finish after the student has already moved to another
    // screen, by which point the element it was going to fill is gone.
    const list = root.querySelector("#mockList");
    if (!list) return;
    list.innerHTML = mocks.length
      ? `<div class="mock-list">${mocks.map(mockCard).join("")}</div>`
      : emptyState({
          icon: "📝",
          title: "No papers yet",
          message: "Make one above and sit it whenever you like.",
        });
  } catch (e) {
    const list = root.querySelector("#mockList");
    if (list) list.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }

  on(root, "click", "[data-open-mock]", (_, btn) => {
    const { openMock, status } = btn.dataset;
    navigate(status === "marked" ? `mock/${openMock}/marked` : `mock/${openMock}`);
  });

  on(root, "click", "[data-del-mock]", async (_, btn) => {
    const ok = await confirmModal({
      title: "Delete this mock",
      message: "The paper and your answers will be removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMock(btn.dataset.delMock);
      localStorage.removeItem(draftKey(btn.dataset.delMock));
      renderList();
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

function mockCard(m) {
  const pct = m.awarded != null && m.total_marks ? Math.round((m.awarded / m.total_marks) * 100) : null;
  return `
    <article class="mock-card">
      <button class="mock-open" data-open-mock="${esc(m.id)}" data-status="${esc(m.status)}">
        <span class="mock-title">${esc(m.title)}</span>
        <span class="mock-meta">
          ${esc(subjectName(m.subject_code))} · ${m.total_marks} marks
          ${m.duration_min ? ` · ${minutesToHuman(m.duration_min)}` : ""}
          · ${formatDateTime(m.created_at)}
        </span>
      </button>
      <span class="mock-status ${esc(m.status)}">
        ${m.status === "marked" ? `${m.awarded}/${m.total_marks}${pct !== null ? ` · ${pct}%` : ""}${m.grade ? ` · ${esc(m.grade)}` : ""}` :
          m.status === "in_progress" ? "In progress" : "Ready"}
      </span>
      <button class="icon-btn" data-del-mock="${esc(m.id)}" aria-label="Delete mock">&times;</button>
    </article>`;
}

/* ------------------------------------------------------------- generator -- */

function paintGenerator() {
  const grounded = groundedSubjects();
  const slot = root.querySelector("#generator");
  // Gone already: the student navigated away before this ran.
  if (!slot) return;

  if (!grounded.length) {
    slot.innerHTML = emptyState({
      icon: "📥",
      title: "No papers added yet",
      message: "Mock papers are built from the past papers you have added, so add a few first.",
    });
    return;
  }

  // Subject is the only decision. Everything else — how many marks, how long,
  // which topics — has a sensible answer the student should not have to make
  // up before they can practise.
  slot.innerHTML = `
    <section class="card plain generator">
      <div class="gen-row">
        <label class="field">
          <span>Subject</span>
          <select id="genSubject">
            ${grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}
          </select>
        </label>
        <button class="btn-primary big" id="genBtn">Make a paper</button>
      </div>
      <p class="gen-note muted" id="genNote">
        Around ${DEFAULT_MARKS} marks of real past questions, weighted towards whatever
        you have been losing marks on.
      </p>
    </section>`;

  const subjectSel = slot.querySelector("#genSubject");

  slot.querySelector("#genBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Making it…";
    const note = slot.querySelector("#genNote");
    if (note) note.textContent = "Choosing real questions for you…";
    try {
      const mock = await generateMock({
        subject: corpusCode(subjectSel.value),
        marks: DEFAULT_MARKS,
        weakFirst: true,
      });
      navigate(`mock/${mock.id}`);
    } catch (err) {
      toast(explainError(err) ?? "Could not generate that paper.", "error");
      btn.disabled = false;
      btn.textContent = "Make a paper";
      if (note) note.textContent = "";
    }
  });
}

/* ------------------------------------------------------------------- sit -- */

async function renderSit(id) {
  root.innerHTML = spinner("Loading your paper…");

  let mock;
  try {
    mock = await getMock(id);
    if (!mock) throw new Error("That mock no longer exists.");
  } catch (e) {
    root.innerHTML = `<div class="empty error"><h3>Not found</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  if (mock.status === "marked") {
    navigate(`mock/${id}/marked`, { replace: true });
    return;
  }

  const draft = readDraft(id);
  const questions = mock.questions ?? [];

  root.innerHTML = `
    <header class="view-head exam-head">
      <div>
        <h1>${esc(mock.title)}</h1>
        <p class="view-sub">${esc(subjectName(mock.subject_code))} · ${mock.total_marks} marks · answer all questions</p>
      </div>
      <div class="view-actions">
        <span class="exam-timer" id="examTimer" aria-live="off">${minutesToHuman(mock.duration_min ?? 0)}</span>
        <button class="btn-ghost" id="leaveExam">Save &amp; leave</button>
        <button class="btn-primary" id="submitExam">Submit</button>
      </div>
    </header>

    <ol class="exam-paper">
      ${questions.map((q) => `
        <li class="exam-q" id="q-${q.n}">
          <div class="exam-q-head">
            <span class="q-n">${q.n}</span>
            <span class="marks-pill">[${q.marks}]</span>
            <span class="paper-ref muted">${esc(q.paperRef ?? "")}</span>
          </div>
          <pre class="verbatim">${esc(q.text)}</pre>
          <textarea class="exam-answer" data-q="${q.n}" rows="${Math.max(4, Math.min(14, q.marks * 2))}"
            placeholder="Your answer…">${esc(draft[q.n] ?? "")}</textarea>
        </li>`).join("")}
    </ol>

    <div class="exam-foot">
      <button class="btn-primary" id="submitExamFoot">Submit for marking</button>
      <p class="muted">Your answers are saved on this device as you type.</p>
    </div>`;

  // Persist on every keystroke (debounced by the browser's own event pacing —
  // localStorage writes at this size are cheap and losing work is not).
  on(root, "input", ".exam-answer", (_, box) => {
    const current = readDraft(id);
    current[box.dataset.q] = box.value;
    writeDraft(id, current);
  });

  root.querySelector("#leaveExam").addEventListener("click", () => navigate("mock"));
  const submit = () => submitExam(mock);
  root.querySelector("#submitExam").addEventListener("click", submit);
  root.querySelector("#submitExamFoot").addEventListener("click", submit);

  if (mock.status !== "in_progress") {
    updateMock(id, { status: "in_progress", started_at: new Date().toISOString() }).catch(() => {});
    mock.started_at = new Date().toISOString();
  }
  startTimer(mock);
}

function startTimer(mock) {
  if (!mock.duration_min) return;
  const el = root.querySelector("#examTimer");
  const started = new Date(mock.started_at ?? Date.now()).getTime();
  const endsAt = started + mock.duration_min * 60000;

  const tick = () => {
    const left = endsAt - Date.now();
    if (left <= 0) {
      el.textContent = "Time up";
      el.classList.add("over");
      stopTimer();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.classList.toggle("low", left < 5 * 60000);
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function submitExam(mock) {
  const answers = readDraft(mock.id);
  const questions = mock.questions ?? [];
  const answered = questions.filter((q) => (answers[q.n] ?? "").trim());

  if (!answered.length) {
    toast("Answer at least one question first.", "error");
    return;
  }
  const ok = await confirmModal({
    title: "Submit for marking",
    message:
      answered.length < questions.length
        ? `${questions.length - answered.length} question(s) are blank and will score zero. Submit anyway?`
        : "Markwise will mark each answer against its real mark scheme.",
    confirmLabel: "Submit",
  });
  if (!ok) return;

  stopTimer();

  root.innerHTML = `
    <header class="view-head"><div><h1>Marking your paper</h1>
      <p class="view-sub">Each answer is marked against its own mark scheme.</p></div></header>
    <div class="marking-progress" id="markingProgress"></div>`;

  const progress = root.querySelector("#markingProgress");
  const results = [];
  let awarded = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = (answers[q.n] ?? "").trim();
    progress.innerHTML = `
      ${spinner(`Marking question ${i + 1} of ${questions.length}…`)}
      <div class="progress-bar"><span style="width:${(i / questions.length) * 100}%"></span></div>`;

    if (!answer) {
      results.push({ n: q.n, awarded: 0, total: q.marks, blank: true, questionRef: q.paperRef, text: q.text });
      continue;
    }

    try {
      const r = await markAnswer({
        answer,
        chunkId: q.chunkId,
        subject: mock.subject_code,
        mockId: mock.id,
      });
      awarded += r.awarded;
      results.push({ n: q.n, ...r, text: q.text });
    } catch (e) {
      // One failed question must not lose the other nine.
      results.push({
        n: q.n,
        awarded: 0,
        total: q.marks,
        error: explainError(e),
        questionRef: q.paperRef,
        text: q.text,
      });
    }
  }

  const pct = mock.total_marks ? Math.round((awarded / mock.total_marks) * 100) : 0;
  let grade = null;
  try {
    grade = await predictGrade(mock.subject_code, mock.questions?.[0]?.paperNo ?? 1, pct);
  } catch {
    /* boundaries are optional */
  }

  try {
    await updateMock(mock.id, {
      status: "marked",
      submitted_at: new Date().toISOString(),
      awarded,
      grade,
      questions: questions.map((q) => ({ ...q, result: results.find((r) => r.n === q.n) ?? null })),
    });
  } catch (e) {
    toast(e.message, "error");
  }

  localStorage.removeItem(draftKey(mock.id));
  navigate(`mock/${mock.id}/marked`, { replace: true });
}

/* ---------------------------------------------------------------- marked -- */

async function renderMarked(id) {
  root.innerHTML = spinner("Loading your result…");

  let mock;
  try {
    mock = await getMock(id);
    if (!mock) throw new Error("That mock no longer exists.");
  } catch (e) {
    root.innerHTML = `<div class="empty error"><h3>Not found</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  const questions = mock.questions ?? [];
  const pct = mock.total_marks ? Math.round(((mock.awarded ?? 0) / mock.total_marks) * 100) : 0;
  const band = pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";

  // Where the marks actually went, by topic — the most useful single view of
  // a finished paper.
  const byTopic = new Map();
  for (const q of questions) {
    const topic = q.result?.topic ?? q.topic ?? "Unclassified";
    const entry = byTopic.get(topic) ?? { awarded: 0, total: 0 };
    entry.awarded += q.result?.awarded ?? 0;
    entry.total += q.marks ?? 0;
    byTopic.set(topic, entry);
  }

  root.innerHTML = `
    <header class="view-head">
      <div>
        <h1>${esc(mock.title)}</h1>
        <p class="view-sub">${esc(subjectName(mock.subject_code))} · submitted ${formatDateTime(mock.submitted_at)}</p>
      </div>
      <div class="view-actions">
        <button class="btn-ghost" id="backToMocks">All mocks</button>
      </div>
    </header>

    <section class="result-summary">
      <div class="score ${band}">
        <span class="score-value">${mock.awarded ?? 0}<span class="score-of">/${mock.total_marks}</span></span>
        <span class="score-pct">${pct}%</span>
      </div>
      ${mock.grade ? `<div class="grade-pill" title="Based on published grade thresholds">Grade ${esc(mock.grade)}</div>` : ""}
      <div class="topic-bars">
        ${[...byTopic.entries()]
          .sort((a, b) => (a[1].awarded / (a[1].total || 1)) - (b[1].awarded / (b[1].total || 1)))
          .map(([topic, v]) => {
            const p = v.total ? Math.round((v.awarded / v.total) * 100) : 0;
            return `
              <div class="topic-bar">
                <span class="topic-name">${esc(topic)}</span>
                <span class="bar"><span style="width:${p}%" class="${p >= 70 ? "good" : p >= 40 ? "mid" : "poor"}"></span></span>
                <span class="topic-score">${v.awarded}/${v.total}</span>
              </div>`;
          }).join("")}
      </div>
    </section>

    <ol class="exam-paper marked">
      ${questions.map((q) => questionResult(q)).join("")}
    </ol>`;

  root.querySelector("#backToMocks").addEventListener("click", () => navigate("mock"));
}

function questionResult(q) {
  const r = q.result;
  const pct = r && q.marks ? Math.round((r.awarded / q.marks) * 100) : 0;
  const band = !r ? "" : pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";

  return `
    <li class="exam-q marked">
      <div class="exam-q-head">
        <span class="q-n">${q.n}</span>
        <span class="marks-pill ${band}">${r?.awarded ?? 0}/${q.marks}</span>
        <span class="paper-ref muted">${esc(q.paperRef ?? "")}</span>
      </div>
      <pre class="verbatim">${esc(q.text)}</pre>

      ${r?.error ? `<p class="msg-error">${esc(r.error)}</p>` : ""}
      ${r?.blank ? '<p class="muted">Left blank.</p>' : ""}

      ${r?.breakdown?.length ? `
        <ul class="breakdown compact">
          ${r.breakdown.map((b) => `
            <li class="${b.earned ? "earned" : "lost"}">
              <span class="tick">${b.earned ? "✓" : "✗"}</span>
              <div><p class="point">${escLines(b.point)}</p><p class="why">${escLines(b.why)}</p></div>
            </li>`).join("")}
        </ul>` : ""}

      ${r?.modelAnswer ? `<details class="model-details">
        <summary>Full-mark answer</summary>
        <blockquote class="model-answer">${escLines(r.modelAnswer)}</blockquote>
      </details>` : ""}

      ${q.markScheme ? `<details class="model-details">
        <summary>Mark scheme</summary>
        <pre class="verbatim ms">${esc(q.markScheme)}</pre>
      </details>` : ""}
    </li>`;
}

/* ----------------------------------------------------------------- draft -- */

function readDraft(id) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(id)) ?? "{}");
  } catch {
    return {};
  }
}

function writeDraft(id, data) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(data));
  } catch {
    /* quota or private mode — the paper still works, it just is not saved */
  }
}
