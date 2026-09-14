/**
 * Assistant — one chat for everything you'd ask a tutor.
 *
 * Ask and "mark my answer" used to be two separate screens with two separate
 * forms, which forced the student to classify their own question before they
 * could type it. They are one box now: what you type decides what happens.
 *
 * A message that names a question and carries a written answer is marked
 * against the real mark scheme and comes back as a marked card. Everything
 * else is answered from the papers with citations. The routing happens here
 * rather than in the model, so the marked card is real structured data and not
 * a paragraph pretending to be one.
 */

import { esc, on, renderMarkdown, scrollToBottom } from "../ui/dom.js";
import { toast, openModal, closeModal } from "../ui/feedback.js";
import { groundedSubjects, subjectName, corpusCode } from "../store.js";
import { loadThreads, createThread, loadMessages, deleteThread, getChunk, weakTopics } from "../api/data.js";
import { ask, markAnswer, explainError } from "../api/ai.js";
import { navigate } from "../router.js";

const PROMPTS = [
  "Explain how to find the nth term of a sequence",
  "How do I get full marks on a 6-mark explain question?",
  "What does the command word 'evaluate' actually want?",
];

let root = null;
let state = {
  threadId: null,
  subject: null,
  messages: [],
  busy: false,
  controller: null,
};

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();
  state.subject = query.subject ?? state.subject ?? grounded[0]?.code ?? null;

  container.innerHTML = shell();
  wire();
  paint();

  if (query.q) {
    root.querySelector("#chatInput").value = query.q;
    send();
  }

  return () => {
    state.controller?.abort();
    state.controller = null;
    state.busy = false;
  };
}

