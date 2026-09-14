/**
 * Settings — subjects, tuition timetable, appearance, AI allowance, account.
 *
 * The AI allowance panel is deliberately visible rather than hidden until it
 * runs out: the app runs on a free Gemini tier shared across everyone using
 * the deployment, and a student who can see the budget can spend it well.
 */

import { esc, on, debounce } from "../ui/dom.js";
import { toast, confirmModal, openModal, closeModal, spinner } from "../ui/feedback.js";
import { store, subjectName, coverageFor } from "../store.js";
import { saveProfile, loadUsage, loadTuition, createTuition, deleteTuition } from "../api/data.js";
import { sb } from "../api/client.js";
import { applyTheme, currentTheme } from "../theme.js";
import { WEEKDAYS } from "../config.js";
import { formatTime } from "../lib/dates.js";
import { invalidate as invalidatePlanner } from "./planner.js";

let root = null;

export async function render(container) {
  root = container;
  container.innerHTML = `
    <header class="view-head">
      <div><h1>Settings</h1></div>
    </header>

    <section class="card plain">
      <header><h2>Appearance</h2></header>
      <div class="chip-row" id="themeRow">
        ${["system", "light", "dark"].map((t) => `
          <input type="radio" name="theme" id="theme-${t}" value="${t}" ${currentTheme() === t ? "checked" : ""}>
          <label class="chip-toggle" for="theme-${t}">${t[0].toUpperCase()}${t.slice(1)}</label>`).join("")}
      </div>
    </section>

    <section class="card plain">
      <header>
        <h2>Your subjects</h2>
        <span class="muted" id="subjCount"></span>
      </header>
      <input type="search" id="subjSearch" placeholder="Search subjects…" autocomplete="off">
      <div class="subj-grid" id="subjGrid"></div>
      <div class="card-actions">
        <button class="btn-primary" id="saveSubjects">Save subjects</button>
      </div>
    </section>

    <section class="card plain">
      <header>
        <h2>Exam series</h2>
      </header>
      <label class="field">
        <span>Which series are you sitting?</span>
        <input type="text" id="examSession" placeholder="e.g. Jun 2027"
               value="${esc(store.profile?.exam_session ?? "")}">
      </label>
      <div class="card-actions">
        <button class="btn-ghost" id="saveSession">Save</button>
      </div>
    </section>

    <section class="card plain">
      <header>
        <h2>Tuition timetable</h2>
        <button class="btn-ghost small" id="addTuition">Add session</button>
      </header>
      <div id="tuitionList"></div>
    </section>

    <section class="card plain">
      <header><h2>AI allowance today</h2></header>
      <div id="usagePanel">${spinner("Checking…")}</div>
      <p class="field-hint">
        Markwise runs on Gemini's free tier. Limits reset at midnight UTC and exist so
        one heavy session does not exhaust the quota for everyone on this deployment.
      </p>
    </section>

    <section class="card plain">
      <header><h2>Account</h2></header>
      <p class="muted">${esc(store.user?.email ?? "")}</p>
      <div class="card-actions">
        <button class="btn-ghost" id="changePassword">Change password</button>
        <button class="btn-ghost" id="signOutBtn">Sign out</button>
      </div>
    </section>`;

  wire();
  paintSubjects();
  await Promise.all([paintUsage(), paintTuition()]);
}

