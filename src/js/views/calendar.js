/**
 * Calendar — deadlines and tuition on one month grid.
 *
 * The workload heatmap is the point: a month where three assessments land in
 * the same week is invisible on a task list and obvious here, early enough to
 * do something about it.
 */

import { esc, on } from "../ui/dom.js";
import { toast } from "../ui/feedback.js";
import { store, subjectName } from "../store.js";
import { loadTasks, loadTuition } from "../api/data.js";
import { iso, today, monthGrid, formatTime, minutesToHuman } from "../lib/dates.js";
import { openTaskForm } from "./planner.js";

let root = null;
let cursor = new Date();

export async function render(container) {
  root = container;
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);

  container.innerHTML = `
    <header class="view-head">
      <div>
        <h1>Calendar</h1>
        <p class="view-sub">Deadlines, assessments and tuition, with the crunch weeks visible.</p>
      </div>
      <div class="view-actions">
        <div class="segmented">
          <button type="button" id="prevMonth" aria-label="Previous month">‹</button>
          <button type="button" id="thisMonth">Today</button>
          <button type="button" id="nextMonth" aria-label="Next month">›</button>
        </div>
        <button class="btn-primary" id="calAdd">Add task</button>
      </div>
    </header>
    <div id="calBody"></div>`;

  root.querySelector("#prevMonth").addEventListener("click", () => shift(-1));
  root.querySelector("#nextMonth").addEventListener("click", () => shift(1));
  root.querySelector("#thisMonth").addEventListener("click", () => {
    cursor = new Date();
    cursor.setDate(1);
    paint();
  });
  root.querySelector("#calAdd").addEventListener("click", () => openTaskForm());

  on(root, "click", "[data-day-add]", (_, btn) => openTaskForm(null, null, btn.dataset.dayAdd));
  on(root, "click", "[data-day]", (_, btn) => showDay(btn.dataset.day));

  if (!store.tasks.length || !store.tuition.length) {
    try {
      await Promise.all([store.tasks.length ? null : loadTasks(), loadTuition()]);
    } catch (e) {
      toast(e.message, "error");
    }
  }
  paint();
}

function shift(months) {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + months, 1);
  paint();
}

function paint() {
  const weeks = monthGrid(cursor);
  const byDay = new Map();
  for (const task of store.tasks) {
    if (!task.due || task.done) continue;
    if (!byDay.has(task.due)) byDay.set(task.due, []);
    byDay.get(task.due).push(task);
  }

  const tuitionByWeekday = new Map();
  for (const s of store.tuition) {
    if (!tuitionByWeekday.has(s.weekday)) tuitionByWeekday.set(s.weekday, []);
    tuitionByWeekday.get(s.weekday).push(s);
  }

  // Load is weighted: an assessment costs more than a homework, and an
  // estimate in minutes beats both when the student has given one.
  const load = (tasks) =>
    tasks.reduce((n, t) => n + (t.estimate_min ? t.estimate_min / 30 : t.type === "assessment" ? 3 : 1), 0);

  const todayIso = today();
  const month = cursor.getMonth();

  root.querySelector("#calBody").innerHTML = `
    <p class="cal-month">${cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
    <div class="calendar">
      <div class="cal-head">
        ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span>${d}</span>`).join("")}
      </div>
      ${weeks.map((week) => `
        <div class="cal-week">
          ${week.map((date) => {
            const key = iso(date);
            const tasks = (byDay.get(key) ?? []).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
            const sessions = tuitionByWeekday.get(date.getDay()) ?? [];
            const heat = Math.min(4, Math.round(load(tasks)));
            return `
              <div class="cal-day heat-${heat}${date.getMonth() !== month ? " outside" : ""}${key === todayIso ? " is-today" : ""}">
                <button class="cal-date" data-day="${key}">
                  ${date.getDate()}
                </button>
                ${sessions.map((s) => `<span class="cal-tuition">${formatTime(s.start_time)} ${esc(subjectName(s.subject))}</span>`).join("")}
                ${tasks.slice(0, 3).map((t) => `
                  <span class="cal-task ${esc(t.type)}" title="${esc(t.text)}">
                    ${esc(subjectName(t.subject))}
                  </span>`).join("")}
                ${tasks.length > 3 ? `<span class="cal-more">+${tasks.length - 3}</span>` : ""}
                <button class="cal-add" data-day-add="${key}" aria-label="Add task on ${key}">+</button>
              </div>`;
          }).join("")}
        </div>`).join("")}
    </div>
    <p class="cal-legend">
      <span class="swatch heat-1"></span> light
      <span class="swatch heat-2"></span>
      <span class="swatch heat-3"></span>
      <span class="swatch heat-4"></span> heavy
    </p>`;
}

function showDay(key) {
  const tasks = store.tasks.filter((t) => t.due === key && !t.done);
  if (!tasks.length) {
    openTaskForm(null, null, key);
    return;
  }
  const total = tasks.reduce((n, t) => n + (t.estimate_min ?? 0), 0);
  import("../ui/feedback.js").then(({ openModal }) => {
    openModal({
      title: new Date(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
      body: `
        ${total ? `<p class="muted">About ${minutesToHuman(total)} of work.</p>` : ""}
        <ul class="task-list">
          ${tasks.map((t) => `
            <li class="task">
              <div class="task-main">
                <span class="task-text">${esc(t.text)}</span>
                <span class="task-meta">${esc(subjectName(t.subject))} · ${esc(t.type)}</span>
              </div>
            </li>`).join("")}
        </ul>`,
      actions: `<button class="btn-ghost" data-modal-close>Close</button>`,
    });
  });
}
