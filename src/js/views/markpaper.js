/**
 * Mark paper — photograph your written answers, get the whole paper marked.
 *
 * Three steps on one screen: pick the paper, add photos, get it back marked.
 * The student never types anything.
 *
 * Photos are downscaled in the browser before upload. A modern phone camera
 * produces 4-8 MB per page, and six of those would exceed the request limit and
 * take a minute to upload over school wifi; 1600px on the long edge is still
 * comfortably legible handwriting at a tenth of the size.
 */

import { esc, on } from "../ui/dom.js";
import { toast, emptyState, spinner } from "../ui/feedback.js";
import { groundedSubjects, corpusCode } from "../store.js";
import { listPapers } from "../api/data.js";
import { markPaper, explainError } from "../api/ai.js";
import { navigate } from "../router.js";

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

let root = null;
let state = { subject: null, paperId: null, papers: [], files: [], busy: false, result: null };

export async function render(container) {
  root = container;
  const grounded = groundedSubjects();
  state.subject = state.subject ?? grounded[0]?.code ?? null;
  state.files = [];
  state.result = null;

  container.innerHTML = shell();
  wire();

  if (grounded.length) await loadPapers();
  paint();
}

function shell() {
  const grounded = groundedSubjects();
  return `
    <header class="view-head">
      <div>
        <h1>Mark a paper</h1>
        <p class="view-sub">Photograph what you wrote. Every question is marked against the real mark scheme.</p>
      </div>
    </header>

    ${grounded.length ? `
      <div class="steps">
        <section class="step">
          <p class="step-label"><span class="step-n">1</span> Which paper did you do?</p>
          <div class="step-body">
            <select id="mpSubject" aria-label="Subject">
              ${grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}
            </select>
            <select id="mpPaper" aria-label="Paper"><option>Loading…</option></select>
          </div>
        </section>

        <section class="step">
          <p class="step-label"><span class="step-n">2</span> Add photos of your answers</p>
          <div class="step-body">
            <label class="dropzone" id="mpDrop">
              <input type="file" id="mpFiles" accept="image/*,application/pdf" multiple hidden>
              <span class="dropzone-icon">📷</span>
              <span class="dropzone-main">Tap to add photos, or drop them here</span>
              <span class="dropzone-sub">One photo per page. A PDF scan works too.</span>
            </label>
            <div id="mpFileList"></div>
          </div>
        </section>

        <div class="step-actions">
          <button class="btn-primary big" id="mpGo" disabled>Mark my paper</button>
          <span class="muted" id="mpNote"></span>
        </div>
      </div>

      <div id="mpResult"></div>`
      : ""}`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  if (!root.querySelector("#mpSubject")) return;

  root.querySelector("#mpSubject").addEventListener("change", async (e) => {
    state.subject = e.target.value;
    state.paperId = null;
    await loadPapers();
    paint();
  });

  root.querySelector("#mpPaper").addEventListener("change", (e) => {
    state.paperId = e.target.value || null;
    paint();
  });

  const input = root.querySelector("#mpFiles");
  input.addEventListener("change", () => addFiles([...input.files]));

  const drop = root.querySelector("#mpDrop");
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => addFiles([...(e.dataTransfer?.files ?? [])]));

  on(root, "click", "[data-drop-file]", (_, btn) => {
    state.files.splice(Number(btn.dataset.dropFile), 1);
    paint();
  });

  root.querySelector("#mpGo").addEventListener("click", submit);
}

async function loadPapers() {
  const select = root.querySelector("#mpPaper");
  if (!select) return;
  select.innerHTML = "<option>Loading…</option>";
  try {
    state.papers = await listPapers(corpusCode(state.subject));
  } catch (e) {
    state.papers = [];
    toast(e.message, "error");
  }
  select.innerHTML = state.papers.length
    ? state.papers.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join("")
    : '<option value="">No papers added for this subject yet</option>';
  state.paperId = state.papers[0]?.id ?? null;
}

/* ------------------------------------------------------------------- files -- */

