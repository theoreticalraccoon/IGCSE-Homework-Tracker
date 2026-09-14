/**
 * Splitting papers into question parts, and mark schemes into marking points.
 *
 * This is the hardest part of the project and the reason a general chatbot
 * cannot do what Markwise does. Two strategies run in order:
 *
 *   1. A deterministic parser. Exam papers are rigidly formatted — a question
 *      starts at column zero with "3", parts are "(a)", sub-parts are "(ii)",
 *      and the mark allocation is "[4]" at the end of the last line of the
 *      part. When this works it is exact, free, and fast.
 *
 *   2. An LLM repair pass, used only on the questions the deterministic parser
 *      rejected (no marks found, implausible length, no part structure). This
 *      keeps token spend proportional to how badly a given paper is laid out
 *      rather than to how many papers there are.
 *
 * Everything downstream assumes the invariant this module enforces: a part is
 * only emitted if it has text AND a mark allocation. An unmarked fragment
 * would pollute retrieval and, worse, let the marking route award marks
 * against nothing.
 */

import { generateJSON } from "./gemini.js";
import { LLM_PARSE } from "./config.js";

/* --------------------------------------------------------------- cleaning -- */

const NOISE = [
  // --- Cambridge ---
  /^©\s*UCLES/i,
  /^Permission to reproduce/i,
  /^Cambridge (International|Assessment)/i,
  /^Additional Materials/i,
  /^DO NOT WRITE IN THIS (MARGIN|AREA)$/i,
  // --- Edexcel / Pearson ---
  /\*[A-Z]?\d{4,6}[A-Z]\d{3,6}\*/,             // the *P73990A0328* item code
  /^Pearson (Edexcel|Education)/i,
  /^Answer ALL/i,
  /^Write your answers in the spaces provided/i,
  /^You must write down all the stages/i,
  /^(Total for Paper|TOTAL FOR PAPER)/i,
  /^International GCSE Mathematics?$/i,
  /^Formulae sheet/i,
  // --- both ---
  /^\d+\s*$/,                                  // bare page numbers
  /^\[?Turn over\]?$/i,
  /^BLANK PAGE$/i,
  /^\.{6,}$/,                                  // the answer-line dot leaders
  /^_{6,}$/,
  /^[\s.·]{10,}$/,
];

export function cleanLines(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/ /g, " ").replace(/\.{4,}/g, " ").trimEnd())
    .filter((l) => l.trim() && !NOISE.some((re) => re.test(l.trim())));
}

/**
 * Strip the front matter. Both boards open with a cover page of candidate
 * details and instructions, and Edexcel maths papers add a formulae sheet —
 * none of it is markable and all of it pollutes retrieval.
 */
export function dropCoverPage(pages) {
  return pages.filter((p, i) => {
    if (i > 2) return true;
    const t = p.text.toLowerCase();
    return !(
      t.includes("read these instructions first") ||
      t.includes("candidate number") ||
      t.includes("write your name here") ||
      t.includes("formulae sheet") ||
      t.includes("information for candidates") ||
      (t.includes("this document has") && t.includes("blank"))
    );
  });
}

/* -------------------------------------------------------- question papers -- */

const Q_START = /^(\d{1,2})\s*(?:[).]|\s)\s*(.*)$/;          // "3 A car travels…"
const PART = /^\(([a-h])\)\s*(.*)$/;                          // "(b) Explain…"
const SUBPART = /^\(((?:i|v|x)+)\)\s*(.*)$/i;                 // "(ii) Calculate…"

// The two boards mark up mark allocations differently and both must be read.
const MARKS_BRACKET = /\[\s*(\d{1,2})\s*\]\s*$/;              // Cambridge: "… [3]"
const MARKS_ALONE = /^\(\s*(\d{1,2})\s*\)$/;                  // Edexcel: "(2)" on its own line
const MARKS_TOTAL = /\(Total for Question\s+\d+\s+is\s+(\d+)\s+marks?\)/i;

/**
 * Marks for one buffered block, and the block with the mark-up removed.
 *
 * `allowTotal` is false for parts: "(Total for Question 1 is 3 marks)" trails
 * the *last part* of a question, and crediting that part with the whole
 * question's marks would inflate every final part on an Edexcel paper.
 */
function extractMarks(lines, allowTotal) {
  let marks = null;
  const kept = [];

  for (const line of lines) {
    const alone = line.match(MARKS_ALONE);
    if (alone) {
      marks = Number(alone[1]);   // last one wins: it belongs to this part
      continue;
    }
    if (MARKS_TOTAL.test(line)) {
      if (allowTotal && marks === null) marks = Number(line.match(MARKS_TOTAL)[1]);
      continue;                   // never keep the total line in the text
    }
    kept.push(line);
  }

  let text = kept.join("\n").trim();
  const bracket = text.match(MARKS_BRACKET);
  if (bracket) {
    marks = Number(bracket[1]);
    text = text.replace(MARKS_BRACKET, "").trim();
  }
  return { marks, text };
}