function wire() {
  root.querySelector("#themeRow").addEventListener("change", (e) => {
    const radio = e.target.closest('input[name="theme"]');
    if (radio) applyTheme(radio.value, { persist: true });
  });

  root.querySelector("#subjSearch").addEventListener(
    "input",
    debounce((e) => filterSubjects(e.target.value), 150),
  );

  on(root, "change", "#subjGrid input", (_, cb) => {
    cb.closest(".subj")?.classList.toggle("on", cb.checked);
    updateCount();
  });

  root.querySelector("#saveSubjects").addEventListener("click", async (e) => {
    const chosen = [...root.querySelectorAll("#subjGrid input:checked")].map((i) => i.value);
    if (!chosen.length) {
      toast("Pick at least one subject.", "error");
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveProfile({ subjects: chosen });
      invalidatePlanner();
      toast("Subjects saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save subjects";
    }
  });

  root.querySelector("#saveSession").addEventListener("click", async () => {
    try {
      await saveProfile({ exam_session: root.querySelector("#examSession").value.trim() || null });
      toast("Saved.");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  root.querySelector("#addTuition").addEventListener("click", openTuitionForm);

  on(root, "click", "[data-del-tuition]", async (_, btn) => {
    try {
      await deleteTuition(btn.dataset.delTuition);
      paintTuition();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  root.querySelector("#changePassword").addEventListener("click", openPasswordForm);

  root.querySelector("#signOutBtn").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Sign out",
      message: "You will need to sign in again on this device.",
      confirmLabel: "Sign out",
    });
    if (ok) await sb.auth.signOut();
  });
}

/* -------------------------------------------------------------- subjects -- */

function paintSubjects() {
  const mine = new Set(store.mySubjects);
  root.querySelector("#subjGrid").innerHTML = store.subjects
    .map((s) => {
      const cov = coverageFor(s.code);
      return `
        <label class="subj${mine.has(s.code) ? " on" : ""}" data-name="${esc(s.name.toLowerCase())}">
          <input type="checkbox" value="${esc(s.code)}"${mine.has(s.code) ? " checked" : ""}>
          <span>
            ${esc(s.name)}
            <span class="subj-code">${esc(s.code)}</span>
            ${cov ? `<span class="subj-corpus" title="${cov.questions} questions ingested">✓ papers</span>` : ""}
          </span>
        </label>`;
    })
    .join("");
  updateCount();
}

function filterSubjects(query) {
  const q = query.trim().toLowerCase();
  root.querySelectorAll("#subjGrid .subj").forEach((el) => {
    el.hidden = q && !el.dataset.name.includes(q);
  });
}

function updateCount() {
  const n = root.querySelectorAll("#subjGrid input:checked").length;
  root.querySelector("#subjCount").textContent = `${n} selected`;
}

/* --------------------------------------------------------------- tuition -- */

async function paintTuition() {
  const list = root.querySelector("#tuitionList");
  try {
    await loadTuition();
  } catch (e) {
    list.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  list.innerHTML = store.tuition.length
    ? `<ul class="tuition-list">
        ${store.tuition.map((t) => `
          <li>
            <span class="tuition-day">${WEEKDAYS[t.weekday]}</span>
            <span class="tuition-time">${formatTime(t.start_time)}${t.end_time ? `–${formatTime(t.end_time)}` : ""}</span>
            <span class="tuition-subject">${esc(subjectName(t.subject))}</span>
            <span class="muted">${esc(t.tutor ?? "")}${t.location ? ` · ${esc(t.location)}` : ""}</span>
            <button class="icon-btn" data-del-tuition="${esc(t.id)}" aria-label="Remove session">&times;</button>
          </li>`).join("")}
      </ul>`
    : '<p class="muted">No tuition sessions yet. Add them and they appear on your week and calendar.</p>';
}

function openTuitionForm() {
  const subjects = store.subjects.filter((s) => store.mySubjects.includes(s.code));
  openModal({
    title: "Add a tuition session",
    body: `
      <form id="tuitionForm" class="form-grid">
        <label class="field">
          <span>Subject</span>
          <select id="tuSubject">
            ${(subjects.length ? subjects : store.subjects)
              .map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Day</span>
          <select id="tuDay">
            ${WEEKDAYS.map((d, i) => `<option value="${i}"${i === 6 ? " selected" : ""}>${d}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Starts</span><input type="time" id="tuStart" value="16:00" data-autofocus></label>
        <label class="field"><span>Ends <span class="muted">(optional)</span></span><input type="time" id="tuEnd"></label>
        <label class="field"><span>Tutor <span class="muted">(optional)</span></span><input type="text" id="tuTutor"></label>
        <label class="field"><span>Place <span class="muted">(optional)</span></span><input type="text" id="tuPlace"></label>
      </form>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="tuSave">Add session</button>`,
    onMount(dialog) {
      dialog.querySelector("#tuSave").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await createTuition({
            subject: dialog.querySelector("#tuSubject").value,
            weekday: Number(dialog.querySelector("#tuDay").value),
            start_time: dialog.querySelector("#tuStart").value,
            end_time: dialog.querySelector("#tuEnd").value || null,
            tutor: dialog.querySelector("#tuTutor").value.trim() || null,
            location: dialog.querySelector("#tuPlace").value.trim() || null,
          });
          closeModal();
          paintTuition();
        } catch (err) {
          btn.disabled = false;
          toast(err.message, "error");
        }
      });
    },
  });
}

/* ----------------------------------------------------------------- usage -- */

async function paintUsage() {
  const panel = root.querySelector("#usagePanel");
  const rows = await loadUsage();
  if (!rows.length) {
    panel.innerHTML = '<p class="muted">Usage tracking is not set up on this deployment.</p>';
    return;
  }
  const names = { ask: "Questions asked", mark: "Answers marked", mock: "Mocks generated", similar: "Similar searches" };
  panel.innerHTML = `
    <div class="usage-grid">
      ${rows.map((r) => {
        const pct = r.per_day ? Math.round((r.used / r.per_day) * 100) : 0;
        return `
          <div class="usage-row">
            <span class="usage-label">${esc(names[r.route] ?? r.route)}</span>
            <span class="bar"><span style="width:${Math.min(100, pct)}%" class="${pct >= 90 ? "poor" : pct >= 60 ? "mid" : "good"}"></span></span>
            <span class="usage-count">${r.used} / ${r.per_day}</span>
          </div>`;
      }).join("")}
    </div>`;
}

/* -------------------------------------------------------------- password -- */

function openPasswordForm() {
  openModal({
    title: "Change password",
    body: `
      <label class="field">
        <span>New password</span>
        <input type="password" id="newPw" autocomplete="new-password" data-autofocus placeholder="At least 6 characters">
      </label>
      <p class="auth-msg" id="pwMsg" role="status"></p>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="pwSave">Update</button>`,
    onMount(dialog) {
      dialog.querySelector("#pwSave").addEventListener("click", async (e) => {
        const value = dialog.querySelector("#newPw").value;
        const msg = dialog.querySelector("#pwMsg");
        if (value.length < 6) {
          msg.textContent = "Use at least 6 characters.";
          msg.className = "auth-msg error";
          return;
        }
        e.currentTarget.disabled = true;
        const { error } = await sb.auth.updateUser({ password: value });
        if (error) {
          msg.textContent = error.message;
          msg.className = "auth-msg error";
          e.currentTarget.disabled = false;
          return;
        }
        closeModal();
        toast("Password updated.");
      });
    },
  });
}
