/**
 * Minimal DOM helpers.
 *
 * The app renders by building HTML strings and assigning innerHTML, so `esc`
 * is not optional politeness. Every value that reaches a template passes
 * through it. Corpus text comes from PDFs and user text comes from students;
 * both contain angle brackets.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const byId = (id) => document.getElementById(id);

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Escape, then turn newlines into breaks. For corpus text and model output. */
export function escLines(value) {
  return esc(value).replace(/\n/g, "<br>");
}

/**
 * The small subset of Markdown the model actually emits: bold, italic, inline
 * code, bullets, and the [3] citation markers. Escaped first, so this can
 * never introduce markup.
 */
export function renderMarkdown(text) {
  const lines = esc(text ?? "").split("\n");
  const out = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);

    if (bullet || numbered) {
      if (!inList) {
        out.push("<ul class='md-list'>");
        inList = true;
      }
      out.push(`<li>${inline(bullet ? bullet[1] : numbered[2])}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (!line) {
      out.push("");
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    out.push(heading ? `<p class="md-h">${inline(heading[1])}</p>` : `<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function inline(s) {
  return s
    // Models reach for LaTeX on anything mathematical. The prompts forbid it,
    // but a stray "$x$" reaching the student as literal dollar signs is worse
    // than silently unwrapping it here.
    .replace(/\$\$?([^$\n]{1,120}?)\$\$?/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*(?!\s)(.+?)(?<!\s)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // [3] and [1, 2] become clickable citation pills
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) =>
      nums
        .split(",")
        .map((n) => `<button class="cite" data-cite="${n.trim()}">${n.trim()}</button>`)
        .join("")
    );
}

/** Delegated listener; returns an unsubscribe function. */
export function on(root, event, selector, handler) {
  const listener = (e) => {
    const match = e.target.closest(selector);
    if (match && root.contains(match)) handler(e, match);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Move focus into a newly rendered view without stealing it mid-typing. */
export function focusFirst(root) {
  const target = root.querySelector("[data-autofocus]");
  if (target && document.activeElement === document.body) target.focus();
}

export function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}
