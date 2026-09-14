/**
 * Planner — homework, assessments, revision and tuition, by subject or by week.
 *
 * The original tracker's exam-paper metaphor is kept: blue pen for homework,
 * red for assessments, and a coloured spine down each subject card so a glance
 * at the board tells you where the pressure is. Revision tasks created by the
 * AI carry a marker so it is always clear what the student wrote and what the
 * app suggested.
 */

import { esc, on, debounce } from "../ui/dom.js";
import { toast, openModal, closeModal, confirmModal, emptyState, skeleton } from "../ui/feedback.js";
import { store, savePrefs, subjectName, mySubjectRows } from "../store.js";
import {
  loadTasks, createTask, updateTask, setTaskDone, deleteTask, clearCompleted, syncPrefs,
} from "../api/data.js";
import { dueLabel, today, iso, addDays, weekOf, formatTime, minutesToHuman } from "../lib/dates.js";
import { SOURCES, TASK_TYPES } from "../config.js";
import { navigate } from "../router.js";

let root = null;
let loaded = false;

export async function render(container) {
  root = container;
  container.innerHTML = shell();
  wire();

  if (!loaded) {
    body().innerHTML = skeleton(4);
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
      <div class="view-actions">
        <div class="segmented" id="viewToggle" role="group" aria-label="Layout">
          <button data-view="board" type="button">Board</button>
          <button data-view="week" type="button">Week</button>
          <button data-view="list" type="button">List</button>
        </div>
        <button class="btn-primary" id="addTask">Add task</button>
      </div>
    </header>

    <div class="controls">
      <div class="tabs" id="sourceTabs" role="group" aria-label="Where the work came from">
        ${SOURCES.map((s) => `<button type="button" data-source="${s.id}">${s.label}</button>`).join("")}
        <button type="button" data-source="all">All</button>
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

  on(root, "click", "#viewToggle button", (_, btn) => {
    savePrefs({ plannerView: btn.dataset.view });
    syncPrefs();
    paint();
  });

  root.querySelector("#hideEmpty").addEventListener("change", (e) => {
    savePrefs({ hideEmpty: e.target.checked });
    syncPrefs();
    paint();
  });

  root.querySelector("#clearDone").addEventListener("click", async () => {
    const source = store.prefs.source === "all" ? null : store.prefs.source;
    const ok = await confirmModal({
      title: "Clear completed tasks",
      message: "Completed tasks in this tab will be deleted permanently.",
      confirmLabel: "Delete them",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await clearCompleted(source);
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
    task.done = next; // optimistic — the row repaints immediately
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
  on(root, "click", "[data-practise]", (_, btn) =>
    navigate(`library?subject=${encodeURIComponent(btn.dataset.practise)}`)
  );
}

/* ---------------------------------------------------------------- painting -- */

function visibleTasks() {
  const source = store.prefs.source;
  return store.tasks.filter((t) => source === "all" || t.source === source);
}

function paint() {
  const source = store.prefs.source ?? "school";
  const view = store.prefs.plannerView ?? "board";

  root.querySelectorAll("#sourceTabs button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.source === source))
  );
  root.querySelectorAll("#viewToggle button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.view === view))
  );
  root.querySelector("#hideEmpty").checked = !!store.prefs.hideEmpty;
  root.querySelector("#hideEmpty").closest(".toggle").hidden = view !== "board";

  const tasks = visibleTasks();
  const pending = tasks.filter((t) => !t.done);
  root.querySelector("#clearDone").hidden = !tasks.some((t) => t.done);
  root.querySelector("#plannerSummary").textContent = summarise(pending);

  if (store.tasks.length === 0 && loaded) {
    body().innerHTML = emptyState({
      icon: "📓",
      title: "Nothing tracked yet",
      message: "Add your first piece of homework and Markwise will keep the deadlines straight.",
      action: `<button class="btn-primary" id="emptyAdd">Add a task</button>`,
    });
    body().querySelector("#emptyAdd")?.addEventListener("click", () => openTaskForm());
    return;
  }

  body().innerHTML = view === "week" ? weekView(tasks) : view === "list" ? listView(tasks) : boardView(tasks);
}

function summarise(pending) {
  if (!pending.length) return "Nothing pending — you are clear.";
  const overdue = pending.filter((t) => t.due && t.due < today()).length;
  const counts = TASK_TYPES.map((t) => ({
    label: t.label.toLowerCase(),
    n: pending.filter((p) => p.type === t.id).length,
  })).filter((c) => c.n);
  const parts = counts.map((c) => `${c.n} ${c.label}${c.n === 1 ? "" : "s"}`);
  return parts.join(" · ") + (overdue ? ` · ${overdue} overdue` : "");
}

/* ---------------------------------------------------------------- board -- */

function boardView(tasks) {
  const withWork = new Set(tasks.map((t) => t.subject));
  const subjects = mySubjectRows().filter((s) => withWork.has(s.code) || !store.prefs.hideEmpty);
  // A subject dropped from settings can still hold tasks; never hide those.
  for (const code of withWork) {
    if (!subjects.some((s) => s.code === code)) {
      subjects.push({ code, name: subjectName(code) });
    }
  }

  if (!subjects.length) {
    return emptyState({
      icon: "✓",
      title: "All clear",
      message: "Nothing is pending in this tab.",
    });
  }

  return `<div class="board">${subjects.map((s) => subjectCard(s, tasks)).join("")}</div>`;
}

function subjectCard(subject, tasks) {
  const mine = tasks.filter((t) => t.subject === subject.code);
  const pending = mine.filter((t) => !t.done);
  if (store.prefs.hideEmpty && pending.length === 0) return "";

  const spine = pending.some((t) => t.type === "assessment")
    ? pending.some((t) => t.type !== "assessment") ? "both" : "as"
    : pending.length ? "hw" : "none";

  const groups = TASK_TYPES.map((type) => {
    const items = mine.filter((t) => t.type === type.id).sort(sortTasks);
    if (!items.length) return "";
    return `
      <div class="card-group">
        <p class="eyebrow ${type.id}">${type.label}</p>
        <ul class="task-list">${items.map(taskRow).join("")}</ul>
      </div>`;
  }).join("");

  return `
    <section class="card spine-${spine}">
      <header>
        <h2>${esc(subject.name)}</h2>
        <div class="card-head-actions">
          <button class="link-btn" data-practise="${esc(subject.code)}">Practise</button>
          <button class="add-here" data-add-for="${esc(subject.code)}">Add</button>
        </div>
      </header>
      ${groups || '<p class="clear-msg">All clear</p>'}
    </section>`;
}

function sortTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.priority !== b.priority) return (b.priority ?? 1) - (a.priority ?? 1);
  const ad = a.due ?? "9999-12-31";
  const bd = b.due ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (a.created ?? 0) - (b.created ?? 0);
}

function taskRow(task, { showSubject = false } = {}) {
  const due = dueLabel(task.due);
  const meta = [
    showSubject ? esc(subjectName(task.subject)) : "",
    task.topic ? esc(task.topic) : "",
    task.estimate_min ? minutesToHuman(task.estimate_min) : "",
    task.due_time ? formatTime(task.due_time) : "",
  ].filter(Boolean);

  return `
    <li class="task${task.done ? " done" : ""}${task.priority === 2 ? " high" : ""}">
      <input type="checkbox" data-toggle="${task.id}"${task.done ? " checked" : ""}
             aria-label="Mark ${esc(task.text)} done">
      <div class="task-main">
        <span class="task-text">${esc(task.text)}</span>
        ${meta.length ? `<span class="task-meta">${meta.join(" · ")}</span>` : ""}
        ${task.notes ? `<span class="task-notes">${esc(task.notes)}</span>` : ""}
      </div>
      ${task.origin === "ai" ? '<span class="tag ai" title="Suggested by Markwise">AI</span>' : ""}
      ${due ? `<span class="due ${due.cls}">${due.text}</span>` : "<span></span>"}
      <span class="task-tools">
        <button class="icon-btn" data-edit="${task.id}" aria-label="Edit task">✎</button>
        <button class="icon-btn" data-delete="${task.id}" aria-label="Delete task">&times;</button>
      </span>
    </li>`;
}

/* ----------------------------------------------------------------- week -- */

function weekView(tasks) {
  const days = weekOf(new Date());
  const byDay = new Map(days.map((d) => [iso(d), []]));
  const later = [];
  const noDate = [];

  for (const task of tasks) {
    if (task.done) continue;
    if (!task.due) noDate.push(task);
    else if (byDay.has(task.due)) byDay.get(task.due).push(task);
    else if (task.due < iso(days[0])) byDay.get(iso(days[0]))?.push(task); // overdue surfaces on Monday
    else later.push(task);
  }

  const tuitionByDay = new Map();
  for (const s of store.tuition) {
    if (!tuitionByDay.has(s.weekday)) tuitionByDay.set(s.weekday, []);
    tuitionByDay.get(s.weekday).push(s);
  }

  const todayIso = today();

  return `
    <div class="week">
      ${days.map((d) => {
        const key = iso(d);
        const items = (byDay.get(key) ?? []).sort(sortTasks);
        const sessions = tuitionByDay.get(d.getDay()) ?? [];
        return `
          <section class="week-day${key === todayIso ? " is-today" : ""}">
            <header>
              <span class="week-dow">${d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span class="week-date">${d.getDate()}</span>
            </header>
            ${sessions.map((s) => `
              <div class="tuition-chip">
                ${formatTime(s.start_time)} · ${esc(subjectName(s.subject))}
                ${s.tutor ? `<span class="muted"> · ${esc(s.tutor)}</span>` : ""}
              </div>`).join("")}
            <ul class="task-list compact">${items.map((t) => taskRow(t, { showSubject: true })).join("")}</ul>
            ${!items.length && !sessions.length ? '<p class="week-clear">—</p>' : ""}
          </section>`;
      }).join("")}
    </div>
    ${later.length ? section("Later", later) : ""}
    ${noDate.length ? section("No due date", noDate) : ""}`;
}

function section(title, items) {
  return `
    <section class="card plain">
      <header><h2>${esc(title)}</h2></header>
      <ul class="task-list">${items.sort(sortTasks).map((t) => taskRow(t, { showSubject: true })).join("")}</ul>
    </section>`;
}

/* ----------------------------------------------------------------- list -- */

function listView(tasks) {
  const pending = tasks.filter((t) => !t.done).sort(sortTasks);
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));

  const overdue = pending.filter((t) => t.due && t.due < today());
  const soon = pending.filter((t) => t.due && t.due >= today() && t.due <= iso(addDays(new Date(), 7)));
  const rest = pending.filter((t) => !overdue.includes(t) && !soon.includes(t));

  return [
    overdue.length ? section("Overdue", overdue) : "",
    soon.length ? section("This week", soon) : "",
    rest.length ? section("Later", rest) : "",
    done.length ? section("Completed", done.slice(0, 40)) : "",
  ].join("") || emptyState({ title: "All clear", message: "Nothing pending in this tab." });
}

/* ------------------------------------------------------------ task form -- */

export function openTaskForm(task = null, presetSubject = null, presetDue = null) {
  const editing = !!task;
  const subjects = mySubjectRows();
  const list = subjects.length ? subjects : store.subjects;
  const selected = task?.subject ?? presetSubject ?? store.prefs.lastSubject ?? list[0]?.code;
  const dueValue = task?.due ?? presetDue ?? "";

  openModal({
    title: editing ? "Edit task" : "Add a task",
    width: "wide",
    body: `
      <form id="taskForm" class="form-grid">
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
              <input type="radio" name="tSource" id="src-${s.id}" value="${s.id}"
                ${(task?.source ?? store.prefs.source ?? "school") === s.id ? "checked" : ""}>
              <label class="chip-toggle" for="src-${s.id}">${s.label}</label>`).join("")}
          </div>
        </div>

        <div class="field">
          <span>Type</span>
          <div class="chip-row">
            ${TASK_TYPES.map((t) => `
              <input type="radio" name="tType" id="type-${t.id}" value="${t.id}"
                ${(task?.type ?? "homework") === t.id ? "checked" : ""}>
              <label class="chip-toggle ${t.id}" for="type-${t.id}">${t.label}</label>`).join("")}
          </div>
        </div>

        <label class="field span-2">
          <span>Task</span>
          <input type="text" id="tText" data-autofocus autocomplete="off"
                 placeholder="e.g. Textbook pg 41, Q1–9" value="${esc(task?.text ?? "")}">
        </label>

        <label class="field span-2">
          <span>Notes <span class="muted">(optional)</span></span>
          <textarea id="tNotes" rows="2" placeholder="Anything you'll want to remember">${esc(task?.notes ?? "")}</textarea>
        </label>

        <label class="field">
          <span>Due date</span>
          <input type="date" id="tDue" value="${esc(dueValue)}">
        </label>

        <label class="field">
          <span>Due time <span class="muted">(optional)</span></span>
          <input type="time" id="tTime" value="${esc((task?.due_time ?? "").slice(0, 5))}">
        </label>

        <label class="field">
          <span>Estimate <span class="muted">(minutes)</span></span>
          <input type="number" id="tEstimate" min="5" step="5" placeholder="45" value="${esc(task?.estimate_min ?? "")}">
        </label>

        <div class="field">
          <span>Priority</span>
          <div class="chip-row">
            ${[[0, "Low"], [1, "Normal"], [2, "High"]].map(([v, l]) => `
              <input type="radio" name="tPriority" id="pri-${v}" value="${v}"
                ${(task?.priority ?? 1) === v ? "checked" : ""}>
              <label class="chip-toggle" for="pri-${v}">${l}</label>`).join("")}
          </div>
        </div>

        <div class="chips span-2" id="quickDates">
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
        const fields = {
          subject: q("#tSubject").value,
          source: dialog.querySelector('input[name="tSource"]:checked')?.value ?? "school",
          type: dialog.querySelector('input[name="tType"]:checked')?.value ?? "homework",
          priority: Number(dialog.querySelector('input[name="tPriority"]:checked')?.value ?? 1),
          text,
          notes: q("#tNotes").value.trim() || null,
          due: q("#tDue").value || null,
          dueTime: q("#tTime").value || null,
          estimateMin: Number(q("#tEstimate").value) || null,
        };

        const save = q("#taskSave");
        save.disabled = true;
        save.textContent = "Saving…";
        try {
          if (editing) {
            await updateTask(task.id, {
              subject: fields.subject,
              source: fields.source,
              type: fields.type,
              priority: fields.priority,
              text: fields.text,
              notes: fields.notes,
              due: fields.due,
              due_time: fields.dueTime,
              estimate_min: fields.estimateMin,
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

/** Used by the mark/progress views to turn a weakness into a revision task. */
export async function addRevisionTask({ subject, topic, text, due, originRef }) {
  await createTask({
    subject,
    type: "revision",
    source: "self",
    text,
    topic,
    due: due ?? iso(addDays(new Date(), 3)),
    origin: "ai",
    originRef,
    priority: 2,
  });
  toast("Added to your planner.");
}

/** Called after sign-in so the planner is warm when it is first opened. */
export function invalidate() {
  loaded = false;
}

export const refresh = debounce(() => {
  if (root?.isConnected) paint();
}, 100);