function shell() {
  const grounded = groundedSubjects();
  return `
    <div class="chat">
      <header class="chat-head">
        <div class="chat-subject">
          <select id="chatSubject" aria-label="Subject">
            ${grounded.length
              ? grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")
              : '<option value="">No papers added yet</option>'}
          </select>
        </div>
        <div class="chat-tools">
          <button class="btn-ghost small" id="historyBtn">History</button>
          <button class="btn-ghost small" id="newChat">New chat</button>
        </div>
      </header>

      <div class="chat-thread" id="chatThread"></div>

      <form class="chat-composer" id="chatForm">
        <textarea id="chatInput" rows="1" data-autofocus
          placeholder="Ask anything — or paste your answer and say which question it's for."></textarea>
        <button class="chat-send" id="chatSend" type="submit" aria-label="Send">↑</button>
        <button class="btn-ghost small" id="chatStop" type="button" hidden>Stop</button>
      </form>
      <p class="chat-hint">Answers come from the real papers and mark schemes. Every claim shows its source.</p>
    </div>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  const input = root.querySelector("#chatInput");
  const select = root.querySelector("#chatSubject");
  if (state.subject) select.value = state.subject;

  select.addEventListener("change", () => {
    state.subject = select.value || null;
    if (!state.messages.length) paint();
  });

  root.querySelector("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  // Enter sends, Shift+Enter is a newline, and the box grows with the answer
  // so pasting six lines of working stays readable.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  });

  root.querySelector("#chatStop").addEventListener("click", () => state.controller?.abort());

  root.querySelector("#newChat").addEventListener("click", () => {
    state.threadId = null;
    state.messages = [];
    paint();
    input.focus();
  });

  root.querySelector("#historyBtn").addEventListener("click", openHistory);

  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));
  on(root, "click", "[data-prompt]", (_, btn) => {
    input.value = btn.dataset.prompt;
    send();
  });
  on(root, "click", "[data-source-id]", (_, btn) => showSource(btn.dataset.sourceId));
  on(root, "click", ".cite", (_, btn) => {
    const msg = state.messages[Number(btn.dataset.msg)];
    const c = msg?.citations?.[Number(btn.dataset.cite) - 1];
    if (c) showSource(c.id);
  });
  on(root, "click", "[data-show-ms]", (_, btn) => {
    const panel = btn.closest(".mark-card").querySelector(".ms-panel");
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? "Show the mark scheme" : "Hide the mark scheme";
  });
}

/* --------------------------------------------------------------- painting -- */

function paint() {
  // A streamed reply keeps arriving for a moment after the student navigates
  // away, and by then this view's markup has been replaced by the next one.
  const thread = root?.querySelector("#chatThread");
  if (!thread) return;

  if (!state.messages.length) {
    thread.innerHTML = welcome();
    void weakTopics(corpusCode(state.subject), 3).then((weak) => {
      const slot = root.querySelector("#weakSlot");
      if (!slot || !weak.length) return;
      slot.innerHTML = `
        <p class="chat-weak-title">You've been losing marks on</p>
        <div class="chat-weak">
          ${weak.map((w) => `
            <button class="chip-suggest" data-prompt="Give me practice on ${esc(w.topic)} and explain how to answer it">
              ${esc(w.topic)} <span class="muted">${Math.round(Number(w.pct ?? 0))}%</span>
            </button>`).join("")}
        </div>`;
    }).catch(() => {});
    return;
  }

  thread.innerHTML = state.messages.map(messageHTML).join("");
  scrollToBottom(thread);
}

function welcome() {
  const grounded = groundedSubjects();
  if (!grounded.length) {
    return `
      <div class="chat-welcome">
        <h2>Add some past papers first</h2>
        <p>The assistant answers from real papers and mark schemes. Once you've added
           a few it can explain topics, show you how marks are awarded, and mark your work.</p>
        <button class="btn-primary" data-goto="papers">Add papers</button>
      </div>`;
  }
  return `
    <div class="chat-welcome">
      <h2>What are you working on?</h2>
      <p>Ask about a topic, or paste an answer and say which question it's for — it'll be
         marked against the real mark scheme.</p>
      <div class="chat-prompts">
        ${PROMPTS.map((p) => `<button class="chip-suggest" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}
      </div>
      <div id="weakSlot"></div>
    </div>`;
}

function messageHTML(m, i) {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  }
  if (m.kind === "mark") {
    return `<div class="msg model">${markCard(m.result)}</div>`;
  }
  return `
    <div class="msg model">
      <div class="bubble">
        ${m.content
          ? renderMarkdown(m.content).replace(/data-cite="/g, `data-msg="${i}" data-cite="`)
          : '<span class="typing"><i></i><i></i><i></i></span>'}
        ${m.error ? `<p class="msg-error">${esc(m.error)}</p>` : ""}
      </div>
      ${m.grounded === false ? '<p class="ungrounded">Nothing matched in the papers you\'ve added, so this isn\'t grounded in a real one.</p>' : ""}
      ${sourceStrip(m.citations)}
    </div>`;
}

function sourceStrip(citations) {
  if (!citations?.length) return "";
  return `
    <div class="cite-strip">
      ${citations.slice(0, 6).map((c, i) => `
        <button class="cite-pill" data-source-id="${esc(c.id)}">
          <span class="cite-n">${i + 1}</span>${esc(c.label)}
        </button>`).join("")}
    </div>`;
}

/** A marked answer, rendered as a card in the conversation. */
function markCard(r) {
  const pct = r.pct ?? 0;
  const band = pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";
  return `
    <div class="mark-card">
      <div class="mark-head">
        <span class="mark-score ${band}">${r.awarded}<span>/${r.total}</span></span>
        <span class="mark-ref">${esc(r.questionRef ?? "")}</span>
      </div>
      ${r.feedback ? `<p class="mark-feedback">${esc(r.feedback)}</p>` : ""}
      <ul class="breakdown">
        ${(r.breakdown ?? []).map((b) => `
          <li class="${b.earned ? "earned" : "lost"}">
            <span class="tick">${b.earned ? "✓" : "✗"}</span>
            <div><p class="point">${esc(b.point)}</p><p class="why">${esc(b.why)}</p></div>
          </li>`).join("")}
      </ul>
      ${r.missed?.length ? `
        <p class="mark-sub">What would have earned more</p>
        <ul class="bullets">${r.missed.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
      ${r.modelAnswer ? `
        <p class="mark-sub">A full-mark answer</p>
        <blockquote class="model-answer">${esc(r.modelAnswer)}</blockquote>` : ""}
      <div class="mark-tools">
        <button class="btn-ghost small" data-show-ms>Show the mark scheme</button>
      </div>
      <div class="ms-panel" hidden>
        <pre class="verbatim ms">${esc(r.markScheme ?? "")}</pre>
        <p class="field-hint">If the marking above disagrees with this, trust this.</p>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- routing -- */

/**
 * Does this message want marking?
 *
 * The signal is a question reference plus enough prose to be an attempt at an
 * answer. Asking "what does 0625 Jun 2019 Q4(b) want?" is a question; pasting
 * four lines of working under the same reference is an answer. Guessing wrong
 * in the cautious direction just means a normal grounded reply, which is why
 * the bar is deliberately set high.
 */
function looksLikeMarking(text) {
  const t = text.trim();
  if (/^\s*mark\b/i.test(t)) return true;

  const hasRef = /\b(q(uestion)?\s*\.?\s*\d|_(qp|ms)_|\bpaper\s*\d)/i.test(t);
  const longEnough = t.replace(/\s+/g, " ").length > 120 || t.split("\n").length >= 3;
  return hasRef && longEnough;
}

/** Split "…Q4(b): my answer" into the reference and the answer. */
function splitMarkRequest(text) {
  const t = text.trim().replace(/^\s*mark\s*(my answer)?\s*[:,-]?\s*/i, "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // A short first line naming a question is the reference; the rest is the answer.
  if (lines.length > 1 && lines[0].length < 90 && /\d/.test(lines[0])) {
    return { question: lines[0], answer: lines.slice(1).join("\n") };
  }
  const colon = t.match(/^(.{5,90}?)\s*[:\-–]\s*([\s\S]+)$/);
  if (colon && /\d/.test(colon[1])) return { question: colon[1], answer: colon[2] };

  return { question: t.slice(0, 120), answer: t };
}

/* ---------------------------------------------------------------- sending -- */

async function send() {
  if (state.busy) return;
  const input = root.querySelector("#chatInput");
  const text = input.value.trim();
  if (!text) return;

  if (!state.subject) {
    toast("Add some past papers first.", "error");
    return;
  }

  input.value = "";
  input.style.height = "auto";
  state.messages.push({ role: "user", content: text });
  setBusy(true);

  if (!state.threadId) {
    try {
      const thread = await createThread({ title: text, mode: "ask", subject: state.subject });
      state.threadId = thread.id;
    } catch {
      /* the chat still works unsaved */
    }
  }

  if (looksLikeMarking(text)) await runMark(text);
  else await runAsk(text);

  setBusy(false);
  state.controller = null;
}

async function runMark(text) {
  const placeholder = { role: "model", content: "" };
  state.messages.push(placeholder);
  paint();

  const { question, answer } = splitMarkRequest(text);
  state.controller = new AbortController();

  try {
    const result = await markAnswer(
      { question, answer, subject: corpusCode(state.subject) },
      { signal: state.controller.signal },
    );
    Object.assign(placeholder, { kind: "mark", result });
  } catch (e) {
    const message = explainError(e);
    if (message) placeholder.error = message;
    // No mark scheme, or no matching question: answering normally is more
    // useful than a dead end.
    if (e?.code === "not_found" || e?.code === "no_markscheme") {
      placeholder.error = `${message} Answering it as a question instead.`;
      paint();
      await runAsk(text);
      return;
    }
  }
  paint();
}

async function runAsk(text) {
  const reply = { role: "model", content: "", citations: [] };
  state.messages.push(reply);
  paint();

  const history = state.messages
    .slice(0, -2)
    .filter((m) => m.content && m.kind !== "mark")
    .slice(-6)
    .map((m) => ({ role: m.role, text: m.content }));

  state.controller = new AbortController();

  try {
    await ask(
      { question: text, subject: corpusCode(state.subject), mode: "ask", threadId: state.threadId, history },
      {
        onCitations(citations, grounded) {
          reply.citations = citations;
          reply.grounded = grounded;
          paint();
        },
        onDelta(delta) {
          reply.content += delta;
          const last = root?.querySelector("#chatThread .msg.model:last-child .bubble");
          if (last) {
            last.innerHTML = renderMarkdown(reply.content);
            scrollToBottom(root.querySelector("#chatThread"));
          }
        },
        onError(e) {
          reply.error = explainError(e);
          paint();
        },
      },
      { signal: state.controller.signal },
    );
  } catch (e) {
    const message = explainError(e);
    if (message) reply.error = message;
  }
  if (!reply.content && !reply.error) reply.error = "No answer came back. Try again.";
  paint();
}

function setBusy(busy) {
  state.busy = busy;
  const send = root?.querySelector("#chatSend");
  const stop = root?.querySelector("#chatStop");
  if (send) send.hidden = busy;
  if (stop) stop.hidden = !busy;
}

/* ---------------------------------------------------------------- sources -- */

async function showSource(chunkId) {
  openModal({
    title: "Source",
    width: "wide",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const c = await getChunk(chunkId);
        if (!c) throw new Error("That source is no longer available.");
        dialog.querySelector("#modalTitle").textContent =
          `${c.paper_code ?? ""}${c.question_no ? ` · Q${c.question_no}` : ""}`;
        target.innerHTML = `
          <div class="source-doc">
            <p class="source-ref">
              ${c.marks ? `${c.marks} mark${c.marks === 1 ? "" : "s"}` : ""}${c.topic ? ` · ${esc(c.topic)}` : ""}
            </p>
            <pre class="verbatim">${esc(c.content)}</pre>
            ${c.ms_content
              ? `<details class="model-details"><summary>Mark scheme</summary>
                   <pre class="verbatim ms">${esc(c.ms_content)}</pre></details>`
              : ""}
            ${c.er_content
              ? `<details class="model-details"><summary>What examiners said</summary>
                   <pre class="verbatim er">${esc(c.er_content)}</pre></details>`
              : ""}
          </div>`;
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
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
                  <span class="thread-meta">${t.subject_code ? esc(subjectName(t.subject_code)) : ""}</span>
                </button>
                <button class="icon-btn" data-del-thread="${esc(t.id)}" aria-label="Delete chat">&times;</button>
              </li>`).join("")}
          </ul>`;

        target.addEventListener("click", async (e) => {
          const open = e.target.closest("[data-thread]");
          if (open) {
            await resume(open.dataset.thread, threads);
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

async function resume(id, threads) {
  try {
    const messages = await loadMessages(id);
    const meta = threads.find((t) => t.id === id);
    state.threadId = id;
    state.subject = meta?.subject_code ?? state.subject;
    state.messages = messages.map((m) => ({
      role: m.role, content: m.content, citations: m.citations ?? [],
    }));
    root.querySelector("#chatSubject").value = state.subject ?? "";
    paint();
  } catch (e) {
    toast(e.message, "error");
  }
}
