/**
 * Papers — drop PDFs in and they become searchable, markable questions.
 *
 * This replaces a command-line tool that needed a service-role key, a Node
 * install and files named the way Cambridge names them. Here the student drags
 * whatever they downloaded and the server works out what each file is.
 *
 * Files are processed one at a time on purpose: each one is a large upload and
 * a slow model call, and a queue that reports each result as it lands is far
 * easier to understand than eight spinners that finish in a random order.
 */

import { esc, on } from "../ui/dom.js";
import { toast } from "../ui/feedback.js";
import { store } from "../store.js";
import { loadCatalogue } from "../api/data.js";
import { ingestPaper, explainError } from "../api/ai.js";

let root = null;
let queue = [];      // { name, mimeType, data, size, status, message }
let running = false;

export async function render(container) {
  root = container;
  container.innerHTML = shell();
  wire();
  paintCoverage();
  paintQueue();
}

function shell() {
  return `
    <header class="view-head">
      <div>
        <h1>Your papers</h1>
        <p class="view-sub">Add past papers and mark schemes. Everything else in Markwise works from these.</p>
      </div>
    </header>

    <label class="dropzone tall" id="pDrop">
      <input type="file" id="pFiles" accept="application/pdf" multiple hidden>
      <span class="dropzone-icon">📄</span>
      <span class="dropzone-main">Drop past-paper PDFs here</span>
      <span class="dropzone-sub">
        Question papers and mark schemes. Add both for a paper and you can be marked on it.
        Names don't matter — each file is read to work out what it is.
      </span>
    </label>

    <div id="pQueue"></div>

    <h2 class="section-title">What you have</h2>
    <div id="pCoverage"></div>`;
}

function wire() {
  const input = root.querySelector("#pFiles");
  input.addEventListener("change", () => {
    add([...input.files]);
    input.value = "";
  });

  const drop = root.querySelector("#pDrop");
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => add([...(e.dataTransfer?.files ?? [])]));

  on(root, "click", "#pClear", () => {
    queue = queue.filter((f) => f.status === "waiting" || f.status === "working");
    paintQueue();
  });
}

/* ------------------------------------------------------------------- queue -- */

async function add(files) {
  const pdfs = files.filter((f) => f.type === "application/pdf");
  if (pdfs.length < files.length) toast("Only PDFs can be added.", "error");
  if (!pdfs.length) return;

  for (const file of pdfs) {
    if (file.size > 11 * 1024 * 1024) {
      queue.push({ name: file.name, status: "error", message: "Too large — 11 MB is the limit." });
      continue;
    }
    queue.push({
      name: file.name,
      mimeType: file.type,
      size: file.size,
      data: await toBase64(file),
      status: "waiting",
    });
  }
  paintQueue();
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;

  try {
    for (const item of queue) {
      if (item.status !== "waiting") continue;
      item.status = "working";
      paintQueue();
      try {
        const res = await ingestPaper({
          fileName: item.name,
          file: { mimeType: item.mimeType, data: item.data },
        });
        item.status = "done";
        item.message = res.message;
        item.subject = res.subject;
        item.paperCode = res.paperCode;
      } catch (e) {
        item.status = "error";
        item.message = explainError(e) ?? "Could not add that file.";
      }
      // The base64 copy is the biggest thing in memory; a dozen of them will
      // exhaust a phone's tab.
      item.data = null;
      paintQueue();
    }
  } finally {
    running = false;
  }

  try {
    await loadCatalogue();
    paintCoverage();
  } catch { /* the queue result already told them what happened */ }
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------- painting -- */

function paintQueue() {
  const el = root.querySelector("#pQueue");
  if (!el) return;
  if (!queue.length) {
    el.innerHTML = "";
    return;
  }

  const finished = queue.filter((f) => f.status === "done" || f.status === "error").length;

  el.innerHTML = `
    <div class="queue">
      <div class="queue-head">
        <span>${finished} of ${queue.length} processed</span>
        ${finished === queue.length ? '<button class="link-btn" id="pClear">Clear</button>' : ""}
      </div>
      <ul class="queue-list">
        ${queue.map((f) => `
          <li class="queue-item ${f.status}">
            <span class="queue-icon">${
              f.status === "done" ? "✓" : f.status === "error" ? "✗" :
              f.status === "working" ? '<span class="spinner"></span>' : "·"}</span>
            <div class="queue-text">
              <span class="queue-name">${esc(f.name)}</span>
              <span class="queue-msg">${
                f.status === "working" ? "Reading it…" :
                f.status === "waiting" ? "Waiting" : esc(f.message ?? "")}</span>
            </div>
          </li>`).join("")}
      </ul>
    </div>`;
}

function paintCoverage() {
  const el = root.querySelector("#pCoverage");
  if (!el) return;

  const rows = (store.coverage ?? []).filter((c) => c.questions > 0);
  if (!rows.length) {
    el.innerHTML = `<p class="muted">Nothing yet. Add a question paper and its mark scheme to get started.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="coverage">
      ${rows.map((c) => `
        <div class="coverage-row">
          <span class="coverage-name">${esc(c.subject_name)}</span>
          <span class="coverage-count">${c.questions} question${c.questions === 1 ? "" : "s"}</span>
          <span class="coverage-years muted">${c.from_year ? `${c.from_year}–${c.to_year}` : ""}</span>
        </div>`).join("")}
    </div>`;
}
