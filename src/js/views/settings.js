/**
 * Settings: subjects, appearance, allowance, account.
 *
 * The allowance is shown rather than hidden until it runs out: Markwise runs on
 * a free Gemini tier shared by everyone on the deployment, and a student who
 * can see the budget spends it better than one who hits a wall.
 */

import { esc, on, debounce } from "../ui/dom.js";
import { toast, confirmModal, openModal, closeModal, spinner } from "../ui/feedback.js";
import { store, coverageFor } from "../store.js";
import { saveProfile, loadUsage } from "../api/data.js";
import { sb } from "../api/client.js";
import { applyTheme, currentTheme } from "../theme.js";
import { invalidate as invalidatePlanner } from "./planner.js";
import { navigate } from "../router.js";

let root = null;

export async function render(container) {
  root = container;
  container.innerHTML = `
    <header class="view-head"><div><h1>Settings</h1></div></header>

    <section class="card plain">
      <header><h2>Your subjects</h2><span class="muted" id="subjCount"></span></header>
      <input type="search" id="subjSearch" placeholder="Search subjects…" autocomplete="off">
      <div class="subj-grid" id="subjGrid"></div>
      <div class="card-actions">
        <button class="btn-primary" id="saveSubjects">Save subjects</button>
      </div>
    </section>

    <section class="card plain">
      <header><h2>Appearance</h2></header>
      <div class="chip-row" id="themeRow">
        ${["system", "light", "dark"].map((t) => `
          <input type="radio" name="theme" id="theme-${t}" value="${t}"${currentTheme() === t ? " checked" : ""}>
          <label class="chip-toggle" for="theme-${t}">${t[0].toUpperCase()}${t.slice(1)}</label>`).join("")}
      </div>
    </section>

    <section class="card plain">
      <header>
        <h2>What you can do today</h2>
      </header>
      <div id="usagePanel">${spinner("Checking…")}</div>
      <p class="field-hint">
        Markwise runs on a free AI allowance that resets every night, so that one heavy
        session doesn't use up everyone else's.
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
  await paintUsage();
}

function wire() {
  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));

  root.querySelector("#themeRow").addEventListener("change", (e) => {
    const radio = e.target.closest('input[name="theme"]');
    if (radio) applyTheme(radio.value, { persist: true });
  });

  root.querySelector("#subjSearch").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll("#subjGrid .subj").forEach((el) => {
        el.hidden = q && !el.dataset.name.includes(q);
      });
    }, 150),
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

  root.querySelector("#changePassword").addEventListener("click", openPasswordForm);

  root.querySelector("#signOutBtn").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Sign out",
      message: "You'll need to sign in again on this device.",
      confirmLabel: "Sign out",
    });
    if (ok) await sb.auth.signOut();
  });
}

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
            ${cov ? '<span class="subj-corpus">papers added</span>' : ""}
          </span>
        </label>`;
    })
    .join("");
  updateCount();
}

function updateCount() {
  const n = root.querySelectorAll("#subjGrid input:checked").length;
  root.querySelector("#subjCount").textContent = `${n} selected`;
}

async function paintUsage() {
  const panel = root.querySelector("#usagePanel");
  const rows = await loadUsage();
  if (!rows.length) {
    panel.innerHTML = '<p class="muted">No limits are set on this deployment.</p>';
    return;
  }
  const names = {
    ask: "Questions asked",
    mark: "Answers marked",
    mock: "Mock papers made",
    markpaper: "Papers marked",
    ingest: "Papers added",
    similar: "Similar-question searches",
  };
  panel.innerHTML = `
    <div class="usage-grid">
      ${rows.map((r) => {
        const left = Math.max(0, r.per_day - r.used);
        const pct = r.per_day ? Math.round((r.used / r.per_day) * 100) : 0;
        return `
          <div class="usage-row">
            <span class="usage-label">${esc(names[r.route] ?? r.route)}</span>
            <span class="bar"><span style="width:${Math.min(100, pct)}%" class="${pct >= 90 ? "poor" : pct >= 60 ? "mid" : "good"}"></span></span>
            <span class="usage-count">${left} left</span>
          </div>`;
      }).join("")}
    </div>`;
}

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