async function addFiles(incoming) {
  const usable = incoming.filter((f) => /^image\//.test(f.type) || f.type === "application/pdf");
  if (usable.length < incoming.length) toast("Only photos and PDFs can be marked.", "error");

  for (const file of usable.slice(0, 12 - state.files.length)) {
    try {
      state.files.push(await prepare(file));
    } catch {
      toast(`Couldn't read ${file.name}.`, "error");
    }
  }
  paint();
}

/** Downscale photos; PDFs pass through untouched. */
async function prepare(file) {
  if (file.type === "application/pdf") {
    return { name: file.name, mimeType: file.type, data: await toBase64(file), size: file.size };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
  return { name: file.name, mimeType: "image/jpeg", data: await toBase64(blob), size: blob.size };
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------- painting -- */

function paint() {
  if (!groundedSubjects().length) {
    root.querySelector(".view-head").insertAdjacentHTML("afterend", "");
    root.innerHTML = root.querySelector(".view-head").outerHTML + emptyState({
      icon: "📄",
      title: "Add a past paper first",
      message: "Markwise marks against the real mark scheme, so it needs the paper and its mark scheme before it can mark anything.",
      action: `<button class="btn-primary" data-goto="papers">Add papers</button>`,
    });
    on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
    return;
  }

  const list = root.querySelector("#mpFileList");
  if (list) {
    list.innerHTML = state.files.length
      ? `<ul class="file-list">
          ${state.files.map((f, i) => `
            <li>
              <span class="file-name">${esc(f.name)}</span>
              <span class="file-size muted">${Math.round(f.size / 1024)} KB</span>
              <button class="icon-btn" data-drop-file="${i}" aria-label="Remove">&times;</button>
            </li>`).join("")}
        </ul>`
      : "";
  }

  const go = root.querySelector("#mpGo");
  if (go) {
    const ready = state.paperId && state.files.length && !state.busy;
    go.disabled = !ready;
    go.textContent = state.busy ? "Marking…" : "Mark my paper";
    root.querySelector("#mpNote").textContent = state.busy
      ? "Reading your handwriting, then marking each question. This takes a minute."
      : state.files.length ? "" : "Add at least one photo.";
  }
}

/* ---------------------------------------------------------------- marking -- */

async function submit() {
  if (state.busy) return;
  state.busy = true;
  paint();
  root.querySelector("#mpResult").innerHTML = spinner("Reading your answers…");

  try {
    const result = await markPaper({
      paperId: state.paperId,
      files: state.files.map((f) => ({ mimeType: f.mimeType, data: f.data })),
    });
    state.result = result;
    paintResult(result);
  } catch (e) {
    const message = explainError(e);
    root.querySelector("#mpResult").innerHTML = message
      ? `<div class="empty error"><div class="empty-icon">⚠</div><h3>Couldn't mark that</h3><p>${esc(message)}</p></div>`
      : "";
  } finally {
    state.busy = false;
    paint();
  }
}

function paintResult(r) {
  const band = r.pct >= 80 ? "good" : r.pct >= 50 ? "mid" : "poor";

  const byTopic = new Map();
  for (const q of r.questions) {
    if (q.awarded === null) continue;
    const t = q.topic ?? "Unclassified";
    const e = byTopic.get(t) ?? { got: 0, out: 0 };
    e.got += q.awarded;
    e.out += q.marks;
    byTopic.set(t, e);
  }

  root.querySelector("#mpResult").innerHTML = `
    <section class="paper-result">
      <div class="result-top">
        <div class="score ${band}">
          <span class="score-value">${r.awarded}<span class="score-of">/${r.total}</span></span>
          <span class="score-pct">${r.pct}%</span>
        </div>
        ${r.grade ? `<div class="grade-pill">Grade ${esc(r.grade)}</div>` : ""}
        <p class="muted">${r.marked} of ${r.questions.length} questions marked${
          r.unmarkable ? ` · ${r.unmarkable} had no mark scheme` : ""}</p>
      </div>

      ${byTopic.size ? `
        <div class="topic-bars">
          ${[...byTopic.entries()]
            .sort((a, b) => a[1].got / (a[1].out || 1) - b[1].got / (b[1].out || 1))
            .map(([topic, v]) => {
              const p = v.out ? Math.round((v.got / v.out) * 100) : 0;
              return `
                <div class="topic-bar">
                  <span class="topic-name">${esc(topic)}</span>
                  <span class="bar"><span style="width:${p}%" class="${p >= 70 ? "good" : p >= 40 ? "mid" : "poor"}"></span></span>
                  <span class="topic-score">${v.got}/${v.out}</span>
                </div>`;
            }).join("")}
        </div>` : ""}
    </section>

    <ol class="paper-questions">
      ${r.questions.map(questionCard).join("")}
    </ol>`;
}

function questionCard(q) {
  const pct = q.awarded !== null && q.marks ? Math.round((q.awarded / q.marks) * 100) : 0;
  const band = q.awarded === null ? "" : pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";

  const status = {
    blank: '<p class="muted">You left this one blank.</p>',
    no_markscheme: '<p class="muted">No mark scheme stored for this question, so it was not marked.</p>',
    failed: '<p class="msg-error">Marking failed for this question.</p>',
  }[q.status] ?? "";

  return `
    <li class="paper-q">
      <div class="paper-q-head">
        <span class="q-n">${esc(q.questionNo)}</span>
        <span class="marks-pill ${band}">${q.awarded === null ? "—" : q.awarded}/${q.marks}</span>
        ${q.topic ? `<span class="muted">${esc(q.topic)}</span>` : ""}
      </div>

      ${status}

      ${q.breakdown?.length ? `
        <ul class="breakdown compact">
          ${q.breakdown.map((b) => `
            <li class="${b.earned ? "earned" : "lost"}">
              <span class="tick">${b.earned ? "✓" : "✗"}</span>
              <div><p class="point">${esc(b.point)}</p><p class="why">${esc(b.why)}</p></div>
            </li>`).join("")}
        </ul>` : ""}

      ${q.feedback ? `<p class="mark-feedback">${esc(q.feedback)}</p>` : ""}

      <details class="model-details">
        <summary>The question, your answer and the mark scheme</summary>
        <pre class="verbatim">${esc(q.question)}</pre>
        ${q.answer ? `<pre class="verbatim your">${esc(q.answer)}</pre>` : ""}
        ${q.markScheme ? `<pre class="verbatim ms">${esc(q.markScheme)}</pre>` : ""}
      </details>
    </li>`;
}
