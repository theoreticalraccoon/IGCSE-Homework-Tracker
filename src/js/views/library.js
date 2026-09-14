/**
 * Library — browse the corpus itself.
 *
 * Two jobs. For the student it is where you find a question to practise. For
 * everyone it is the honesty check: it shows exactly which papers are in the
 * corpus and which are not, so "Markwise has read the papers" is a claim you
 * can verify rather than one you have to take on faith.
 *
 * Search here is keyword-only. Semantic search costs a Gemini call and belongs
 * to Ask; browsing should be free and instant.
 */

import { esc, on, debounce } from "../ui/dom.js";
import { emptyState, spinner, skeleton, openModal, closeModal } from "../ui/feedback.js";
import { groundedSubjects, coverageFor, mySubjectRows, corpusCode } from "../store.js";
import { searchLibrary, subjectTopics, getChunk, similarQuestions } from "../api/data.js";
import { navigate } from "../router.js";

const PAGE = 25;

let root = null;
let state = { subject: null, query: "", topic: null, offset: 0, total: 0, rows: [] };

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();
  state.subject = query.subject || state.subject || grounded[0]?.code || null;
  state.query = query.q ?? "";
  state.topic = null;
  state.offset = 0;

  container.innerHTML = shell();
  wire();
  await Promise.all([paintTopics(), runSearch()]);
}

function shell() {
  const subjects = mySubjectRows();
  return `
    <header class="view-head">
      <div>
        <h1>Library</h1>
        <p class="view-sub">Every question Markwise can answer from, with its mark scheme.</p>
      </div>
    </header>

    <div class="library-bar">
      <label class="inline-field">
        <span class="muted">Subject</span>
        <select id="libSubject">
          ${subjects.map((s) => {
            const cov = coverageFor(s.code);
            return `<option value="${esc(s.code)}"${s.code === state.subject ? " selected" : ""}>
              ${esc(s.name)}${cov ? "" : " (no papers yet)"}
            </option>`;
          }).join("")}
        </select>
      </label>
      <input type="search" id="libSearch" placeholder="Search questions and mark schemes…"
             value="${esc(state.query)}" autocomplete="off">
      <span class="coverage-note" id="libCoverage"></span>
    </div>

    <div class="topic-picker" id="libTopics"></div>
    <div id="libResults">${skeleton(5)}</div>`;
}

function wire() {
  root.querySelector("#libSubject").addEventListener("change", async (e) => {
    state.subject = e.target.value;
    state.topic = null;
    state.offset = 0;
    await Promise.all([paintTopics(), runSearch()]);
  });

  root.querySelector("#libSearch").addEventListener(
    "input",
    debounce((e) => {
      state.query = e.target.value;
      state.offset = 0;
      runSearch();
    }, 350),
  );

  on(root, "click", "[data-topic]", (_, btn) => {
    const topic = btn.dataset.topic;
    state.topic = state.topic === topic ? null : topic;
    state.offset = 0;
    paintTopicChips();
    runSearch();
  });

  on(root, "click", "[data-open-q]", (_, btn) => openQuestion(btn.dataset.openQ));
  on(root, "click", "[data-answer-q]", (_, btn) =>
    navigate(`mark?chunk=${encodeURIComponent(btn.dataset.answerQ)}`)
  );
  on(root, "click", "#libMore", () => {
    state.offset += PAGE;
    runSearch({ append: true });
  });
}

/* ---------------------------------------------------------------- topics -- */

let topics = [];

async function paintTopics() {
  const box = root.querySelector("#libTopics");
  const cov = coverageFor(state.subject);
  root.querySelector("#libCoverage").innerHTML = cov
    ? `<span class="dot ok"></span>${cov.questions.toLocaleString()} questions · ${cov.papers} papers · ${cov.from_year}–${cov.to_year}`
    : `<span class="dot warn"></span>Nothing ingested yet`;

  if (!cov) {
    box.innerHTML = "";
    return;
  }
  try {
    topics = await subjectTopics(corpusCode(state.subject));
  } catch {
    topics = [];
  }
  paintTopicChips();
}

