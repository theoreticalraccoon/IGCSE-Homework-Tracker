/**
 * Sign in, sign up, password reset, and first-run subject selection.
 *
 * These render into their own full-screen container rather than the app
 * outlet, because the shell (sidebar, nav) must not be visible before there is
 * a signed-in user to show it to.
 */

import { esc, byId, on, debounce } from "../ui/dom.js";
import { toast } from "../ui/feedback.js";
import { sb } from "../api/client.js";
import { store } from "../store.js";
import { saveProfile } from "../api/data.js";
import { APP_NAME, APP_TAGLINE } from "../config.js";

let mode = "signin";

/* ------------------------------------------------------------------ auth -- */

export function renderAuth() {
  const screen = byId("authScreen");
  screen.innerHTML = `
    <div class="auth-card">
      <div class="brand-mark">
        <span class="brand-glyph" aria-hidden="true">✓</span>
        <span class="brand-name">${esc(APP_NAME)}</span>
      </div>
      <p class="brand-tagline">${esc(APP_TAGLINE)}</p>

      <h1 id="authTitle">Sign in</h1>
      <p class="auth-sub" id="authSub">Welcome back — pick up where you left off.</p>

      <form id="authForm" novalidate>
        <label class="field">
          <span>Email</span>
          <input type="email" id="authEmail" autocomplete="email" autocapitalize="none"
                 spellcheck="false" placeholder="you@example.com" data-autofocus>
        </label>
        <label class="field">
          <span>Password</span>
          <span class="pw-wrap">
            <input type="password" id="authPassword" autocomplete="current-password" placeholder="••••••••">
            <button type="button" class="pw-toggle" id="pwToggle" aria-label="Show password">Show</button>
          </span>
        </label>
        <button type="submit" class="btn-primary block" id="authSubmit">Sign in</button>
        <p class="auth-msg" id="authMsg" role="status" aria-live="polite"></p>
        <p class="auth-forgot" id="authForgotWrap">
          <button type="button" class="link-btn" id="authForgot">Forgot your password?</button>
        </p>
      </form>

      <p class="auth-foot" id="authFoot"></p>
    </div>`;

  applyMode();

  byId("authForm").addEventListener("submit", submit);
  byId("authForgot").addEventListener("click", forgot);
  wirePwToggle("pwToggle", "authPassword");
}

function applyMode() {
  const up = mode === "signup";
  byId("authTitle").textContent = up ? "Create your account" : "Sign in";
  byId("authSub").textContent = up
    ? "One quick step and you're in."
    : "Welcome back — pick up where you left off.";
  byId("authSubmit").textContent = up ? "Create account" : "Sign in";
  byId("authPassword").setAttribute("autocomplete", up ? "new-password" : "current-password");
  byId("authForgotWrap").hidden = up;
  byId("authFoot").innerHTML = up
    ? 'Already have an account? <button type="button" class="link-btn" id="authSwitch">Sign in</button>'
    : 'New here? <button type="button" class="link-btn" id="authSwitch">Create an account</button>';
  byId("authSwitch").addEventListener("click", () => {
    mode = up ? "signin" : "signup";
    applyMode();
    byId("authEmail").focus();
  });
  setMsg("");
}