/**
 * @returns {{questionNo,questionRoot,text,marks,page}[]}
 */
export function parseQuestionPaper(pages) {
  const out = [];
  let root = null, part = null, sub = null;
  let buf = [];
  let startPage = 1;

  // Stems: the un-marked text that introduces the parts beneath it. "1 A car
  // accelerates from rest." earns no marks itself but every part of question 1
  // is meaningless without it, so it is carried down rather than emitted.
  let rootStem = "", partStem = "";

  const flush = () => {
    if (!root) { buf = []; return; }
    const lines = buf;
    buf = [];
    if (!lines.length) return;

    // A "Total for Question" line only counts at whole-question level.
    const { marks, text: clean } = extractMarks(lines, part === null && sub === null);
    if (!clean) return;

    // No mark allocation → this is a stem, not a markable part.
    if (marks === null) {
      if (part === null) rootStem = clean;
      else if (sub === null) partStem = clean;
      // An un-marked sub-part is dropped: there is nothing to mark against it.
      return;
    }

    const stem = [rootStem, sub !== null ? partStem : ""].filter(Boolean).join("\n");
    out.push({
      questionRoot: String(root),
      questionNo: root + (part ? `(${part})` : "") + (sub ? `(${sub})` : ""),
      text: stem ? `${stem}\n${clean}` : clean,
      marks,
      page: startPage,
    });
  };

  for (const page of pages) {
    for (const raw of cleanLines(page.text)) {
      const line = raw.trim();

      const qm = line.match(Q_START);
      // A new question only starts if the number is the next one up AND what
      // follows reads like a question. Diagram labels are the trap: "12 m" on
      // question 11's diagram is the next number in sequence, and taking it
      // ends question 11 early, loses it entirely, and then makes the real
      // question 12 unrecognisable.
      if (qm && isNextQuestion(Number(qm[1]), root) && opensAQuestion(qm[2])) {
        flush();
        root = Number(qm[1]);
        part = null;
        sub = null;
        rootStem = "";
        partStem = "";
        startPage = page.n;
        // "6 (a) Simplify …" puts the question number and its first part on one
        // line. Without peeling the label off here, 6(a) is emitted as a bare
        // "6" and then fails to pair with the scheme's 6(a) row.
        const peeled = peelLabels(qm[2] ?? "");
        part = peeled.part;
        sub = peeled.sub;
        if (peeled.rest) buf.push(peeled.rest);
        continue;
      }

      const sm = line.match(SUBPART);
      if (sm && root) {
        flush();
        sub = sm[1].toLowerCase();
        startPage = page.n;
        if (sm[2]) buf.push(sm[2]);
        continue;
      }

      const pm = line.match(PART);
      if (pm && root) {
        flush();
        part = pm[1];
        sub = null;
        partStem = "";
        startPage = page.n;
        // "(a) (i) Work out …" — the sub-part can share the line too.
        const peeled = peelLabels(pm[2] ?? "", { partsAlreadyTaken: true });
        sub = peeled.sub;
        if (peeled.rest) buf.push(peeled.rest);
        continue;
      }

      if (root) buf.push(line);
    }
  }
  flush();

  return dedupe(out.filter((q) => q.text.length > 8));
}

/**
 * One chunk per question part, keeping the first occurrence.
 *
 * A repeated question number is never legitimate — it means the parser lost
 * track of where it was. Keeping the duplicates would put the same question in
 * a mock paper twice and split its marks across several rows, so they are
 * dropped here and counted, so `looksParsed` can send a badly-confused paper to
 * the model instead.
 */
function dedupe(parts) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const p of parts) {
    const key = p.questionNo;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  out.duplicatesDropped = dropped;
  return out;
}

/**
 * Strip leading "(a)" / "(ii)" labels from the start of a line.
 *
 * Papers put the question number, its first part and sometimes its first
 * sub-part on one line. Each label that stays buried in the text is a part
 * that never gets its own chunk and never pairs with its mark scheme row.
 */
function peelLabels(text, { partsAlreadyTaken = false } = {}) {
  let rest = text.trim();
  let part = null;
  let sub = null;

  if (!partsAlreadyTaken) {
    const p = rest.match(PART);
    if (p) {
      part = p[1];
      rest = p[2].trim();
    }
  }
  const s = rest.match(SUBPART);
  if (s) {
    sub = s[1].toLowerCase();
    rest = s[2].trim();
  }
  return { part, sub, rest };
}