function paintTopicChips() {
  const box = root.querySelector("#libTopics");
  if (!topics.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = topics
    .map((t) => `
      <button class="chip-toggle${state.topic === t.topic ? " on" : ""}" data-topic="${esc(t.topic)}">
        ${esc(t.topic)} <span class="muted">${t.questions}</span>
      </button>`)
    .join("");
}

/* --------------------------------------------------------------- results -- */

async function runSearch({ append = false } = {}) {
  const target = root.querySelector("#libResults");
  if (!append) target.innerHTML = skeleton(5);

  if (!state.subject) {
    target.innerHTML = emptyState({ title: "Pick a subject", message: "Choose one of your subjects above." });
    return;
  }

  try {
    const { rows, total } = await searchLibrary({
      subject: corpusCode(state.subject),
      query: state.query,
      topic: state.topic,
      limit: PAGE,
      offset: state.offset,
    });
    state.total = total;
    state.rows = append ? [...state.rows, ...rows] : rows;
  } catch (e) {
    target.innerHTML = `<div class="empty error"><h3>Search failed</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  if (!state.rows.length) {
    target.innerHTML = coverageFor(state.subject)
      ? emptyState({
          icon: "🔍",
          title: "No matches",
          message: state.query ? `Nothing matched "${state.query}".` : "No questions for this filter.",
        })
      : emptyState({
          icon: "📥",
          title: "Nothing ingested for this subject",
          message:
            "Run the ingestion pipeline for this subject and its questions, mark schemes and syllabus will appear here.",
        });
    return;
  }

  target.innerHTML = `
    <p class="result-count">${state.total.toLocaleString()} question${state.total === 1 ? "" : "s"}</p>
    <ul class="question-list">${state.rows.map(questionRow).join("")}</ul>
    ${state.rows.length < state.total ? '<button class="btn-ghost block" id="libMore">Load more</button>' : ""}`;
}

function questionRow(q) {
  const preview = q.content.replace(/\s+/g, " ");
  return `
    <li>
      <button data-open-q="${esc(q.id)}">
        <span class="paper-ref">
          ${esc(q.paper_code ?? "")}${q.question_no ? ` · Q${esc(q.question_no)}` : ""}
        </span>
        <span class="q-preview">${esc(preview.slice(0, 260))}${preview.length > 260 ? "…" : ""}</span>
        <span class="q-meta">
          ${q.marks ?? "?"} marks
          ${q.topic ? ` · ${esc(q.topic)}` : ""}
          ${q.command_word ? ` · ${esc(q.command_word)}` : ""}
          ${q.ms_content ? "" : ' · <span class="warn-text">no mark scheme</span>'}
        </span>
      </button>
      ${q.ms_content ? `<button class="btn-ghost small" data-answer-q="${esc(q.id)}">Answer it</button>` : ""}
    </li>`;
}

/* -------------------------------------------------------------- question -- */

async function openQuestion(id) {
  openModal({
    title: "Question",
    width: "wide",
    body: spinner("Loading…"),
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      let chunk;
      try {
        chunk = await getChunk(id);
        if (!chunk) throw new Error("That question is no longer in the corpus.");
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
      }

      dialog.querySelector("#modalTitle").textContent =
        `${chunk.paper_code ?? ""}${chunk.question_no ? ` · Q${chunk.question_no}` : ""}`;

      target.innerHTML = `
        <div class="source-doc">
          <p class="source-ref">
            ${chunk.marks ? `${chunk.marks} mark${chunk.marks === 1 ? "" : "s"}` : ""}
            ${chunk.topic ? ` · ${esc(chunk.topic)}` : ""}
            ${chunk.command_word ? ` · command word: ${esc(chunk.command_word)}` : ""}
          </p>
          <pre class="verbatim">${esc(chunk.content)}</pre>

          ${chunk.ms_content
            ? `<details class="model-details"><summary>Mark scheme — open only after you have answered</summary>
                 <pre class="verbatim ms">${esc(chunk.ms_content)}</pre></details>`
            : '<p class="muted">No mark scheme has been paired with this question, so it cannot be marked.</p>'}

          ${chunk.er_content
            ? `<details class="model-details"><summary>Examiner report</summary>
                 <pre class="verbatim er">${esc(chunk.er_content)}</pre></details>`
            : ""}

          <div class="modal-actions">
            <button class="btn-ghost" data-similar>Similar questions</button>
            ${chunk.ms_content ? '<button class="btn-primary" data-answer>Answer it</button>' : ""}
          </div>
          <div id="similarSlot"></div>
        </div>`;

      target.querySelector("[data-answer]")?.addEventListener("click", () => {
        closeModal();
        navigate(`mark?chunk=${encodeURIComponent(chunk.id)}`);
      });

      target.querySelector("[data-similar]").addEventListener("click", async (e) => {
        const slot = target.querySelector("#similarSlot");
        e.currentTarget.disabled = true;
        slot.innerHTML = spinner("Searching…");
        try {
          const rows = await similarQuestions(chunk.id, 6);
          slot.innerHTML = rows.length
            ? `<h4>Similar questions</h4>
               <ul class="question-list compact">
                 ${rows.map((r) => `
                   <li><button data-open-q="${esc(r.id)}">
                     <span class="paper-ref">${esc(r.paper_code ?? "")}${r.question_no ? ` · Q${esc(r.question_no)}` : ""}</span>
                     <span class="q-preview">${esc(r.content.replace(/\s+/g, " ").slice(0, 160))}…</span>
                   </button></li>`).join("")}
               </ul>`
            : "<p class='muted'>Nothing similar found.</p>";
          slot.addEventListener("click", (ev) => {
            const btn = ev.target.closest("[data-open-q]");
            if (btn) {
              closeModal();
              openQuestion(btn.dataset.openQ);
            }
          });
        } catch (err) {
          slot.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
        }
      });
    },
  });
}