function setMsg(text, kind = "") {
  const el = byId("authMsg");
  el.textContent = text ?? "";
  el.className = `auth-msg${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
  const btn = byId("authSubmit");
  btn.disabled = busy;
  btn.textContent = busy
    ? mode === "signup" ? "Creating…" : "Signing in…"
    : mode === "signup" ? "Create account" : "Sign in";
}

async function submit(e) {
  e.preventDefault();
  const email = byId("authEmail").value.trim();
  const password = byId("authPassword").value;

  if (!email) return setMsg("Enter your email.", "error");
  if (!password) return setMsg("Enter your password.", "error");
  if (mode === "signup" && password.length < 6) {
    return setMsg("Use a password of at least 6 characters.", "error");
  }

  setBusy(true);
  setMsg("");
  try {
    if (mode === "signup") {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        setMsg("Account created. Check your email to confirm, then sign in.", "ok");
        mode = "signin";
        applyMode();
      }
      // With confirmation off, onAuthStateChange takes over from here.
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setMsg(friendly(err), "error");
  } finally {
    setBusy(false);
  }
}

async function forgot() {
  const email = byId("authEmail").value.trim();
  if (!email) {
    setMsg("Enter your email above first.", "error");
    byId("authEmail").focus();
    return;
  }
  const btn = byId("authForgot");
  btn.disabled = true;
  try {
    const redirect = location.href.split("#")[0].split("?")[0];
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect });
    if (error) throw error;
    setMsg("If that email has an account, a reset link is on its way.", "ok");
  } catch (err) {
    setMsg(friendly(err), "error");
  } finally {
    btn.disabled = false;
  }
}

function friendly(err) {
  const m = (err?.message ?? String(err)).toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match.";
  if (m.includes("already registered")) return "That email already has an account — sign in instead.";
  if (m.includes("email not confirmed")) return "Confirm your email first — check your inbox.";
  if (m.includes("password should be at least")) return "Use a password of at least 6 characters.";
  if (m.includes("invalid email") || m.includes("unable to validate email")) return "That email doesn't look right.";
  if (m.includes("signups not allowed")) return "Sign-ups are turned off for this deployment.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts — wait a moment.";
  return err?.message ?? "Something went wrong.";
}

function wirePwToggle(buttonId, inputId) {
  byId(buttonId).addEventListener("click", function () {
    const input = byId(inputId);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    this.textContent = show ? "Hide" : "Show";
    this.setAttribute("aria-label", show ? "Hide password" : "Show password");
    input.focus();
  });
}

/* -------------------------------------------------------------- recovery -- */

export function renderRecovery(onDone) {
  const screen = byId("recoveryScreen");
  screen.innerHTML = `
    <div class="auth-card">
      <h1>Set a new password</h1>
      <p class="auth-sub">Choose a new password for your account.</p>
      <form id="recoveryForm" novalidate>
        <label class="field">
          <span>New password</span>
          <span class="pw-wrap">
            <input type="password" id="recoveryPassword" autocomplete="new-password" placeholder="••••••••" data-autofocus>
            <button type="button" class="pw-toggle" id="recoveryPwToggle" aria-label="Show password">Show</button>
          </span>
        </label>
        <button type="submit" class="btn-primary block" id="recoverySubmit">Update password</button>
        <p class="auth-msg" id="recoveryMsg" role="status" aria-live="polite"></p>
      </form>
      <p class="auth-foot">
        <button type="button" class="link-btn" id="recoveryCancel">Back to sign in</button>
      </p>
    </div>`;

  wirePwToggle("recoveryPwToggle", "recoveryPassword");

  byId("recoveryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = byId("recoveryPassword").value;
    const msg = byId("recoveryMsg");
    if (value.length < 6) {
      msg.textContent = "Use a password of at least 6 characters.";
      msg.className = "auth-msg error";
      return;
    }
    const btn = byId("recoverySubmit");
    btn.disabled = true;
    btn.textContent = "Updating…";
    const { data, error } = await sb.auth.updateUser({ password: value });
    if (error) {
      msg.textContent = friendly(error);
      msg.className = "auth-msg error";
      btn.disabled = false;
      btn.textContent = "Update password";
      return;
    }
    toast("Password updated.");
    onDone(data?.user ?? null);
  });

  byId("recoveryCancel").addEventListener("click", async () => {
    await sb.auth.signOut().catch(() => {});
    onDone(null);
  });
}

/* ------------------------------------------------------------ onboarding -- */

export function renderOnboarding(onDone) {
  const screen = byId("onboardScreen");
  screen.innerHTML = `
    <div class="auth-card onboard-card">
      <h1>Choose your subjects</h1>
      <p class="auth-sub">
        Pick what you take. Subjects with ingested past papers are marked — those are the
        ones Markwise can mark and quiz you on.
      </p>
      <input type="search" id="onboardSearch" placeholder="Search subjects…" autocomplete="off" data-autofocus>
      <div class="subj-grid" id="onboardGrid"></div>
      <div class="onboard-foot">
        <span class="subj-count" id="onboardCount">0 selected</span>
        <button type="button" class="btn-primary" id="onboardContinue" disabled>Continue</button>
      </div>
      <p class="auth-msg" id="onboardMsg" role="status" aria-live="polite"></p>
    </div>`;

  const grid = byId("onboardGrid");
  const chosen = new Set(store.mySubjects);

  grid.innerHTML = store.subjects
    .map((s) => {
      const cov = store.coverage.find((c) => c.subject_code === s.code && c.questions > 0);
      return `
        <label class="subj${chosen.has(s.code) ? " on" : ""}" data-name="${esc(s.name.toLowerCase())}">
          <input type="checkbox" value="${esc(s.code)}"${chosen.has(s.code) ? " checked" : ""}>
          <span>
            ${esc(s.name)}
            ${cov ? '<span class="subj-corpus">✓ papers</span>' : ""}
          </span>
        </label>`;
    })
    .join("");

  const count = byId("onboardCount");
  const button = byId("onboardContinue");

  const refresh = () => {
    const n = grid.querySelectorAll("input:checked").length;
    count.textContent = `${n} selected`;
    button.disabled = n === 0;
  };
  refresh();

  grid.addEventListener("change", (e) => {
    const cb = e.target.closest("input");
    if (!cb) return;
    cb.closest(".subj")?.classList.toggle("on", cb.checked);
    refresh();
  });

  byId("onboardSearch").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim().toLowerCase();
      grid.querySelectorAll(".subj").forEach((el) => {
        el.hidden = q && !el.dataset.name.includes(q);
      });
    }, 150),
  );

  button.addEventListener("click", async () => {
    const subjects = [...grid.querySelectorAll("input:checked")].map((i) => i.value);
    if (!subjects.length) return;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await saveProfile({ subjects });
      onDone();
    } catch (e) {
      button.disabled = false;
      button.textContent = "Continue";
      const msg = byId("onboardMsg");
      msg.textContent = e.message;
      msg.className = "auth-msg error";
    }
  });
}
