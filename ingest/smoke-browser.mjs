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

  await step("planner: add a task", async () => {
    await page.click(String.raw`[data-nav="planner"]`);
    await page.waitForSelector("#plannerBody", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#plannerBody .skeleton"), null, { timeout: 15000 });
    await page.click("#addTask");
    await page.waitForSelector("#taskForm", { timeout: 10000 });
    await page.fill("#tText", "Exercise 4B, questions 1-12");
    await page.fill("#tNotes", "bring the graph paper");
    await page.click(String.raw`#quickDates .chip:has-text("Tomorrow")`);
    await page.click("#taskSave");
    await page.waitForSelector("#taskForm", { state: "detached", timeout: 15000 });
    await page.waitForSelector(String.raw`.task-text:has-text("Exercise 4B")`, { timeout: 10000 });
  });

  await step("planner: tick, untick, tuition tab", async () => {
    await page.click(String.raw`.task:has-text("Exercise 4B") input[type="checkbox"]`);
    await page.waitForSelector(String.raw`.task.done:has-text("Exercise 4B")`, { timeout: 10000 });
    await page.click(String.raw`.task:has-text("Exercise 4B") input[type="checkbox"]`);
    await page.waitForSelector(String.raw`.task:not(.done):has-text("Exercise 4B")`, { timeout: 10000 });
    await page.click(String.raw`#sourceTabs button[data-source="tuition"]`);
    await page.waitForTimeout(250);
    await page.click(String.raw`#sourceTabs button[data-source="school"]`);
  });

  await step("assistant: renders with composer at the bottom", async () => {
    await page.click(String.raw`[data-nav="assistant"]`);
    await page.waitForSelector("#chatInput", { timeout: 15000 });
    const box = await page.locator(".chat-composer").boundingBox();
    const vh = page.viewportSize().height;
    if (!box || box.y + box.height > vh + 4) note("assistant", "composer is not on screen");
    if (box && box.y < vh * 0.5) note("assistant", "composer is not at the bottom");
    await page.waitForSelector(".chip-suggest", { timeout: 10000 });
  });

  await step("assistant: answers a question", async () => {
    await page.fill("#chatInput", "What does the command word calculate ask you to do?");
    await page.press("#chatInput", "Enter");
    await page.waitForSelector(".msg.user", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.querySelector(".msg.model .bubble")?.textContent ?? "").length > 40,
      null, { timeout: 180000 },
    );
  });

  await step("mock: generator renders", async () => {
    await page.click(String.raw`[data-nav="mock"]`);
    await page.waitForSelector("#genBtn", { timeout: 20000 });
  });

  await step("mark a paper: three steps render", async () => {
    await page.click(String.raw`[data-nav="markpaper"]`);
    await page.waitForSelector("#mpDrop", { timeout: 20000 });
    await page.waitForFunction(
      () => !document.querySelector("#mpPaper")?.textContent.includes("Loading"),
      null, { timeout: 20000 },
    );
    const disabled = await page.locator("#mpGo").isDisabled();
    if (!disabled) note("markpaper", "Mark button is enabled with no photos attached");
  });

  await step("your papers: dropzone and coverage", async () => {
    await page.click(String.raw`[data-nav="papers"]`);
    await page.waitForSelector("#pDrop", { timeout: 20000 });
    await page.waitForSelector("#pCoverage", { timeout: 10000 });
  });

  await step("progress", async () => {
    await page.click(String.raw`[data-nav="progress"]`);
    await page.waitForSelector("#progBody", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#progBody .skeleton"), null, { timeout: 20000 });
  });

  await step("settings", async () => {
    await page.click(String.raw`[data-nav="settings"]`);
    await page.waitForSelector("#subjGrid .subj", { timeout: 15000 });
    await page.click(String.raw`label[for="theme-dark"]`);
    await page.waitForTimeout(150);
    await page.click(String.raw`label[for="theme-light"]`);
    await page.waitForFunction(() => !document.querySelector("#usagePanel .spinner"), null, { timeout: 20000 });
  });

  await step("mobile: chat composer stays on screen", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/#/assistant`, { waitUntil: "networkidle" });
    await page.waitForSelector("#chatInput", { timeout: 20000 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) note("mobile", `horizontal overflow of ${overflow}px`);
    const box = await page.locator(".chat-composer").boundingBox();
    if (!box || box.y + box.height > 844 + 4) note("mobile", "composer is off screen");
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