/**
 * Is this the next question number?
 *
 * Strictly "current + 1" is too brittle. When one question's opening line is
 * missed — a diagram-heavy stem, an odd font — the parser sticks on the
 * previous number and every subsequent "(a)" and "(b)" is attributed to it,
 * producing eight copies of "2(b)" with the wrong text. Allowing a small
 * forward jump lets it resynchronise, while staying forward-only stops a
 * numeric sequence inside a question ("1 4 7 10") from resetting it.
 */
function isNextQuestion(n, current) {
  if (current === null) return n === 1 || n === 2; // papers occasionally start at 2
  return n > current && n <= current + 3;
}

/**
 * Does the text after a question number look like the start of a question?
 *
 * A part label always does. Otherwise it has to be long enough to be prose —
 * which rejects the units and measurements that litter diagrams ("12 m",
 * "9 cm") without needing to know what the diagram shows.
 */
function opensAQuestion(rest) {
  const text = (rest ?? "").trim();
  return text.startsWith("(") || text.length >= 10;
}

/* ------------------------------------------------------------ mark schemes -- */

/**
 * Cambridge mark schemes are tables: question ref | answer | marks | guidance.
 * Text extraction flattens them, but the question ref reliably starts a row and
 * the mark count reliably ends it, which is enough to segment on.
 */
// The `\*?` is for starred questions ("1*" — assessed for written
// communication), which otherwise fail to match and lose the whole question.
const MS_ROW = /^(\d{1,2})\*?\s*(?:\(([a-h])\))?\s*(?:\(((?:i|v|x)+)\))?\s+(.*)$/i;

// Edexcel restates the table header above every question. Where that happens
// it is the most reliable row boundary in the document — far better than the
// numbering, because working like "2 card = 6" is indistinguishable from the
// start of question 2 by any other means.
const MS_HEADER = /^(q|question)\b.*\b(answer|working)\b.*\bmarks?\b/i;

// Superscript ordinals ("1st") split onto their own line during extraction.
const MS_JUNK = /^(st|nd|rd|th|oe|cao|ft|isw|dep|indep|awrt)$/i;
// Rows that give only the part, or only the sub-part, inheriting what is above.
const MS_PART_ONLY = /^\(([a-h])\)\s*(?:\(((?:i|v|x)+)\))?\s+(.*)$/i;
const MS_SUB_ONLY = /^\(((?:i|v|x)+)\)\s+(.*)$/i;

export function parseMarkScheme(pages) {
  const rows = [];
  let current = null;
  let root = null;   // the question number rows are currently under
  let part = null;   // and the part, for rows that give only a sub-part

  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    if (text) {
      rows.push({
        questionNo: current.questionNo,
        questionRoot: current.questionRoot,
        text: text.replace(/\s*\|\s*/g, " · "),
        marks: current.marks ?? trailingMarks(text),
      });
    }
    current = null;
  };

  const open = (n, p, sub, rest) => {
    flush();
    root = n;
    part = p ?? null;
    current = {
      questionRoot: String(n),
      questionNo: String(n) +
        (p ? `(${p.toLowerCase()})` : "") +
        (sub ? `(${sub.toLowerCase()})` : ""),
      lines: rest ? [rest] : [],
      marks: leadingMarks(rest),
    };
  };

  const all = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  // Two layouts, decided from the document itself. When the header is restated
  // throughout, trust it; when it appears once or twice (Cambridge prints it
  // per page at most), fall back to the numbering.
  const headerGated = all.filter((l) => MS_HEADER.test(l)).length >= 3;
  let afterHeader = false;

  for (const line of all) {
    if (MS_HEADER.test(line)) {
      afterHeader = true;
      continue;
    }
    if (MS_JUNK.test(line)) continue;
    if (/^(guidance|mark scheme|notes)$/i.test(line)) continue;

    {
      const m = line.match(MS_ROW);
      if (m) {
        const n = Number(m[1]);
        const [, , part, sub, rest] = m;

        // Mark schemes are printed in question order, and flattening a table
        // to text turns working like "3 × n + k" into something that looks
        // exactly like the start of question 3. Requiring the number to be the
        // next one — or the same one with a new part label — rejects those
        // without needing to understand the mathematics.
        const startsNewQuestion = headerGated
          ? afterHeader
          : (root === null ? n <= 2 : n === root + 1);
        const continuesSameQuestion = n === root && (part || sub);

        if (startsNewQuestion || continuesSameQuestion) {
          open(n, part, sub, rest);
          afterHeader = false;
          continue;
        }
        // Falls through: it is body text of the current row.
      }

      // "(b) 1 B1 …" under the question opened above.
      const po = line.match(MS_PART_ONLY);
      if (po && root !== null) {
        open(root, po[1], po[2], po[3]);
        continue;
      }

      // "(ii) 1 B1 …" — inherits both the question and the part above it.
      const so = line.match(MS_SUB_ONLY);
      if (so && root !== null) {
        open(root, part, so[1], so[2]);
        continue;
      }
    }

    if (current) current.lines.push(line);
  }
  flush();
  return rows;
}


