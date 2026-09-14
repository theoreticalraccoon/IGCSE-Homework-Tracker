/**
 * Browser smoke test — drives the real UI in headless Chromium.
 *
 *   npm run test:browser        (from the repo root)
 *
 * Serves the repo, signs in as a throwaway user, walks every route and
 * exercises the interactions a student actually performs. Any console error,
 * page exception or failed request is a failure.
 *
 * This is the only check that executes the view layer. The unit tests cover
 * pure logic and the function smoke test covers the server, but neither one
 * would notice a template that throws on render.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// fileURLToPath, not url.pathname: on Windows the latter yields "/C:/Users/…"
// with forward slashes, which never matches the back-slashed paths join()
// produces — so every request fails the containment check with a 403.
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const URL_SB = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const file = join(REPO, normalize(path === "/" ? "/index.html" : path));
    if (!file.startsWith(REPO)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const admin = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });
const email = `markwise-ui-${Date.now()}@example.com`;
const password = "markwise-ui-1234";
const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createErr) throw new Error(`could not create the test user: ${createErr.message}`);
const userId = created.user.id;

const problems = [];
const note = (where, what) => problems.push(`${where}: ${what}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let scope = "boot";
page.on("console", (m) => {
  if (m.type() === "error") note(scope, `console: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => note(scope, `uncaught: ${String(e.message).slice(0, 200)}`));
page.on("requestfailed", (r) => {
  const f = r.failure()?.errorText ?? "";
  if (!/ERR_ABORTED/.test(f)) note(scope, `request failed: ${r.url().slice(0, 90)} ${f}`);
});

const step = async (name, fn) => {
  scope = name;
  const before = problems.length;
  try {
    await fn();
  } catch (e) {
    note(name, `threw: ${String(e.message).slice(0, 200)}`);
  }
  const added = problems.length - before;
  console.log(`  ${added ? "FAIL" : "ok  "}  ${name}${added ? ` (${added})` : ""}`);
};

try {
  console.log(`serving ${origin}\n`);

  await step("sign in", async () => {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForSelector("#authEmail", { timeout: 15000 });
    await page.fill("#authEmail", email);
    await page.fill("#authPassword", password);
    await page.click("#authSubmit");
    await page.waitForSelector("#onboardGrid .subj", { timeout: 20000 });
  });

  await step("onboarding: pick subjects", async () => {
    await page.click('#onboardGrid .subj:has-text("Mathematics A") input');
    await page.click('#onboardGrid .subj:has-text("Physics") input');
    await page.click("#onboardContinue");
    await page.waitForSelector("#appShell:not([hidden])", { timeout: 20000 });
    await page.waitForSelector("#outlet .view-head", { timeout: 15000 });
  });

  await step("today", async () => {
    await page.waitForSelector("#greeting");
    await page.waitForFunction(() => !document.querySelector("#todayBody .skeleton"), null, { timeout: 15000 });
  });

  await step("planner: add a task", async () => {
    await page.click('[data-nav="planner"]');
    await page.waitForSelector("#plannerBody", { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector("#plannerBody .skeleton"), null, { timeout: 15000 });
    await page.click("#addTask");
    await page.waitForSelector("#taskForm", { timeout: 10000 });
    await page.fill("#tText", "Exercise 4B, questions 1-12");
    await page.click('#quickDates .chip:has-text("Tomorrow")');
    await page.click("#taskSave");
    await page.waitForSelector("#taskForm", { state: "detached", timeout: 15000 });
    await page.waitForSelector('.task-text:has-text("Exercise 4B")', { timeout: 10000 });
  });

  await step("planner: complete then reopen the task", async () => {
    await page.click('.task:has-text("Exercise 4B") input[type="checkbox"]');
    await page.waitForSelector('.task.done:has-text("Exercise 4B")', { timeout: 10000 });
    await page.click('.task:has-text("Exercise 4B") input[type="checkbox"]');
    await page.waitForSelector('.task:not(.done):has-text("Exercise 4B")', { timeout: 10000 });
  });

  await step("planner: week and list views", async () => {
    await page.click('#viewToggle button[data-view="week"]');
    await page.waitForSelector(".week-day", { timeout: 10000 });
    await page.click('#viewToggle button[data-view="list"]');
    await page.waitForSelector("#plannerBody .card", { timeout: 10000 });
    await page.click('#viewToggle button[data-view="board"]');
    await page.waitForSelector(".board", { timeout: 10000 });
  });

  await step("planner: source tabs", async () => {
    for (const s of ["tuition", "self", "all", "school"]) {
      await page.click(`#sourceTabs button[data-source="${s}"]`);
      await page.waitForTimeout(150);
    }
  });

  await step("calendar", async () => {
    await page.click('[data-nav="calendar"]');
    await page.waitForSelector(".calendar", { timeout: 15000 });
    await page.click("#nextMonth");
    await page.click("#prevMonth");
    await page.click("#thisMonth");
  });

  await step("library: browse and search", async () => {
    await page.click('[data-nav="library"]');
    await page.waitForSelector("#libResults", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#libResults .skeleton"), null, { timeout: 20000 });
    const count = await page.locator(".question-list li").count();
    if (count === 0) note("library", "no questions listed for an ingested subject");
    await page.fill("#libSearch", "sequence");
    await page.waitForTimeout(1200);
  });

  await step("library: open a question", async () => {
    await page.click(".question-list li button:first-child");
    await page.waitForSelector(".modal .verbatim", { timeout: 15000 });
    await page.click("[data-modal-close]");
    await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  });

  await step("mark: render and validate", async () => {
    await page.click('[data-nav="mark"]');
    await page.waitForSelector("#answerBox", { timeout: 15000 });
    await page.click("#markBtn");                       // empty — should warn, not throw
    await page.waitForSelector("#toast:not([hidden])", { timeout: 8000 });
  });

  await step("ask: render", async () => {
    await page.click('[data-nav="ask"]');
    await page.waitForSelector("#askInput", { timeout: 15000 });
    await page.click('#modeToggle button[data-mode="technique"]');
    await page.click('#modeToggle button[data-mode="syllabus"]');
    await page.click("#historyBtn");
    await page.waitForSelector(".modal", { timeout: 10000 });
    await page.click("[data-modal-close]");
  });

  await step("mock: render generator", async () => {
    await page.click('[data-nav="mock"]');
    await page.waitForSelector("#generator", { timeout: 15000 });
    await page.waitForFunction(
      () => !document.querySelector("#genTopics")?.textContent.includes("Loading"),
      null, { timeout: 20000 },
    );
  });

  // The longest flow in the app, and the only one with a timer, a draft that
  // survives reload, and per-question marking. Costs real Gemini quota, so it
  // is kept to the smallest paper the generator will build.
  await step("mock: generate, sit, submit, mark", async () => {
    await page.selectOption("#genMarks", "20");
    await page.click("#genBtn");
    await page.waitForSelector(".exam-paper", { timeout: 120000 });

    const answers = page.locator(".exam-answer");
    const n = await answers.count();
    if (n === 0) { note("mock", "generated paper has no questions"); return; }

    await answers.nth(0).fill("3n - 2");
    if (n > 1) await answers.nth(1).fill("42");

    // The draft must survive a reload, or an hour of work dies with the tab.
    const url = page.url();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".exam-answer", { timeout: 30000 });
    const restored = await page.locator(".exam-answer").nth(0).inputValue();
    if (restored !== "3n - 2") note("mock", `draft not restored after reload (got "${restored}")`);
    if (page.url() !== url) note("mock", "reload lost the mock's deep link");

    await page.click("#submitExam");
    await page.waitForSelector("[data-yes]", { timeout: 10000 });
    await page.click("[data-yes]");

    await page.waitForSelector(".result-summary", { timeout: 300000 });
    const score = await page.locator(".score-value").first().textContent();
    console.log(`        marked: ${score?.replace(/\s+/g, "")}`);
    const bars = await page.locator(".topic-bar").count();
    if (bars === 0) note("mock", "marked view shows no topic breakdown");
  });

  await step("progress: reflects the marked mock", async () => {
    await page.click('[data-nav="progress"]');
    await page.waitForSelector("#progBody", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#progBody .skeleton"), null, { timeout: 20000 });
    const stats = await page.locator(".stat").count();
    if (stats === 0) note("progress", "no stats after marking a mock — the attempt did not record");
    await page.locator(".attempt-list button").first().click();
    await page.waitForSelector(".modal .breakdown, .modal .verbatim", { timeout: 15000 });
    await page.click("[data-modal-close]");
  });

  await step("settings: theme, subjects, usage", async () => {
    await page.click('[data-nav="settings"]');
    await page.waitForSelector("#subjGrid .subj", { timeout: 15000 });
    await page.click('label[for="theme-dark"]');
    await page.waitForTimeout(150);
    await page.click('label[for="theme-light"]');
    await page.waitForFunction(
      () => !document.querySelector("#usagePanel .spinner"),
      null, { timeout: 20000 },
    );
  });

  await step("deep link survives reload", async () => {
    await page.goto(`${origin}/#/library?subject=E-4MA1`, { waitUntil: "networkidle" });
    await page.waitForSelector("#libResults", { timeout: 20000 });
  });

  await step("mobile viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/#/planner`, { waitUntil: "networkidle" });
    await page.waitForSelector("#plannerBody", { timeout: 20000 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) note("mobile viewport", `horizontal overflow of ${overflow}px`);
  });
} finally {
  await browser.close();
  server.close();
  await admin.from("tasks").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\nthrowaway user deleted.");
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log("  • " + p);
  process.exit(1);
}
console.log("\nBrowser: every route renders and every interaction works.");
