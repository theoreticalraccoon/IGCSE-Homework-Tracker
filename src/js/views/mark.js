/**
 * Mark — the feature the whole corpus exists for.
 *
 * A student pastes an answer; Markwise finds the actual question, marks against
 * the actual mark scheme, and shows the marking points one by one so the result
 * is checkable rather than trusted. The mark scheme is shown in full underneath
 * every result: if the marking is wrong, the student can see that it is wrong,
 * which is a property no ungrounded marking tool can offer.
 */

import { esc, escLines, on } from "../ui/dom.js";
import { toast, spinner, openModal, closeModal } from "../ui/feedback.js";
import { groundedSubjects, corpusCode } from "../store.js";
import { getChunk, similarQuestions } from "../api/data.js";
import { markAnswer, explainError } from "../api/ai.js";
import { addRevisionTask } from "./planner.js";
import { navigate } from "../router.js";

let root = null;
let state = {
  subject: null,
  chunk: null,       // the question being answered, when picked explicitly
  result: null,
  busy: false,
  controller: null,
};

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();
  state.subject = query.subject ?? state.subject ?? grounded[0]?.code ?? null;

  container.innerHTML = shell();
  wire();

  if (query.chunk) {
    await loadQuestion(query.chunk);
  } else {
    paintQuestion();
  }

  return () => {
    state.controller?.abort();
    state.controller = null;
  };
}

function shell() {
  const grounded = groundedSubjects();
  return `
    <header class="view-head">
      <div>
        <h1>Mark my answer</h1>
        <p class="view-sub">Marked against the real mark scheme, point by point.</p>
      </div>
      <div class="view-actions">
        <label class="inline-field">
          <span class="muted">Subject</span>
          <select id="markSubject">
            ${grounded.length
              ? grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")
              : '<option value="">No ingested subjects</option>'}
          </select>
        </label>
      </div>
    </header>

    <div class="mark-grid">
      <section class="mark-input">
        <div id="questionSlot"></div>

        <label class="field">
          <span>Your answer</span>
          <textarea id="answerBox" rows="10" data-autofocus
            placeholder="Write or paste your answer exactly as you would in the exam."></textarea>
        </label>

        <div class="mark-actions">
          <button class="btn-primary" id="markBtn">Mark it</button>
          <button class="btn-ghost" id="clearBtn">Clear</button>
          <span class="muted" id="markHint"></span>
        </div>
      </section>

      <section class="mark-result" id="markResult"></section>
    </div>`;
}

/* ----------------------------------------------------------------- wiring -- */

