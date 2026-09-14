/** Toasts, modals, and the inline empty/error states every view shares. */

import { byId, esc, on } from "./dom.js";

let toastTimer = null;

export function toast(message, kind = "") {
  const el = byId("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast${kind ? ` ${kind}` : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === "error" ? 5200 : 3000);
}

/* ----------------------------------------------------------------- modal -- */

let closeCurrent = null;

/**
 * Open a modal. `body` is HTML; `onMount` receives the dialog element so the
 * caller can wire its own controls.
 */
export function openModal({ title, body, actions = "", onMount, width = "" }) {
  closeModal();
  const overlay = byId("modalOverlay");
  overlay.innerHTML = `
    <div class="modal ${width}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-head">
        <h2 id="modalTitle">${esc(title)}</h2>
        <button class="icon-btn" data-modal-close aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">${body}</div>
      ${actions ? `<div class="modal-actions">${actions}</div>` : ""}
    </div>`;
  overlay.hidden = false;
  document.body.classList.add("modal-open");

  const previous = document.activeElement;
  const dialog = overlay.querySelector(".modal");

  const offClick = on(overlay, "click", "[data-modal-close]", closeModal);
  const backdrop = (e) => {
    if (e.target === overlay) closeModal();
  };
  const key = (e) => {
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab") trapFocus(e, dialog);
  };
  overlay.addEventListener("click", backdrop);
  document.addEventListener("keydown", key);

  closeCurrent = () => {
    offClick();
    overlay.removeEventListener("click", backdrop);
    document.removeEventListener("keydown", key);
    overlay.hidden = true;
    overlay.innerHTML = "";
    document.body.classList.remove("modal-open");
    if (previous?.focus) previous.focus();
    closeCurrent = null;
  };

  onMount?.(dialog);
  (dialog.querySelector("[data-autofocus]") ?? dialog.querySelector("button, input, select, textarea"))?.focus();
  return closeCurrent;
}

export function closeModal() {
  closeCurrent?.();
}

function trapFocus(e, dialog) {
  const focusable = [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Yes/no, resolved as a promise so callers read top-to-bottom. */
export function confirmModal({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title,
      body: `<p class="muted">${esc(message)}</p>`,
      actions: `
        <button class="btn-ghost" data-no>Cancel</button>
        <button class="${danger ? "btn-danger" : "btn-primary"}" data-yes data-autofocus>${esc(confirmLabel)}</button>`,
      onMount(dialog) {
        dialog.querySelector("[data-yes]").addEventListener("click", () => finish(true));
        dialog.querySelector("[data-no]").addEventListener("click", () => finish(false));
        dialog.querySelectorAll("[data-modal-close]").forEach((b) =>
          b.addEventListener("click", () => finish(false))
        );
      },
    });
  });
}

/* ------------------------------------------------------------- inline UI -- */

export function emptyState({ icon = "", title, message, action = "" }) {
  return `
    <div class="empty">
      ${icon ? `<div class="empty-icon" aria-hidden="true">${icon}</div>` : ""}
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${action}
    </div>`;
}

export function errorState(message, retryAction = "") {
  return `
    <div class="empty error">
      <div class="empty-icon" aria-hidden="true">⚠</div>
      <h3>Something went wrong</h3>
      <p>${esc(message)}</p>
      ${retryAction}
    </div>`;
}

export function spinner(label = "Loading…") {
  return `<div class="loading"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`;
}

export function skeleton(rows = 3) {
  return `<div class="skeleton-stack">${"<div class='skeleton'></div>".repeat(rows)}</div>`;
}
