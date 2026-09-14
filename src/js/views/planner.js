/**
 * Planner — the original homework board, unchanged in shape.
 *
 * One card per subject, School and Tuition tabs, blue pen for homework and red
 * for assessments, with a coloured spine so a glance at the board tells you
 * where the pressure is. Tuition has no assessments, so that tab shows only
 * homework and the add form hides the type choice.
 *
 * The only additions over the original are on the add form: an optional note
 * and an optional due time. Everything else deliberately stayed as it was.
 */

import { esc, on } from "../ui/dom.js";
import { toast, openModal, closeModal, confirmModal, emptyState, skeleton } from "../ui/feedback.js";
import { store, savePrefs, subjectName, mySubjectRows } from "../store.js";
import {
  loadTasks, createTask, updateTask, setTaskDone, deleteTask, clearCompleted, syncPrefs,
} from "../api/data.js";
import { dueLabel, iso, addDays, formatTime } from "../lib/dates.js";
import { SOURCES, TASK_TYPES } from "../config.js";

let root = null;
let loaded = false;

export async function render(container) {
  root = container;
  container.innerHTML = shell();
  wire();

  if (!loaded) {
    body().innerHTML = skeleton(3);
    try {
      await loadTasks();
      loaded = true;
    } catch (e) {
      toast(e.message, "error");
    }
  }
  paint();
}

const body = () => root.querySelector("#plannerBody");