function wire() {
  const select = root.querySelector("#markSubject");
  if (state.subject) select.value = state.subject;
  select.addEventListener("change", () => {
    state.subject = select.value || null;
  });

  root.querySelector("#markBtn").addEventListener("click", submit);
  root.querySelector("#clearBtn").addEventListener("click", () => {
    state.chunk = null;
    state.result = null;
    root.querySelector("#answerBox").value = "";
    paintQuestion();
    root.querySelector("#markResult").innerHTML = "";
  });

  on(root, "click", "#pickQuestion", () => navigate(`library?subject=${encodeURIComponent(state.subject ?? "")}`));
  on(root, "click", "#clearQuestion", () => {
    state.chunk = null;
    paintQuestion();
  });
  on(root, "click", "[data-revise]", (_, btn) => reviseTopic(btn.dataset.revise));
  on(root, "click", "[data-similar]", () => showSimilar());
  on(root, "click", "[data-show-ms]", (_, btn) => {
    const panel = root.querySelector("#msPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? "Show the mark scheme" : "Hide the mark scheme";
  });
}

/* --------------------------------------------------------------- question -- */

async function loadQuestion(chunkId) {
  root.querySelector("#questionSlot").innerHTML = spinner("Loading the question…");
  try {
    const chunk = await getChunk(chunkId);
    if (!chunk) throw new Error("That question is no longer in the corpus.");
    state.chunk = chunk;
    state.subject = chunk.subject_code;
    root.querySelector("#markSubject").value = chunk.subject_code;
  } catch (e) {
    toast(e.message, "error");
  }
  paintQuestion();
}

function paintQuestion() {
  const slot = root.querySelector("#questionSlot");
  const hint = root.querySelector("#markHint");

  if (state.chunk) {
    const c = state.chunk;
    slot.innerHTML = `
      <div class="question-card">
        <div class="question-head">
          <span class="paper-ref">${esc(c.paper_code ?? "")}${c.question_no ? ` · Q${esc(c.question_no)}` : ""}</span>
          <span class="marks-pill">${c.marks ?? "?"} mark${c.marks === 1 ? "" : "s"}</span>
          <button class="link-btn" id="clearQuestion">Change</button>
        </div>
        <pre class="verbatim">${esc(c.content)}</pre>
        ${c.topic ? `<p class="question-topic">${esc(c.topic)}</p>` : ""}
      </div>`;
    hint.textContent = "";
    return;
  }

  slot.innerHTML = `
    <label class="field">
      <span>Which question?</span>
      <input type="text" id="questionRef" autocomplete="off"
        placeholder="e.g. 0625 Jun 2019 Paper 42 Q4(b) — or paste the question text">
    </label>
    <p class="field-hint">
      Or <button class="link-btn" id="pickQuestion">pick it from the Library</button> to be certain
      Markwise marks against the right paper.
    </p>`;
  hint.textContent = "";
}

/* ---------------------------------------------------------------- marking -- */

async function submit() {
  if (state.busy) return;

  const answer = root.querySelector("#answerBox").value.trim();
  if (!answer) {
    toast("Write your answer first.", "error");
    root.querySelector("#answerBox").focus();
    return;
  }

  const refInput = root.querySelector("#questionRef");
  const question = refInput?.value.trim() ?? "";
  if (!state.chunk && !question) {
    toast("Tell Markwise which question this answers.", "error");
    refInput?.focus();
    return;
  }

  setBusy(true);
  root.querySelector("#markResult").innerHTML = spinner("Finding the paper and marking…");
  state.controller = new AbortController();

  try {
    const result = await markAnswer(
      {
        answer,
        chunkId: state.chunk?.id ?? null,
        question: state.chunk ? null : question,
        subject: corpusCode(state.subject),
      },
      { signal: state.controller.signal },
    );
    state.result = result;
    paintResult(result);
  } catch (e) {
    const message = explainError(e);
    if (message) {
      root.querySelector("#markResult").innerHTML = `
        <div class="empty error">
          <div class="empty-icon">⚠</div>
          <h3>Couldn't mark that</h3>
          <p>${esc(message)}</p>
          ${e.code === "not_found"
            ? '<button class="btn-ghost" id="pickQuestion">Pick the question from the Library</button>'
            : ""}
        </div>`;
    }
  } finally {
    setBusy(false);
    state.controller = null;
  }
}

function setBusy(busy) {
  state.busy = busy;
  const btn = root.querySelector("#markBtn");
  btn.disabled = busy;
  btn.textContent = busy ? "Marking…" : "Mark it";
}

function paintResult(r) {
  const pct = r.pct ?? 0;
  const band = pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";
  const earned = r.breakdown.filter((b) => b.earned).length;

  root.querySelector("#markResult").innerHTML = `
    <div class="result-card">
      <div class="score ${band}">
        <span class="score-value">${r.awarded}<span class="score-of">/${r.total}</span></span>
        <span class="score-pct">${pct}%</span>
      </div>

      <p class="result-ref">
        ${esc(r.questionRef ?? "")}
        ${r.topic ? ` · <button class="link-btn" data-revise="${esc(r.topic)}">${esc(r.topic)}</button>` : ""}
      </p>

      ${r.feedback ? `<p class="result-feedback">${escLines(r.feedback)}</p>` : ""}

      <h3>Marking points <span class="muted">(${earned} of ${r.breakdown.length})</span></h3>
      <ul class="breakdown">
        ${r.breakdown.map((b) => `
          <li class="${b.earned ? "earned" : "lost"}">
            <span class="tick" aria-hidden="true">${b.earned ? "✓" : "✗"}</span>
            <div>
              <p class="point">${escLines(b.point)}</p>
              <p class="why">${escLines(b.why)}</p>
            </div>
          </li>`).join("")}
      </ul>

      ${r.missed?.length ? `
        <h3>What would have earned more</h3>
        <ul class="bullets">${r.missed.map((m) => `<li>${escLines(m)}</li>`).join("")}</ul>` : ""}

      ${r.strengths?.length ? `
        <h3>What you did well</h3>
        <ul class="bullets good">${r.strengths.map((m) => `<li>${escLines(m)}</li>`).join("")}</ul>` : ""}

      ${r.modelAnswer ? `
        <h3>A full-mark answer</h3>
        <blockquote class="model-answer">${escLines(r.modelAnswer)}</blockquote>` : ""}

      <div class="result-tools">
        <button class="btn-ghost" data-show-ms>Show the mark scheme</button>
        <button class="btn-ghost" data-similar>More questions like this</button>
        ${r.topic ? `<button class="btn-ghost" data-revise="${esc(r.topic)}">Add revision task</button>` : ""}
      </div>

      <div id="msPanel" hidden>
        <h3>Mark scheme <span class="muted">verbatim</span></h3>
        <pre class="verbatim ms">${esc(r.markScheme ?? "")}</pre>
        ${r.examinerReport ? `
          <h3>Examiner report</h3>
          <pre class="verbatim er">${esc(r.examinerReport)}</pre>` : ""}
        <p class="field-hint">
          If the marking above disagrees with this, trust this — and tell your teacher.
        </p>
      </div>
    </div>`;
}

/* ------------------------------------------------------------- follow-ups -- */

async function reviseTopic(topic) {
  try {
    await addRevisionTask({
      subject: state.subject,
      topic,
      text: `Revise ${topic}`,
      originRef: state.result?.attemptId ?? null,
    });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function showSimilar() {
  const chunkId = state.chunk?.id ?? state.result?.citations?.[0]?.id;
  if (!chunkId) {
    toast("No question to compare against.", "error");
    return;
  }
  openModal({
    title: "Questions like this one",
    width: "wide",
    body: spinner("Searching the corpus…"),
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const rows = await similarQuestions(chunkId, 8);
        target.innerHTML = rows.length
          ? `<ul class="question-list">
              ${rows.map((q) => `
                <li>
                  <button data-open="${esc(q.id)}">
                    <span class="paper-ref">${esc(q.paper_code ?? "")}${q.question_no ? ` · Q${esc(q.question_no)}` : ""}</span>
                    <span class="q-preview">${esc(q.content.slice(0, 220))}${q.content.length > 220 ? "…" : ""}</span>
                    <span class="q-meta">${q.marks ?? "?"} marks${q.topic ? ` · ${esc(q.topic)}` : ""}</span>
                  </button>
                </li>`).join("")}
            </ul>`
          : "<p class='muted'>Nothing similar found.</p>";

        target.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-open]");
          if (!btn) return;
          closeModal();
          navigate(`mark?chunk=${encodeURIComponent(btn.dataset.open)}`);
        });
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}
