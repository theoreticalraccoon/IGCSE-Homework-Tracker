/**
 * Today — the landing screen.
 *
 * Answers one question in one screen: what should I do right now? It pulls the
 * three things that decide that — what is due, what you are weakest at, and
 * what is left of today's AI allowance — and makes each one actionable in a
 * single click.
 */

import { esc, on } from "../ui/dom.js";
import { emptyState, skeleton, toast } from "../ui/feedback.js";
import { store, subjectName, groundedSubjects } from "../store.js";
import { loadTasks, loadTuition, weakTopics, loadAttempts, loadUsage } from "../api/data.js";
import { today, iso, addDays, dueLabel, formatTime, daysUntil } from "../lib/dates.js";
import { openTaskForm, addRevisionTask } from "./planner.js";
import { navigate } from "../router.js";
import { APP_NAME } from "../config.js";

let root = null;

export async function render(container) {
  root = container;
  container.innerHTML = `
    <header class="view-head">
      <div>
        <h1 id="greeting">Today</h1>
        <p class="view-sub" id="todaySub"></p>
      </div>
      <div class="view-actions">
        <button class="btn-ghost" data-goto="ask">Ask a question</button>
        <button class="btn-primary" id="todayAdd">Add task</button>
      </div>
    </header>
    <div id="todayBody">${skeleton(4)}</div>`;

  root.querySelector("#todayAdd").addEventListener("click", () => openTaskForm());
  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));
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
  const body = root.querySelector("#todayBody");

  let weak = [];
  let attempts = [];
  try {
    await Promise.all([
      store.tasks.length ? null : loadTasks(),
      loadTuition(),
      loadUsage(),
    ]);
    [weak, attempts] = await Promise.all([weakTopics(null, 3), loadAttempts({ limit: 5 })]);
  } catch (e) {
    // Partial data is still worth showing; only a total failure is an error.
    console.warn(e);
  }

  const name = store.profile?.display_name || (store.user?.email ?? "").split("@")[0];
  root.querySelector("#greeting").textContent = `${greeting()}${name ? `, ${name}` : ""}`;

  const todayIso = today();
  const weekEnd = iso(addDays(new Date(), 7));
  const pending = store.tasks.filter((t) => !t.done);
  const overdue = pending.filter((t) => t.due && t.due < todayIso);
  const dueToday = pending.filter((t) => t.due === todayIso);
  const thisWeek = pending.filter((t) => t.due && t.due > todayIso && t.due <= weekEnd);
  const sessionsToday = store.tuition.filter((s) => s.weekday === new Date().getDay());

  root.querySelector("#todaySub").textContent = summarise(overdue, dueToday, thisWeek);

  const examCountdown = examDays();

  body.innerHTML = `
    ${examCountdown !== null ? `
      <div class="countdown ${examCountdown < 30 ? "urgent" : ""}">
        <strong>${examCountdown}</strong> day${examCountdown === 1 ? "" : "s"} until ${esc(store.profile.exam_session)}
      </div>` : ""}

    <div class="today-grid">
      <section class="card plain">
        <header>
          <h2>Due now</h2>
          <button class="link-btn" data-goto="planner">Open planner</button>
        </header>
        ${overdue.length || dueToday.length
          ? `<ul class="task-list">
              ${[...overdue, ...dueToday].slice(0, 8).map(row).join("")}
            </ul>`
          : '<p class="clear-msg">Nothing due today.</p>'}
      </section>

      <section class="card plain">
        <header><h2>Coming up</h2></header>
        ${sessionsToday.length
          ? `<div class="today-tuition">
              ${sessionsToday.map((s) => `
                <span class="tuition-chip">${formatTime(s.start_time)} · ${esc(subjectName(s.subject))}</span>`).join("")}
            </div>` : ""}
        ${thisWeek.length
          ? `<ul class="task-list">${thisWeek.slice(0, 8).map(row).join("")}</ul>`
          : '<p class="clear-msg">Nothing else this week.</p>'}
      </section>

      <section class="card plain">
        <header>
          <h2>Practise what you are weakest at</h2>
          <button class="link-btn" data-goto="progress">Full progress</button>
        </header>
        ${weak.length
          ? `<div class="topic-bars">
              ${weak.map((w) => {
                const pct = Number(w.pct ?? 0);
                return `
                  <div class="topic-bar">
                    <span class="topic-name">${esc(w.topic)} <span class="muted">${esc(subjectName(w.subject_code))}</span></span>
                    <span class="bar"><span style="width:${pct}%" class="${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}"></span></span>
                    <span class="topic-score">${pct}%</span>
                    <button class="link-btn" data-revise="${esc(w.topic)}" data-subject="${esc(w.subject_code)}">Plan it</button>
                  </div>`;
              }).join("")}
              <button class="btn-ghost block" data-goto="mock">Build a mock on these</button>
            </div>`
          : emptyState({
              title: groundedSubjects().length ? "No data yet" : "No papers ingested yet",
              message: groundedSubjects().length
                ? "Get an answer marked and Markwise starts mapping your weak topics."
                : `${APP_NAME} needs a corpus before it can mark anything. See the ingestion guide in the README.`,
              action: groundedSubjects().length
                ? '<button class="btn-primary" data-goto="mark">Mark an answer</button>'
                : "",
            })}
      </section>

      <section class="card plain">
        <header><h2>Recently marked</h2></header>
        ${attempts.length
          ? `<ul class="attempt-list compact">
              ${attempts.map((a) => {
                const pct = a.total ? Math.round((a.awarded / a.total) * 100) : 0;
                return `
                  <li>
                    <button data-goto="progress">
                      <span class="attempt-ref">${esc(a.question_ref ?? "Question")}</span>
                      <span class="attempt-score ${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}">${a.awarded}/${a.total}</span>
                    </button>
                  </li>`;
              }).join("")}
            </ul>`
          : '<p class="clear-msg">Nothing marked yet.</p>'}
      </section>
    </div>`;
}

function row(task) {
  const due = dueLabel(task.due);
  return `
    <li class="task">
      <div class="task-main">
        <span class="task-text">${esc(task.text)}</span>
        <span class="task-meta">${esc(subjectName(task.subject))} · ${esc(task.type)}</span>
      </div>
      ${due ? `<span class="due ${due.cls}">${due.text}</span>` : ""}
    </li>`;
}

function summarise(overdue, dueToday, thisWeek) {
  const bits = [];
  if (overdue.length) bits.push(`${overdue.length} overdue`);
  if (dueToday.length) bits.push(`${dueToday.length} due today`);
  if (thisWeek.length) bits.push(`${thisWeek.length} later this week`);
  return bits.length ? bits.join(" · ") : "You are clear.";
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Days until the exam series, when the student has told us which one. */
function examDays() {
  const session = store.profile?.exam_session;
  if (!session) return null;
  const m = String(session).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(20\d{2})/i);
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(m[1].toLowerCase().slice(0, 3));
  const days = daysUntil(iso(new Date(Number(m[2]), month, 1)));
  return days !== null && days > 0 ? days : null;
}
