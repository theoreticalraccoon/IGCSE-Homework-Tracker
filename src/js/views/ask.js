/**
 * Ask — grounded chat.
 *
 * The citation panel is not decoration. It renders before the first token,
 * which means the student sees *which* real papers the answer is about to be
 * built from, and sees immediately when the answer is about to be built from
 * nothing. An ungrounded answer is labelled as such rather than quietly
 * dressed up as a sourced one.
 */

import { esc, on, renderMarkdown, scrollToBottom } from "../ui/dom.js";
import { toast, emptyState, openModal, closeModal } from "../ui/feedback.js";
import { groundedSubjects, subjectName, coverageFor, corpusCode } from "../store.js";
import { loadThreads, createThread, loadMessages, deleteThread, getChunk } from "../api/data.js";
import { ask, explainError } from "../api/ai.js";
import { navigate } from "../router.js";

const MODES = [
  { id: "ask", label: "Ask", hint: "Anything about the subject, answered from the papers." },
  { id: "syllabus", label: "Syllabus", hint: "Is it examinable? What exactly must you know?" },
  { id: "technique", label: "Technique", hint: "How to answer it so the marks are actually awarded." },
];

const STARTERS = {
  ask: [
    "Explain why a parachute reaches terminal velocity",
    "What is the difference between an exothermic and endothermic reaction?",
  ],
  syllabus: [
    "Is projectile motion examinable on this syllabus?",
    "What do I need to know about the carbon cycle?",
  ],
  technique: [
    "How do I get full marks on a 6-mark 'explain' question?",
    "What does the command word 'evaluate' demand?",
  ],
};

let root = null;
let state = {
  threadId: null,
  mode: "ask",
  subject: null,
  messages: [],       // { role, content, citations }
  streaming: false,
  controller: null,
};

export async function render(container, { query = {} } = {}) {
  root = container;

  const grounded = groundedSubjects();
  state.subject = query.subject ?? state.subject ?? grounded[0]?.code ?? null;
  if (query.mode && MODES.some((m) => m.id === query.mode)) state.mode = query.mode;

  container.innerHTML = shell();
  wire();
  paintMessages();

  if (query.q) {
    root.querySelector("#askInput").value = query.q;
    send();
  }

  // Cancel any in-flight request when the student navigates away.
  return () => {
    state.controller?.abort();
    state.controller = null;
    state.streaming = false;
  };
}

function shell() {
  const grounded = groundedSubjects();
  return `
    <header class="view-head">
      <div>
        <h1>Ask</h1>
        <p class="view-sub">Answers come from the real papers, mark schemes and syllabus — with the reference attached.</p>
      </div>
      <div class="view-actions">
        <button class="btn-ghost" id="historyBtn">History</button>
        <button class="btn-ghost" id="newChat">New chat</button>
      </div>
    </header>

    <div class="ask-bar">
      <div class="segmented" id="modeToggle" role="group" aria-label="Question type">
        ${MODES.map((m) => `<button type="button" data-mode="${m.id}" title="${esc(m.hint)}">${m.label}</button>`).join("")}
      </div>
      <label class="inline-field">
        <span class="muted">Subject</span>
        <select id="askSubject">
          ${grounded.length
            ? grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")
            : '<option value="">No ingested subjects</option>'}
        </select>
      </label>
      <span class="coverage-note" id="coverageNote"></span>
    </div>

    <div class="ask-layout">
      <div class="ask-thread" id="askThread"></div>
      <aside class="sources-panel" id="sourcesPanel" aria-label="Sources"></aside>
    </div>

    <form class="composer" id="askForm">
      <textarea id="askInput" rows="1" data-autofocus
        placeholder="Ask about the syllabus, a topic, or how to answer a question…"></textarea>
      <button class="btn-primary" id="askSend" type="submit">Ask</button>
      <button class="btn-ghost" id="askStop" type="button" hidden>Stop</button>
    </form>`;
}

/* ----------------------------------------------------------------- wiring -- */

