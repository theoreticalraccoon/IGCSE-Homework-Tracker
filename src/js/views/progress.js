/**
 * Progress — what the marking history actually says about this student.
 *
 * Every number here comes from marks awarded against real mark schemes, which
 * is why it is worth showing: a topic mastery bar built on a chatbot's opinion
 * of your answer would be noise. Weak topics link straight back into the tools
 * that fix them — a targeted mock, a practice question, a revision task.
 */

import { esc, on } from "../ui/dom.js";
import { toast, emptyState, skeleton, openModal } from "../ui/feedback.js";
import { subjectName, mySubjectRows, corpusCode } from "../store.js";
import { loadAttempts, loadMastery, weakTopics, getAttempt, loadMocks } from "../api/data.js";
import { formatDateTime } from "../lib/dates.js";
import { addRevisionTask } from "./planner.js";
import { navigate } from "../router.js";

let root = null;
let subject = null;

export async function render(container, { query = {} } = {}) {
  root = container;
  // Attempts are recorded against the corpus subject, so the filter has to
  // use the same code the marking route wrote.
  subject = query.subject ? corpusCode(query.subject) : (subject ?? null);

  container.innerHTML = `
    <header class="view-head">
      <div>
        <h1>Progress</h1>
        <p class="view-sub">Built only from answers marked against real mark schemes.</p>
      </div>
      <div class="view-actions">
        <label class="inline-field">
          <span class="muted">Subject</span>
          <select id="progSubject">
            <option value="">All subjects</option>
            ${mySubjectRows().map((s) => {
              const code = corpusCode(s.code);
              return `<option value="${esc(code)}"${code === subject ? " selected" : ""}>${esc(s.name)}</option>`;
            }).join("")}
          </select>
        </label>
      </div>
    </header>
    <div id="progBody">${skeleton(5)}</div>`;

  root.querySelector("#progSubject").addEventListener("change", (e) => {
    subject = e.target.value || null;
    load();
  });

  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));
  on(root, "click", "[data-attempt]", (_, btn) => showAttempt(btn.dataset.attempt));
  on(root, "click", "[data-drill]", (_, btn) =>
    navigate("markpaper")
  );
  on(root, "click", "[data-mock-weak]", () => navigate("mock"));
  on(root, "click", "[data-revise]", async (_, btn) => {
    try {
      await addRevisionTask({
        subject: btn.dataset.subject,
        topic: btn.dataset.revise,
        text: `Revise ${btn.dataset.revise}`,
      });
    } catch (e) {
      toast(e.message, "error");
    }
  });

  await load();
}

