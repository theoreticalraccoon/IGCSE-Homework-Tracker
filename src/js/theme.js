/**
 * Theme. The stored value is applied before first paint by a tiny inline
 * script in index.html; this module keeps it in sync afterwards.
 */

import { STORAGE } from "./config.js";

let theme = "system";

export function initTheme() {
  try {
    theme = localStorage.getItem(STORAGE.theme) || "system";
  } catch {
    theme = "system";
  }
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
}

export function currentTheme() {
  return theme;
}

export function applyTheme(next, { persist = false } = {}) {
  theme = next;
  document.documentElement.setAttribute("data-theme", next);
  if (persist) {
    try {
      localStorage.setItem(STORAGE.theme, next);
    } catch {
      /* ignore */
    }
  }
}
