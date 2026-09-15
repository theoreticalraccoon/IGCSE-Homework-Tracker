/**
 * Bootstrap: auth gate, catalogue load, router wiring.
 *
 * Three screens exist outside the router: sign-in, password recovery and
 * first-run onboarding. Because none of them should render the app shell.
 * Everything after that is a route.
 */

import { byId, on } from "./ui/dom.js";
import { toast } from "./ui/feedback.js";
import { sb } from "./api/client.js";
import { store, reset, loadPrefs } from "./store.js";
import { loadCatalogue, loadProfile } from "./api/data.js";
import { initTheme } from "./theme.js";
import { defineRoute, setOutlet, startRouter, navigate, handleRoute } from "./router.js";
import { renderAuth, renderRecovery, renderOnboarding } from "./views/auth.js";

import * as planner from "./views/planner.js";
import * as assistant from "./views/assistant.js";
import * as mock from "./views/mock.js";
import * as markpaper from "./views/markpaper.js";
import * as progress from "./views/progress.js";
import * as settings from "./views/settings.js";

defineRoute("planner", planner);
defineRoute("assistant", assistant);
defineRoute("mock", mock);
defineRoute("markpaper", markpaper);
defineRoute("progress", progress);
defineRoute("settings", settings);

let recoveryActive = false;
let routerStarted = false;

/* ---------------------------------------------------------------- screens -- */

function show(screen) {
  for (const id of ["authScreen", "recoveryScreen", "onboardScreen", "appShell"]) {
    byId(id).hidden = id !== screen;
  }
  document.body.classList.toggle("signed-in", screen === "appShell");
}

function showAuth() {
  reset();
  show("authScreen");
  renderAuth();
}

let booting = null;

async function showApp(user) {
  // On load, onAuthStateChange and the getSession() check both resolve with
  // the same session, so this runs twice. Without the guard the second pass
  // re-boots the router underneath the first one's render.
  if (booting) return booting;
  booting = doShowApp(user).finally(() => { booting = null; });
  return booting;
}

async function doShowApp(user) {
  store.user = user;
  show("appShell");
  byId("userEmail").textContent = user.email ?? "";

  try {
    await loadCatalogue();
    await loadProfile(user.id);
  } catch (e) {
    toast(e.message, "error");
  }

  if (!store.mySubjects.length) {
    show("onboardScreen");
    renderOnboarding(() => {
      show("appShell");
      boot();
    });
    return;
  }
  boot();
}

function boot() {
  planner.invalidate();
  if (!routerStarted) {
    setOutlet(byId("outlet"));
    startRouter();
    routerStarted = true;
  } else {
    // Re-render where we already are. Navigating to parseHash().name would
    // drop the segments, landing on #/mock instead of #/mock/<id>, which is
    // exactly what happened when a student reloaded mid-paper.
    handleRoute();
  }
}

/* ------------------------------------------------------------------ shell -- */

function wireShell() {
  on(document, "click", "[data-nav]", (e, el) => {
    e.preventDefault();
    navigate(el.dataset.nav);
    byId("appShell").classList.remove("nav-open");
  });

  byId("navToggle").addEventListener("click", () => {
    byId("appShell").classList.toggle("nav-open");
  });

  byId("signOut").addEventListener("click", async () => {
    await sb.auth.signOut().catch(() => {});
  });

  // Keyboard shortcuts: single letters, only when not typing.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!byId("appShell") || byId("appShell").hidden) return;
    if (!byId("modalOverlay").hidden) return;

    const routes = { p: "planner", a: "assistant", m: "mock", k: "markpaper", g: "progress" };
    const target = routes[e.key.toLowerCase()];
    if (target) {
      e.preventDefault();
      navigate(target);
    }
  });
}

/* ------------------------------------------------------------------ start -- */

(async function start() {
  initTheme();
  loadPrefs();
  wireShell();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryActive = true;
      show("recoveryScreen");
      renderRecovery((user) => {
        recoveryActive = false;
        cleanUrl();
        if (user) showApp(user);
        else showAuth();
      });
      return;
    }
    if (recoveryActive) return;

    if (session?.user) {
      if (!store.user || store.user.id !== session.user.id) showApp(session.user);
    } else {
      showAuth();
    }
  });

  const isRecovery = /type=recovery/.test(location.hash) || /type=recovery/.test(location.search);

  try {
    const { data } = await sb.auth.getSession();
    if (recoveryActive) return;
    if (isRecovery && data.session) {
      recoveryActive = true;
      show("recoveryScreen");
      renderRecovery((user) => {
        recoveryActive = false;
        cleanUrl();
        if (user) showApp(user);
        else showAuth();
      });
      return;
    }
    if (data.session?.user) await showApp(data.session.user);
    else showAuth();
  } catch (e) {
    console.error(e);
    showAuth();
  }
})();

function cleanUrl() {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore */
  }
}