async function load() {
  const body = root.querySelector("#progBody");
  body.innerHTML = skeleton(5);

  let attempts, mastery, weak, mocks;
  try {
    [attempts, mastery, weak, mocks] = await Promise.all([
      loadAttempts({ subject, limit: 200 }),
      loadMastery(subject),
      weakTopics(subject, 6),
      loadMocks(10),
    ]);
  } catch (e) {
    body.innerHTML = `<div class="empty error"><h3>Couldn't load your progress</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  if (!attempts.length) {
    body.innerHTML = emptyState({
      icon: "📈",
      title: "Nothing marked yet",
      message: "Answer a past question and have it marked — your topic profile builds itself from there.",
      action: `<button class="btn-primary" data-goto="assistant">Mark an answer</button>`,
    });
    return;
  }

  const marks = attempts.reduce(
    (acc, a) => ({ awarded: acc.awarded + Number(a.awarded), total: acc.total + a.total }),
    { awarded: 0, total: 0 },
  );
  const overall = marks.total ? Math.round((marks.awarded / marks.total) * 100) : 0;

  body.innerHTML = `
    <section class="stat-row">
      ${stat("Overall", `${overall}%`, `${marks.awarded} of ${marks.total} marks`)}
      ${stat("Questions marked", attempts.length, subject ? subjectName(subject) : "across all subjects")}
      ${stat("Mocks sat", mocks.filter((m) => m.status === "marked").length, "marked papers")}
      ${stat("Topics tracked", mastery.length, "with at least one attempt")}
    </section>

    ${weak.length ? `
      <section class="card plain">
        <header>
          <h2>Where you are losing marks</h2>
          <button class="btn-ghost small" data-mock-weak>Build a mock on these</button>
        </header>
        <div class="topic-bars">
          ${weak.map((w) => {
            const pct = Number(w.pct ?? 0);
            return `
              <div class="topic-bar">
                <span class="topic-name">${esc(w.topic)}${!subject ? ` <span class="muted">${esc(subjectName(w.subject_code))}</span>` : ""}</span>
                <span class="bar"><span style="width:${pct}%" class="${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}"></span></span>
                <span class="topic-score">${pct}%</span>
                <button class="link-btn" data-revise="${esc(w.topic)}" data-subject="${esc(w.subject_code)}">Revise</button>
              </div>`;
          }).join("")}
        </div>
      </section>` : ""}

    <section class="card plain">
      <header><h2>Every topic</h2></header>
      ${mastery.length ? `
        <div class="topic-bars">
          ${[...mastery]
            .map((m) => ({ ...m, pct: m.marks_total ? Math.round((m.marks_awarded / m.marks_total) * 100) : 0 }))
            .sort((a, b) => b.pct - a.pct)
            .map((m) => `
              <div class="topic-bar">
                <span class="topic-name">${esc(m.topic)}</span>
                <span class="bar"><span style="width:${m.pct}%" class="${m.pct >= 70 ? "good" : m.pct >= 40 ? "mid" : "poor"}"></span></span>
                <span class="topic-score">${m.marks_awarded}/${m.marks_total}</span>
              </div>`).join("")}
        </div>` : '<p class="muted">No topics classified yet.</p>'}
    </section>

    <section class="card plain">
      <header><h2>Recent answers</h2></header>
      <ul class="attempt-list">
        ${attempts.slice(0, 25).map((a) => {
          const pct = a.total ? Math.round((a.awarded / a.total) * 100) : 0;
          return `
            <li>
              <button data-attempt="${esc(a.id)}">
                <span class="attempt-ref">${esc(a.question_ref ?? "Question")}</span>
                <span class="attempt-topic">${esc(a.topic ?? "")}</span>
                <span class="attempt-score ${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}">${a.awarded}/${a.total}</span>
                <span class="attempt-when muted">${formatDateTime(a.created_at)}</span>
              </button>
            </li>`;
        }).join("")}
      </ul>
    </section>`;
}

function stat(label, value, sub) {
  return `
    <div class="stat">
      <span class="stat-value">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-sub">${esc(sub)}</span>
    </div>`;
}

async function showAttempt(id) {
  openModal({
    title: "Marked answer",
    width: "wide",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const a = await getAttempt(id);
        if (!a) throw new Error("That attempt no longer exists.");
        const pct = a.total ? Math.round((a.awarded / a.total) * 100) : 0;
        dialog.querySelector("#modalTitle").textContent = a.question_ref ?? "Marked answer";

        target.innerHTML = `
          <div class="source-doc">
            <div class="score ${pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor"} inline">
              <span class="score-value">${a.awarded}<span class="score-of">/${a.total}</span></span>
            </div>
            <h4>Question</h4>
            <pre class="verbatim">${esc(a.question_text ?? "")}</pre>
            <h4>Your answer</h4>
            <pre class="verbatim your">${esc(a.answer_text)}</pre>
            ${a.breakdown?.length ? `
              <h4>Marking points</h4>
              <ul class="breakdown compact">
                ${a.breakdown.map((b) => `
                  <li class="${b.earned ? "earned" : "lost"}">
                    <span class="tick">${b.earned ? "✓" : "✗"}</span>
                    <div><p class="point">${esc(b.point)}</p><p class="why">${esc(b.why)}</p></div>
                  </li>`).join("")}
              </ul>` : ""}
            ${a.model_answer ? `<h4>Full-mark answer</h4><blockquote class="model-answer">${esc(a.model_answer)}</blockquote>` : ""}
          </div>`;
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}
