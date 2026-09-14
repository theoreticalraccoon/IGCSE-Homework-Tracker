/**
 * Hash router.
 *
 * Hash rather than history API because the app is a static file that may be
 * opened from disk or from a subpath on any host — there is no server to
 * rewrite deep links.
 *
 * Each route exports `render(container, params)` and may return a cleanup
 * function, which is called before the next route mounts. That is how the mock
 * timer and the in-flight ask request get cancelled on navigation.
 */

const routes = new Map();
let current = null;
let cleanup = null;
let container = null;

export function defineRoute(name, module) {
  routes.set(name, module);
}

export function setOutlet(el) {
  container = el;
}

/** '#/mock/abc?x=1' → { name:'mock', segments:['abc'], query:{x:'1'} } */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, "");
  const [path, search = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(search));
  return { name: segments[0] || "planner", segments: segments.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith("#") ? path : `#/${path.replace(/^\/+/, "")}`;
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) {
    // replaceState rewrites the URL without firing hashchange, so the router
    // would never hear about it — the address bar would say ".../marked" while
    // the previous view stayed on screen. Render it explicitly.
    history.replaceState(null, "", target);
    handleRoute();
  } else {
    location.hash = target;   // hashchange drives the render
  }
}

export async function handleRoute() {
  if (!container) return;
  const { name, segments, query } = parseHash();
  const module = routes.get(name) ?? routes.get("planner");
  if (!module) return;

  // Same route, different params: let the view decide rather than remounting.
  const sameRoute = current === name;
  if (!sameRoute) {
    cleanup?.();
    cleanup = null;
  }

  current = name;
  document.body.dataset.route = name;
  markActiveNav(name);

  try {
    const result = await module.render(container, { segments, query, sameRoute });
    if (typeof result === "function") {
      cleanup?.();
      cleanup = result;
    }
  } catch (e) {
    console.error(`Route "${name}" failed`, e);
    container.innerHTML = `<div class="empty error"><h3>This page failed to load</h3><p>${
      e.message ?? ""
    }</p></div>`;
  }
}

function markActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    const active = el.dataset.nav === name;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

export function startRouter() {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}

export function stopRouter() {
  window.removeEventListener("hashchange", handleRoute);
  cleanup?.();
  cleanup = null;
  current = null;
}

export function currentRoute() {
  return current;
}