function shell() {
  return `
    <header class="view-head">
      <div>
        <h1>Planner</h1>
        <p class="view-sub" id="plannerSummary">—</p>
      </div>
      <button class="btn-primary" id="addTask">Add task</button>
    </header>

    <div class="controls">
      <div class="tabs" id="sourceTabs" role="group" aria-label="School or tuition">
        ${SOURCES.map((s) => `<button type="button" data-source="${s.id}">${s.label}</button>`).join("")}
      </div>
      <label class="toggle">
        <input type="checkbox" id="hideEmpty"> Hide subjects with nothing due
      </label>
      <button class="btn-ghost" id="clearDone" hidden>Clear completed</button>
    </div>

    <div id="plannerBody"></div>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  root.querySelector("#addTask").addEventListener("click", () => openTaskForm());

  on(root, "click", "#sourceTabs button", (_, btn) => {
    savePrefs({ source: btn.dataset.source });
    syncPrefs();
    paint();
  });

  root.querySelector("#hideEmpty").addEventListener("change", (e) => {
    savePrefs({ hideEmpty: e.target.checked });
    syncPrefs();
    paint();
  });

  root.querySelector("#clearDone").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Clear completed tasks",
      message: "Ticked-off tasks in this tab will be deleted permanently.",
      confirmLabel: "Delete them",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await clearCompleted(store.prefs.source);
      toast(`${n} task${n === 1 ? "" : "s"} cleared.`);
      paint();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  on(root, "change", "input[data-toggle]", async (_, input) => {
    const id = input.dataset.toggle;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;
    const next = input.checked;
    task.done = next;              // optimistic; the row repaints immediately
    paint();
    try {
      await setTaskDone(id, next);
    } catch (e) {
      task.done = !next;
      paint();
      toast(e.message, "error");
    }
  });

  on(root, "click", "[data-edit]", (_, btn) => {
    const task = store.tasks.find((t) => t.id === btn.dataset.edit);
    if (task) openTaskForm(task);
  });

  on(root, "click", "[data-delete]", async (_, btn) => {
    const id = btn.dataset.delete;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;
    const snapshot = { ...task };
    store.tasks = store.tasks.filter((t) => t.id !== id);
    paint();
    try {
      await deleteTask(id);
    } catch (e) {
      store.tasks.push(snapshot);
      paint();
      toast(e.message, "error");
    }
  });

  on(root, "click", "[data-add-for]", (_, btn) => openTaskForm(null, btn.dataset.addFor));
}

/* ---------------------------------------------------------------- painting -- */

function paint() {
  const source = store.prefs.source === "tuition" ? "tuition" : "school";

  root.querySelectorAll("#sourceTabs button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.source === source))
  );
  root.querySelector("#hideEmpty").checked = !!store.prefs.hideEmpty;

  const inTab = store.tasks.filter((t) => t.source === source);
  const pending = inTab.filter((t) => !t.done);
  root.querySelector("#clearDone").hidden = !inTab.some((t) => t.done);
  root.querySelector("#plannerSummary").textContent = summarise(pending, source);

  if (!store.tasks.length && loaded) {
    body().innerHTML = emptyState({
      icon: "📓",
      title: "Nothing tracked yet",
      message: "Add your first piece of homework and the deadlines stay straight.",
      action: `<button class="btn-primary" id="emptyAdd">Add a task</button>`,
    });
    body().querySelector("#emptyAdd")?.addEventListener("click", () => openTaskForm());
    return;
  }

  // Chosen subjects always show; anything that already holds work shows too, so
  // dropping a subject in Settings never hides tasks you still have.
  const withWork = new Set(inTab.map((t) => t.subject));
  const subjects = mySubjectRows().slice();
  for (const code of withWork) {
    if (!subjects.some((s) => s.code === code)) subjects.push({ code, name: subjectName(code) });
  }

  const cards = subjects.map((s) => subjectCard(s, inTab, source)).filter(Boolean).join("");
  body().innerHTML = cards
    ? `<div class="board">${cards}</div>`
    : emptyState({ icon: "✓", title: "All clear", message: "Nothing pending in this tab." });
}

function summarise(pending, source) {
  if (!pending.length) return "Nothing pending — you are clear.";
  const hw = pending.filter((t) => t.type === "homework").length;
  const as = pending.length - hw;
  if (source === "tuition") return `${hw} homework task${hw === 1 ? "" : "s"}`;
  return `${hw} homework · ${as} assessment${as === 1 ? "" : "s"}`;
}

function subjectCard(subject, inTab, source) {
  const mine = inTab.filter((t) => t.subject === subject.code);
  // Tuition never sets assessments, so that tab shows homework only.
  const types = source === "tuition" ? ["homework"] : ["homework", "assessment"];
  const pending = mine.filter((t) => !t.done && types.includes(t.type));

  if (store.prefs.hideEmpty && pending.length === 0) return "";

  const hasHw = pending.some((t) => t.type === "homework");
  const hasAs = pending.some((t) => t.type === "assessment");
  const spine = hasHw && hasAs ? "both" : hasHw ? "hw" : hasAs ? "as" : "none";

  const sections = types.map((type) => {
    const items = mine.filter((t) => t.type === type).sort(sortTasks);
    if (!items.length) return "";
    return `
      <div class="card-group">
        <p class="eyebrow ${type}">${type === "homework" ? "Homework" : "Assessments"}</p>
        <ul class="task-list">${items.map(taskRow).join("")}</ul>
      </div>`;
  }).join("");

  return `
    <section class="card spine-${spine}">
      <header>
        <h2>${esc(subject.name)}</h2>
        <button class="add-here" data-add-for="${esc(subject.code)}">Add</button>
      </header>
      ${sections || '<p class="clear-msg">All clear</p>'}
    </section>`;
}

function sortTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const ad = a.due ?? "9999-12-31";
  const bd = b.due ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (a.created ?? 0) - (b.created ?? 0);
}

function taskRow(task) {
  const due = dueLabel(task.due);
  const time = task.due_time ? formatTime(task.due_time) : "";
  return `
    <li class="task${task.done ? " done" : ""}">
      <input type="checkbox" data-toggle="${task.id}"${task.done ? " checked" : ""}
             aria-label="Mark ${esc(task.text)} done">
      <div class="task-main">
        <span class="task-text">${esc(task.text)}</span>
        ${task.notes ? `<span class="task-notes">${esc(task.notes)}</span>` : ""}
      </div>
      ${due ? `<span class="due ${due.cls}">${due.text}${time ? ` ${time}` : ""}</span>` : "<span></span>"}
      <span class="task-tools">
        <button class="icon-btn" data-edit="${task.id}" aria-label="Edit task">✎</button>
        <button class="icon-btn" data-delete="${task.id}" aria-label="Delete task">&times;</button>
      </span>
    </li>`;
}

/* ------------------------------------------------------------- task form -- */

export function openTaskForm(task = null, presetSubject = null) {
  const editing = !!task;
  const list = mySubjectRows().length ? mySubjectRows() : store.subjects;
  const selected = task?.subject ?? presetSubject ?? store.prefs.lastSubject ?? list[0]?.code;
  const source = task?.source ?? (store.prefs.source === "tuition" ? "tuition" : "school");

  openModal({
    title: editing ? "Edit task" : "Add a task",
    body: `
      <form id="taskForm">
        <label class="field">
          <span>Subject</span>
          <select id="tSubject">
            ${list.map((s) => `<option value="${esc(s.code)}"${s.code === selected ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </label>

        <div class="field">
          <span>From</span>
          <div class="chip-row">
            ${SOURCES.map((s) => `
              <input type="radio" name="tSource" id="src-${s.id}" value="${s.id}"${source === s.id ? " checked" : ""}>
              <label class="chip-toggle" for="src-${s.id}">${s.label}</label>`).join("")}
          </div>
        </div>

        <div class="field" id="typeField">
          <span>Type</span>
          <div class="chip-row">
            ${TASK_TYPES.map((t) => `
              <input type="radio" name="tType" id="type-${t.id}" value="${t.id}"${(task?.type ?? "homework") === t.id ? " checked" : ""}>
              <label class="chip-toggle ${t.id}" for="type-${t.id}">${t.label}</label>`).join("")}
          </div>
        </div>

        <label class="field">
          <span>Task</span>
          <input type="text" id="tText" data-autofocus autocomplete="off"
                 placeholder="e.g. Textbook pg 41, Q1–9" value="${esc(task?.text ?? "")}">
        </label>

        <label class="field">
          <span>Note <span class="muted">(optional)</span></span>
          <input type="text" id="tNotes" autocomplete="off"
                 placeholder="Anything you'll want to remember" value="${esc(task?.notes ?? "")}">
        </label>

        <div class="field-row">
          <label class="field">
            <span>Due date</span>
            <input type="date" id="tDue" value="${esc(task?.due ?? "")}">
          </label>
          <label class="field">
            <span>Time <span class="muted">(optional)</span></span>
            <input type="time" id="tTime" value="${esc((task?.due_time ?? "").slice(0, 5))}">
          </label>
        </div>

        <div class="chips" id="quickDates">
          <button type="button" class="chip" data-days="0">Today</button>
          <button type="button" class="chip" data-days="1">Tomorrow</button>
          <button type="button" class="chip" data-days="7">Next week</button>
          <button type="button" class="chip" data-days="">Clear</button>
        </div>
      </form>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="taskSave">${editing ? "Save changes" : "Add task"}</button>`,
    onMount(dialog) {
      const q = (sel) => dialog.querySelector(sel);

      // Tuition homework only — hide the choice rather than offer a
      // combination the tab would never display.
      const syncType = () => {
        const tuition = q("#src-tuition").checked;
        q("#typeField").hidden = tuition;
        if (tuition) q("#type-homework").checked = true;
      };
      dialog.querySelectorAll('input[name="tSource"]').forEach((r) => r.addEventListener("change", syncType));
      syncType();

      q("#quickDates").addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        const days = chip.dataset.days;
        q("#tDue").value = days === "" ? "" : iso(addDays(new Date(), Number(days)));
      });

      const submit = async () => {
        const text = q("#tText").value.trim();
        if (!text) {
          q("#tText").focus();
          toast("Give the task a name.", "error");
          return;
        }
        const src = dialog.querySelector('input[name="tSource"]:checked')?.value ?? "school";
        const fields = {
          subject: q("#tSubject").value,
          source: src,
          type: src === "tuition"
            ? "homework"
            : (dialog.querySelector('input[name="tType"]:checked')?.value ?? "homework"),
          text,
          notes: q("#tNotes").value.trim() || null,
          due: q("#tDue").value || null,
          dueTime: q("#tTime").value || null,
        };

        const save = q("#taskSave");
        save.disabled = true;
        save.textContent = "Saving…";
        try {
          if (editing) {
            await updateTask(task.id, {
              subject: fields.subject, source: fields.source, type: fields.type,
              text: fields.text, notes: fields.notes,
              due: fields.due, due_time: fields.dueTime,
            });
          } else {
            await createTask(fields);
            savePrefs({ lastSubject: fields.subject });
          }
          closeModal();
          paint();
        } catch (e) {
          save.disabled = false;
          save.textContent = editing ? "Save changes" : "Add task";
          toast(e.message, "error");
        }
      };

      q("#taskSave").addEventListener("click", submit);
      q("#taskForm").addEventListener("submit", (e) => {
        e.preventDefault();
        submit();
      });
    },
  });
}

/** Used by the assistant to turn a weakness into a revision task. */
export async function addRevisionTask({ subject, topic, text, due }) {
  await createTask({
    subject,
    type: "homework",
    source: "school",
    text,
    notes: topic ? `Revision — ${topic}` : null,
    due: due ?? iso(addDays(new Date(), 3)),
  });
  toast("Added to your planner.");
}

/** Called after sign-in so the board reloads for the new account. */
export function invalidate() {
  loaded = false;
}