function trailingMarks(text) {
  const m = text.match(/(?:^|\s)(\d{1,2})\s*$/);
  return m ? Number(m[1]) : null;
}

function leadingMarks(text) {
  const m = text?.match(/\b(\d{1,2})\s*marks?\b/i);
  return m ? Number(m[1]) : null;
}

/* ----------------------------------------------------------- LLM fallback -- */

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string", description: "e.g. 4(b)(ii)" },
          text: { type: "string", description: "The question text, verbatim." },
          marks: { type: "number" },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["parts"],
};

const PARSE_SYSTEM = `
You segment IGCSE exam papers into individual question parts.

Rules:
- Copy the question text VERBATIM. Never summarise, correct, or complete it.
- One entry per markable part. If 4(a) has parts (i) and (ii), emit 4(a)(i) and
  4(a)(ii), not 4(a).
- marks is the number in square brackets at the end of the part.
- Include the parent stem in a part's text when the part cannot be understood
  without it (e.g. repeat "Fig 2.1 shows a circuit." at the top of 2(a)).
- Skip cover pages, blank pages, formula sheets and answer lines.
- If a part has no mark allocation, omit it entirely.
`.trim();

/**
 * Re-parse pages with the model. Used when the deterministic parser produced
 * nothing usable — typically OCR'd scans, or maths papers whose layout is
 * two-column.
 */
export async function llmParseQuestions(pages, hint = "") {
  if (!LLM_PARSE) return [];
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 60000);
  if (text.replace(/\s/g, "").length < 200) return [];

  const { parts } = await generateJSON(
    `${hint ? `PAPER: ${hint}\n\n` : ""}PAGES:\n${text}`,
    PARSE_SCHEMA,
    { system: PARSE_SYSTEM, maxOutputTokens: 8192 },
  );
  return (parts ?? [])
    .filter((p) => p.text && p.marks > 0)
    .map((p) => ({
      questionNo: p.questionNo,
      questionRoot: String(p.questionNo).match(/^\d+/)?.[0] ?? "",
      text: p.text,
      marks: p.marks,
      page: null,
    }));
}

const MS_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string", description: "Marking points, verbatim, one per line." },
          marks: { type: "number" },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["rows"],
};

const MS_SYSTEM = `
You transcribe IGCSE mark scheme tables into rows.

Rules:
- Copy marking points VERBATIM, including "accept", "reject", "or equivalent",
  "ora", "owtte" and any alternatives separated by "/".
- Keep the guidance column — it is where the accept/reject rules live.
- One row per question part, matching the question numbering of the paper.
- marks is the mark allocation for that part.
- Never paraphrase. A paraphrased mark scheme cannot be marked against.
`.trim();

export async function llmParseMarkScheme(pages, hint = "") {
  if (!LLM_PARSE) return [];
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 60000);
  if (text.replace(/\s/g, "").length < 200) return [];

  const { rows } = await generateJSON(
    `${hint ? `MARK SCHEME: ${hint}\n\n` : ""}PAGES:\n${text}`,
    MS_SCHEMA,
    { system: MS_SYSTEM, maxOutputTokens: 8192 },
  );
  return (rows ?? []).map((r) => ({
    questionNo: r.questionNo,
    questionRoot: String(r.questionNo).match(/^\d+/)?.[0] ?? "",
    text: r.text,
    marks: r.marks ?? null,
  }));
}

/* --------------------------------------------------------------- quality -- */

/**
 * Did the deterministic pass actually work? A real paper has several parts,
 * most of them carrying marks. Anything less means the layout defeated the
 * regexes and the LLM pass should take over.
 */
export function looksParsed(parts) {
  if (parts.length < 3) return false;
  // Heavy duplication means the parser lost its place; the text it did keep is
  // attributed to the wrong questions, so the model should re-read the paper.
  if ((parts.duplicatesDropped ?? 0) > parts.length * 0.2) return false;
  const withMarks = parts.filter((p) => p.marks > 0).length;
  return withMarks / parts.length >= 0.5;
}