function wire() {
  const input = root.querySelector("#askInput");
  const select = root.querySelector("#askSubject");
  if (state.subject) select.value = state.subject;
  paintMode();
  paintCoverage();

  on(root, "click", "#modeToggle button", (_, btn) => {
    state.mode = btn.dataset.mode;
    paintMode();
    if (!state.messages.length) paintMessages();
  });

  select.addEventListener("change", () => {
    state.subject = select.value || null;
    paintCoverage();
    if (!state.messages.length) paintMessages();
  });

  root.querySelector("#askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  // Enter sends; Shift+Enter is a newline. The textarea grows with content so
  // a long question stays fully visible while it is being written.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  });

  root.querySelector("#askStop").addEventListener("click", () => {
    state.controller?.abort();
  });

  root.querySelector("#newChat").addEventListener("click", () => {
    state.threadId = null;
    state.messages = [];
    paintMessages();
    root.querySelector("#sourcesPanel").innerHTML = "";
    input.focus();
  });

  root.querySelector("#historyBtn").addEventListener("click", openHistory);

  on(root, "click", "[data-starter]", (_, btn) => {
    input.value = btn.dataset.starter;
    send();
  });

  // Clicking [2] in an answer opens that source.
  on(root, "click", ".cite", (_, btn) => {
    const n = Number(btn.dataset.cite);
    const message = state.messages[state.messages.length - 1];
    const citation = message?.citations?.[n - 1];
    if (citation) showSource(citation);
  });

  on(root, "click", "[data-source-id]", (_, btn) => {
    const message = [...state.messages].reverse().find((m) => m.citations?.length);
    const citation = message?.citations?.find((c) => c.id === btn.dataset.sourceId);
    if (citation) showSource(citation);
  });
}

function paintMode() {
  root.querySelectorAll("#modeToggle button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode))
  );
}

function paintCoverage() {
  const note = root.querySelector("#coverageNote");
  if (!state.subject) {
    note.innerHTML = "";
    return;
  }
  const cov = coverageFor(state.subject);
  note.innerHTML = cov
    ? `<span class="dot ok"></span>${cov.questions.toLocaleString()} questions · ${cov.from_year}–${cov.to_year}`
    : `<span class="dot warn"></span>No papers ingested for this subject yet`;
}

/* --------------------------------------------------------------- painting -- */

function paintMessages() {
  const thread = root.querySelector("#askThread");

  if (!state.messages.length) {
    const mode = MODES.find((m) => m.id === state.mode);
    const grounded = groundedSubjects();
    thread.innerHTML = grounded.length
      ? emptyState({
          icon: "📄",
          title: mode.label,
          message: mode.hint,
          action: `<div class="starters">${STARTERS[state.mode]
            .map((s) => `<button class="starter" data-starter="${esc(s)}">${esc(s)}</button>`)
            .join("")}</div>`,
        })
      : emptyState({
          icon: "📥",
          title: "No corpus yet",
          message:
            "Markwise only answers from papers that have been ingested. Run the ingestion pipeline for one of your subjects, then come back.",
          action: `<button class="btn-ghost" id="toLibrary">See what is available</button>`,
        });
    thread.querySelector("#toLibrary")?.addEventListener("click", () => navigate("library"));
    return;
  }

  thread.innerHTML = state.messages.map(messageHTML).join("");
  scrollToBottom(thread);
}

function messageHTML(m, i) {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  }
  return `
    <div class="msg model">
      <div class="bubble">
        ${m.content ? renderMarkdown(m.content) : '<span class="typing"><i></i><i></i><i></i></span>'}
        ${m.error ? `<p class="msg-error">${esc(m.error)}</p>` : ""}
      </div>
      ${m.grounded === false ? '<p class="ungrounded">Nothing matched in the corpus — this answer is not grounded in a real paper.</p>' : ""}
      ${citationStrip(m.citations)}
    </div>`;
}

function citationStrip(citations) {
  if (!citations?.length) return "";
  return `
    <div class="cite-strip">
      ${citations.map((c, i) => `
        <button class="cite-pill" data-source-id="${esc(c.id)}" title="${esc(c.label)}">
          <span class="cite-n">${i + 1}</span>${esc(c.label)}
        </button>`).join("")}
    </div>`;
}

function paintSources(citations, grounded) {
  const panel = root.querySelector("#sourcesPanel");
  if (!citations.length) {
    panel.innerHTML = grounded === false
      ? `<p class="panel-empty">No matching papers found.</p>`
      : "";
    return;
  }
  panel.innerHTML = `
    <h3 class="panel-title">Sources</h3>
    <ol class="source-list">
      ${citations.map((c) => `
        <li>
          <button data-source-id="${esc(c.id)}">
            <span class="source-label">${esc(c.label)}</span>
            <span class="source-meta">
              ${c.marks ? `${c.marks} mark${c.marks === 1 ? "" : "s"}` : esc(c.kind)}
              ${c.topic ? ` · ${esc(c.topic)}` : ""}
            </span>
          </button>
        </li>`).join("")}
    </ol>`;
}

/* ---------------------------------------------------------------- sending -- */

