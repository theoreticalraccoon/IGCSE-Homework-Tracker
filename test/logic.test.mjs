/**
 * Logic tests — no database, no network, no browser.
 *
 *   node test/logic.test.mjs
 *
 * Covers the parts where a silent bug is expensive: filename parsing (a
 * mis-detected kind files a mark scheme as a question paper), question
 * segmentation (a lost stem makes a question meaningless), question-to-mark-
 * scheme pairing (a wrong pair marks an answer against the wrong scheme),
 * retrieval query parsing, date maths, and HTML escaping.
 *
 * Requires only Node. The retrieval block additionally needs esbuild (it
 * compiles a TypeScript module) and is skipped if it is not installed.
 */
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";
process.env.GEMINI_API_KEYS ??= "dummy";

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = pathToFileURL(REPO + "/").href;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`));
};
const ok = (label, cond, detail = "") => {
  cond ? pass++ : (fail++, console.log(`  FAIL ${label} ${detail}`));
};

/* ------------------------------------------------------------- filenames -- */
console.log("filename parsing");
const { parseFilename, titleFor } = await import(ROOT + "ingest/lib/filename.js");

let f = parseFilename("0625_s19_qp_42.pdf");
eq("0625_s19_qp_42 → subject", f.subjectCode, "0625");
eq("0625_s19_qp_42 → session", f.session, "Jun");
eq("0625_s19_qp_42 → year", f.year, 2019);
eq("0625_s19_qp_42 → paper", f.paperNo, 4);
eq("0625_s19_qp_42 → variant", f.variant, 2);
eq("0625_s19_qp_42 → kind", f.kind, "qp");

f = parseFilename("0620_w21_ms_22.pdf");
eq("w21 → Nov", f.session, "Nov");
eq("w21 → 2021", f.year, 2021);
eq("ms kind", f.kind, "ms");

f = parseFilename("0580_m23_qp_12.pdf");
eq("m23 → Mar", f.session, "Mar");

f = parseFilename("0625_y20_sy.pdf");
eq("syllabus kind", f.kind, "sy");
eq("syllabus has no session", f.session, null);

f = parseFilename("0625_s19_gt.pdf");
eq("grade thresholds", f.kind, "gt");

f = parseFilename("Physics 2019 June Paper 42 Mark Scheme.pdf");
ok("year is never mistaken for a subject code", f === null, JSON.stringify(f));

f = parseFilename("0625_June_2019_ms_paper_42.pdf");
ok("loose: code found under underscores", f?.subjectCode === "0625", JSON.stringify(f));
ok("loose: recognised as a MARK SCHEME", f?.kind === "ms", JSON.stringify(f));
ok("loose: session", f?.session === "Jun", JSON.stringify(f));
ok("loose: year", f?.year === 2019, JSON.stringify(f));
ok("loose: paper + variant", f?.paperNo === 4 && f?.variant === 2, JSON.stringify(f));

ok("titleFor reads", titleFor(parseFilename("0625_s19_qp_42.pdf"), "Physics")
  === "Physics · Jun 2019 · Paper 42 · Question Paper",
  titleFor(parseFilename("0625_s19_qp_42.pdf"), "Physics"));

/* ------------------------------------------------------- question papers -- */
console.log("question paper parsing");
const { parseQuestionPaper, parseMarkScheme, cleanLines, looksParsed } =
  await import(ROOT + "ingest/lib/parse.js");

const qpPages = [{ n: 1, text: `
1 A car accelerates from rest.
(a) State what is meant by acceleration.
.................................................................
[1]
(b) The car reaches 20 m/s in 5.0 s.
(i) Calculate the acceleration.
[2]
(ii) Explain why the acceleration decreases at higher speed.
[3]
2 Fig. 2.1 shows a ray of light entering a glass block.
(a) Describe what happens to the ray.
[2]
© UCLES 2019
` }];

const questions = parseQuestionPaper(qpPages);
eq("question count", questions.length, 4);
eq("numbers", questions.map((q) => q.questionNo), ["1(a)", "1(b)(i)", "1(b)(ii)", "2(a)"]);
eq("marks", questions.map((q) => q.marks), [1, 2, 3, 2]);
ok("1(a) carries the question stem", questions[0].text.includes("A car accelerates from rest"), questions[0].text);
ok("1(b)(i) carries BOTH stems",
  questions[1].text.includes("A car accelerates from rest") && questions[1].text.includes("reaches 20 m/s"),
  questions[1].text);
ok("2(a) carries only its own stem",
  questions[3].text.includes("Fig. 2.1") && !questions[3].text.includes("A car"),
  questions[3].text);
ok("no un-marked stubs emitted", questions.every((q) => q.marks > 0));
ok("answer-line dots stripped", !questions[0].text.includes("......"), questions[0].text);
ok("UCLES footer stripped", !questions.some((q) => q.text.includes("UCLES")));
ok("looksParsed true", looksParsed(questions) === true);
ok("looksParsed false on junk", looksParsed([{ marks: null }]) === false);

/* ---------------------------------------------------------- mark schemes -- */
console.log("mark scheme parsing");
const msPages = [{ n: 1, text: `
Question Answer Marks
1(a) rate of change of velocity 1
1(b)(i) a = (20 - 0) / 5.0 = 4.0 m/s2 2
1(b)(ii) air resistance increases with speed 1
resultant force decreases 1
so acceleration decreases 1
2(a) the ray refracts towards the normal 2
` }];
const msRows = parseMarkScheme(msPages);
eq("ms row numbers", msRows.map((r) => r.questionNo), ["1(a)", "1(b)(i)", "1(b)(ii)", "2(a)"]);
ok("ms keeps full text for multi-line row",
  msRows[2].text.includes("air resistance") && msRows[2].text.includes("acceleration decreases"),
  msRows[2].text);

/* ---------------------------------------------------------------- pairing */
console.log("question ↔ mark scheme pairing");
const { pairQuestions } = await import(ROOT + "ingest/lib/pair.js");
const { paired, stats } = pairQuestions(questions, msRows);
eq("exact matches", stats.exact, 4);
ok("1(a) paired", paired[0].msText?.includes("rate of change"), paired[0].msText);
ok("1(b)(ii) paired", paired[2].msText?.includes("air resistance"), paired[2].msText);
ok("2(a) paired", paired[3].msText?.includes("refracts"), paired[3].msText);

// Fuzzy: mark scheme writes "1 b i" instead of "1(b)(i)"
const fuzzy = pairQuestions(
  [{ questionNo: "1(b)(i)", questionRoot: "1", text: "x", marks: 2 }],
  [{ questionNo: "1 b i", questionRoot: "1", text: "the answer", marks: 2 }],
);
ok("fuzzy numbering pairs", fuzzy.paired[0].msText === "the answer", JSON.stringify(fuzzy.stats));

// Safety: a part must NOT silently take the root row.
const unsafe = pairQuestions(
  [{ questionNo: "4(b)", questionRoot: "4", text: "x", marks: 2 }],
  [{ questionNo: "4", questionRoot: "4", text: "whole question scheme", marks: 8 }],
);
ok("part does not fall back to root scheme", unsafe.paired[0].msText === null,
  `got ${unsafe.paired[0].msText}`);

/* ---------------------------------------------------------- command words */
console.log("command words");
const { commandWord } = await import(ROOT + "ingest/lib/classify.js");
eq("explain", commandWord("Explain why the acceleration decreases."), "explain");
eq("calculate", commandWord("(i) Calculate the acceleration."), "calculate");
eq("mid-sentence 'state' is not a command",
  commandWord("The state of the gas is measured."), null);
eq("after a full stop", commandWord("Fig 2.1 shows a block. Describe the motion."), "describe");

/* ------------------------------------------------- retrieval query parsing */
console.log("retrieval query parsing");
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("  (skipped — esbuild not installed: npm i -D esbuild)");
}
const out = build && await build({
  entryPoints: [join(REPO, "supabase/functions/_shared/retrieve.ts")],
  bundle: true, format: "esm", write: false, external: ["*"],
});
if (out) {
const mod = await import("data:text/javascript," + encodeURIComponent(
  out.outputFiles[0].text.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*gemini\.ts";?/g, "const embedOne = async () => [];"),
));
const pq = mod.parseQuery;
eq("filename form", pq("mark my 0625_s19_qp_42 Q4(b)").paperCode, "0625_s19");
eq("filename form year", pq("mark my 0625_s19_qp_42 Q4(b)").years, [2019]);
eq("question ref", pq("mark my 0625_s19_qp_42 Q4(b)").questionNo, "4(b)");
eq("prose session", pq("physics june 2021 paper 4 question 7b").session, "Jun");
eq("prose year", pq("physics june 2021 paper 4 question 7b").years, [2021]);
eq("prose paper", pq("physics june 2021 paper 4 question 7b").paperNo, 4);
eq("prose question", pq("physics june 2021 paper 4 question 7b").questionNo, "7(b)");
eq("november → Nov", pq("november 2020 paper 2").session, "Nov");
eq("no identifiers", pq("why does a parachute reach terminal velocity"), {});
eq("label", mod.label({ subject_code: "0625", session: "Jun", year: 2019, paper_no: 4, variant: 2, question_no: "4(b)", kind: "question" }),
  "0625 Jun 2019 P42 Q4(b)");

/* --------------------------------------------------------------- packing -- */
const packed = mod.packContext([
  { id: "a", score: 0.1, kind: "question", content: "low", marks: 1, subject_code: "0625", syllabus_refs: [] },
  { id: "b", score: 0.9, kind: "question", content: "high", ms_content: "points", marks: 3, subject_code: "0625", syllabus_refs: [] },
], 100000);
eq("packs highest score first", packed.used.map((c) => c.id), ["b", "a"]);
ok("renders mark scheme", packed.text.includes("MARK SCHEME: points"), packed.text);
const tiny = mod.packContext([
  { id: "a", score: 0.9, kind: "question", content: "x".repeat(500), subject_code: "0625", syllabus_refs: [] },
  { id: "b", score: 0.5, kind: "question", content: "y".repeat(500), subject_code: "0625", syllabus_refs: [] },
], 300);
eq("budget respected but never empty", tiny.used.length, 1);

}

/* ------------------------------------------------------------------ dates */
console.log("dates");
const d = await import(ROOT + "src/js/lib/dates.js");
const today = d.today();
eq("dueLabel today", d.dueLabel(today).cls, "today");
eq("dueLabel tomorrow", d.dueLabel(d.iso(d.addDays(new Date(), 1))).text, "Tomorrow");
eq("dueLabel overdue", d.dueLabel(d.iso(d.addDays(new Date(), -3))).text, "3 days overdue");
eq("dueLabel overdue singular", d.dueLabel(d.iso(d.addDays(new Date(), -1))).text, "1 day overdue");
eq("dueLabel none", d.dueLabel(null), null);
const week = d.weekOf(new Date("2026-09-16T12:00:00"));
eq("week starts Monday", week[0].getDay(), 1);
eq("week is 7 days", week.length, 7);
ok("monthGrid covers the month", d.monthGrid(new Date("2026-02-10T12:00:00")).flat().some((x) => x.getDate() === 28));
eq("minutesToHuman", [d.minutesToHuman(45), d.minutesToHuman(90), d.minutesToHuman(120)], ["45m", "1h 30m", "2h"]);

/* ---------------------------------------------------------------- escaping */
console.log("escaping and markdown");
const dom = await import(ROOT + "src/js/ui/dom.js");
eq("esc", dom.esc('<img src=x onerror="alert(1)">'),
  "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
const md = dom.renderMarkdown("**bold** and <script>alert(1)</script>\n- one\n- two\n\nCited [2] and [1, 3].");
ok("markdown escapes html", !md.includes("<script>"), md);
ok("markdown bold", md.includes("<strong>bold</strong>"));
ok("markdown list", md.includes("<li>one</li>") && md.includes("<li>two</li>"));
ok("citation pills", (md.match(/data-cite="/g) ?? []).length === 3, md);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