async function send() {
  if (state.streaming) return;
  const input = root.querySelector("#askInput");
  const question = input.value.trim();
  if (!question) return;

  if (!state.subject) {
    toast("Pick a subject that has papers ingested.", "error");
    return;
  }

  input.value = "";
  input.style.height = "auto";

  state.messages.push({ role: "user", content: question });
  const reply = { role: "model", content: "", citations: [] };
  state.messages.push(reply);
  paintMessages();
  setStreaming(true);

  // Start a thread on the first exchange so the chat is recoverable.
  if (!state.threadId) {
    try {
      const thread = await createThread({ title: question, mode: state.mode, subject: state.subject });
      state.threadId = thread.id;
    } catch {
      /* chat still works unsaved */
    }
  }

  const history = state.messages
    .slice(0, -2)
    .filter((m) => m.content)
    .slice(-6)
    .map((m) => ({ role: m.role, text: m.content }));

  state.controller = new AbortController();

  try {
    await ask(
      // The corpus is keyed by syllabus code; a borrowed-corpus course
      // (Extra Maths → 0580) must retrieve against the code it borrows.
      { question, subject: corpusCode(state.subject), mode: state.mode, threadId: state.threadId, history },
      {
        onCitations(citations, grounded) {
          reply.citations = citations;
          reply.grounded = grounded;
          paintSources(citations, grounded);
          paintMessages();
        },
        onDelta(delta) {
          reply.content += delta;
          // Repaint just the last bubble — re-rendering the whole thread on
          // every token would fight the scroll position.
          const last = root.querySelector("#askThread .msg.model:last-child .bubble");
          if (last) {
            last.innerHTML = renderMarkdown(reply.content);
            scrollToBottom(root.querySelector("#askThread"));
          }
        },
        onError(e) {
          reply.error = explainError(e);
          paintMessages();
        },
      },
      { signal: state.controller.signal },
    );
  } catch (e) {
    const message = explainError(e);
    if (message) {
      reply.error = message;
      toast(message, "error");
    }
    paintMessages();
  } finally {
    setStreaming(false);
    state.controller = null;
    if (!reply.content && !reply.error) {
      reply.error = "No answer came back. Try again.";
      paintMessages();
    }
  }
}

function setStreaming(on) {
  state.streaming = on;
  root.querySelector("#askSend").hidden = on;
  root.querySelector("#askStop").hidden = !on;
}

/* ---------------------------------------------------------------- sources -- */

async function showSource(citation) {
  openModal({
    title: citation.label,
    width: "wide",
    body: '<div class="loading"><span class="spinner"></span>Loading the source…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const chunk = await getChunk(citation.id);
        if (!chunk) {
          target.innerHTML = "<p class='muted'>That source is no longer in the corpus.</p>";
          return;
        }
        target.innerHTML = sourceHTML(chunk);
        target.querySelector("[data-mark-this]")?.addEventListener("click", () => {
          closeModal();
          navigate(`mark?chunk=${encodeURIComponent(chunk.id)}`);
        });
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}

function sourceHTML(chunk) {
  return `
    <div class="source-doc">
      <p class="source-ref">
        ${esc(chunk.paper_code ?? "")}
        ${chunk.question_no ? ` · Q${esc(chunk.question_no)}` : ""}
        ${chunk.marks ? ` · ${chunk.marks} mark${chunk.marks === 1 ? "" : "s"}` : ""}
        ${chunk.topic ? ` · ${esc(chunk.topic)}` : ""}
      </p>
      <h4>${chunk.kind === "syllabus" ? "Syllabus" : "Question"}</h4>
      <pre class="verbatim">${esc(chunk.content)}</pre>
      ${chunk.ms_content ? `<h4>Mark scheme</h4><pre class="verbatim ms">${esc(chunk.ms_content)}</pre>` : ""}
      ${chunk.er_content ? `<h4>Examiner report</h4><pre class="verbatim er">${esc(chunk.er_content)}</pre>` : ""}
      ${chunk.kind === "question" && chunk.ms_content
        ? '<div class="modal-actions"><button class="btn-primary" data-mark-this>Answer this and get it marked</button></div>'
        : ""}
    </div>`;
}

/* ---------------------------------------------------------------- history -- */

async function openHistory() {
  openModal({
    title: "Your chats",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const threads = await loadThreads();
        if (!threads.length) {
          target.innerHTML = "<p class='muted'>No saved chats yet.</p>";
          return;
        }
        target.innerHTML = `
          <ul class="thread-list">
            ${threads.map((t) => `
              <li>
                <button class="thread-open" data-thread="${esc(t.id)}">
                  <span class="thread-title">${esc(t.title)}</span>
                  <span class="thread-meta">${esc(t.mode)}${t.subject_code ? ` · ${esc(subjectName(t.subject_code))}` : ""}</span>
                </button>
                <button class="icon-btn" data-del-thread="${esc(t.id)}" aria-label="Delete chat">&times;</button>
              </li>`).join("")}
          </ul>`;

        target.addEventListener("click", async (e) => {
          const open = e.target.closest("[data-thread]");
          if (open) {
            await resumeThread(open.dataset.thread, threads);
            closeModal();
            return;
          }
          const del = e.target.closest("[data-del-thread]");
          if (del) {
            try {
              await deleteThread(del.dataset.delThread);
              del.closest("li").remove();
            } catch (err) {
              toast(err.message, "error");
            }
          }
        });
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}

async function resumeThread(id, threads) {
  try {
    const messages = await loadMessages(id);
    const meta = threads.find((t) => t.id === id);
    state.threadId = id;
    state.mode = meta?.mode ?? "ask";
    state.subject = meta?.subject_code ?? state.subject;
    state.messages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      citations: m.citations ?? [],
    }));
    root.querySelector("#askSubject").value = state.subject ?? "";
    paintMode();
    paintCoverage();
    paintMessages();
    const last = [...state.messages].reverse().find((m) => m.citations?.length);
    paintSources(last?.citations ?? [], true);
  } catch (e) {
    toast(e.message, "error");
  }
}
